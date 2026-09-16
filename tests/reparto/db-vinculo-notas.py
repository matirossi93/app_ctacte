"""043: vincular notas existentes (NC y ND). Guardas, factura bajo lock y concurrencia real."""
import concurrent.futures
import json
import subprocess
import sys
import time
import uuid

container = sys.argv[1]
assert container.startswith('ctacte-audit-db-')
checks = []
def sql(query, ok=True, timeout=8, statement='5s'):
    p = subprocess.run(['docker','exec',container,'psql','-U','postgres','-Atq','-v','ON_ERROR_STOP=1','-c',
                        f"SET statement_timeout='{statement}';"+query],text=True,capture_output=True,timeout=timeout)
    if ok:
        assert p.returncode == 0, p.stderr
        return p.stdout.strip()
    assert 'deadlock detected' not in p.stderr and 'statement timeout' not in p.stderr, p.stderr
    return p
def lit(v): return "'"+str(v).replace("'","''")+"'"
def js(v): return lit(json.dumps(v))+'::jsonb'
def check(name,condition):
    assert condition,name
    checks.append(name)
def falla_con(respuesta,texto,nombre):
    """🔴 Un negativo que sólo mira returncode pasa con CUALQUIER error: hasta con un typo."""
    check(nombre, respuesta.returncode != 0 and texto in respuesta.stderr)
def identity(): return str(uuid.uuid4())
actor=identity()
sql(f'insert into usuarios(id) values({lit(actor)})')

def seed(client=101,company=1,known=True,tenant=None):
    tenant=tenant or identity()
    delivery=str(uuid.uuid4().int % 10**12 + 1)
    invoice=str(uuid.uuid4().int % 10**12 + 10**12)
    hoja=json.loads(sql(f"select mutar_reparto({lit(tenant)},{lit(actor)},'hoja_crear', '{{\"fecha\":\"2026-09-11\"}}')"))['id']
    row={'im_comprobante_id':delivery,'cod_cliente':client,'cod_empresa':company,'tipo_comprobante':'RE',
         'fecha':'2026-09-11','total':1000,'kg':300,'bultos':10,'peso_completo':True}
    if known: row['im_factura_id']=invoice
    sql(f"select mutar_reparto({lit(tenant)},{lit(actor)},'asignar',{js({'hoja_id':hoja,'version_esperada':1,'pedidos':[row]})})")
    return {'tenant':tenant,'hoja':hoja,'delivery':delivery,'invoice':invoice,'client':client,'company':company}

def vincular(d,factura=None,note=None,kind='nc',ok=True,version=None):
    note=note or str(uuid.uuid4().int % 10**14 + 1)
    if version is None: version=int(sql(f"select version from hojas_ruta where id={lit(d['hoja'])}"))
    ajuste={'im_comprobante_id':d['delivery'],'cod_cliente':d['client'],'cod_empresa':d['company'],
            'tipo':kind,'importe':800,'motivo':'devolución','im_ajuste_id':note,'im_ajuste_numero':30079,
            'im_ajuste_tipo':kind.upper()+' B'}
    factura = d['invoice'] if factura is None else factura
    return sql(f"select vincular_nota_existente({lit(d['tenant'])},{lit(actor)},{lit(d['hoja'])},{version},{js(ajuste)},"
               + ('null' if factura is False else lit(factura))+")",ok)

def operacion(d,kind='productos',estado='listo',tipos=('NC',)):
    op=identity()
    sql(f"insert into facturas_estado_correccion(tenant_id,im_factura_id,originales,renglones) values({lit(d['tenant'])},{lit(d['invoice'])},'[]','[]') on conflict do nothing")
    componentes=[{'tipo':t,'datos':{'cod_cliente':d['client'],'cod_empresa':d['company'],'total':100}} for t in tipos]
    sql(f"insert into facturas_operaciones(tenant_id,id,im_factura_id,clase,estado,peticion,componentes,finales) "
        f"values({lit(d['tenant'])},{lit(op)},{lit(d['invoice'])},{lit(kind)},{lit(estado)},"
        f"{js({'origen':{'cliente':d['client'],'empresa':d['company']}})},{js(componentes)},'[]')")
    return op

# ── Las guardas alcanzan a las dos clases de nota ──────────────────────────────
d=seed()
check('una ND se vincula: antes entraba salteando TODAS las guardas',json.loads(vincular(d,kind='nd'))['ok'])

for kind in ['nc','nd']:
    d=seed();operacion(d)
    falla_con(vincular(d,kind=kind,ok=False),'corrección pendiente de esta factura',
              'corrección de productos pendiente bloquea el vínculo de '+kind.upper())

# 🔴 EL HUECO DE LA 041: una emisión FINANCIERA incierta de ESA factura no era 'productos' ni de
# "otra factura", así que no caía en ningún filtro.
for kind in ['nc','nd']:
    d=seed();operacion(d,kind='financiera',estado='incierto')
    falla_con(vincular(d,kind=kind,ok=False),'corrección pendiente de esta factura',
              'emisión financiera incierta de ESTA factura bloquea el vínculo de '+kind.upper())

for estado in ['completo','cancelado']:
    d=seed();operacion(d,kind='financiera',estado=estado)
    check('una operación '+estado+' no bloquea para siempre',json.loads(vincular(d))['ok'])

d=seed();operacion(d,kind='financiera',estado='incierto',tipos=('FA',))
check('una financiera pendiente que no emite notas no bloquea',json.loads(vincular(d))['ok'])

# ── La factura de destino: la que el operador vio ──────────────────────────────
d=seed()
falla_con(vincular(d,factura='99999999',ok=False),'cambió desde que abriste','otra factura que la vista rechaza el vínculo')
falla_con(vincular(d,factura=False,ok=False),'Falta la factura','sin la factura vista no se vincula')
falla_con(vincular(d,version=99,ok=False),'La hoja cambió','la versión vieja de la hoja rechaza el vínculo')
previa=int(sql(f"select version from hojas_ruta where id={lit(d['hoja'])}"))
check('con la factura vista, entra',json.loads(vincular(d))['ok'])
check('y la hoja cambia de versión',int(sql(f"select version from hojas_ruta where id={lit(d['hoja'])}"))==previa+1)

d=seed(known=False)
falla_con(vincular(d,factura='99999999',ok=False),'no tiene una factura unívoca','sin factura unívoca no se vincula')

d=seed()
nota=str(uuid.uuid4().int % 10**14 + 1)
vincular(d,note=nota)
falla_con(vincular(seed(tenant=d['tenant']),note=nota,ok=False),'hojas_ruta_ajustes_im_uidx',
          'la misma nota no entra dos veces: la frena el índice único, no un error cualquiera')

# ── Concurrencia real: el apareo de facturación NO toma el lock de reparto ─────
# 🔴 `presupuestos_facturados` se escribe con UPDATE directos que nunca piden `reparto_control`.
# Sin bloquear esas filas, la RPC leería la factura vieja de su snapshot y ataría la nota a un
# comprobante que ya no es el de la entrega.
def aparear_lento(d,nueva,marca):
    """Abre transacción, cambia la factura de la entrega y la sostiene sin confirmar."""
    return sql(f"begin; update presupuestos_facturados set im_factura_id={lit(nueva)} "
               f"where tenant_id={lit(d['tenant'])} and im_comprobante_id={lit(d['delivery'])}; "
               f"select pg_sleep(3) /* {marca} */; commit;",timeout=15,statement='20s')

def esperar_lock(marca):
    """🔴 Un `sleep` fijo no acredita nada: si el UPDATE todavía no corrió, la prueba pasa sola.

    Se espera a que ESA transacción esté dormida DESPUÉS del UPDATE —o sea, con el lock de fila
    ya tomado— antes de lanzar el vínculo."""
    for _ in range(100):
        activa=sql("select count(*) from pg_stat_activity where state='active' and query like "
                   +lit('%'+marca+'%')+" and query not like '%pg_stat_activity%'")
        tomado=sql("select count(*) from pg_locks l join pg_class c on c.oid=l.relation "
                   "where c.relname='presupuestos_facturados' and l.mode='RowExclusiveLock' and l.granted")
        if activa!='0' and tomado!='0': return True
        time.sleep(.05)
    return False

for i in range(3):
    d=seed(known=False)
    sql(f"insert into presupuestos_facturados(tenant_id,im_comprobante_id,cod_cliente,cod_empresa,im_factura_id,facturado_at) "
        f"values({lit(d['tenant'])},{lit(d['delivery'])},{d['client']},{d['company']},{lit(d['invoice'])},now())")
    otra=str(uuid.uuid4().int % 10**12 + 2*10**12)
    marca='apareo-'+uuid.uuid4().hex[:8]
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        a=pool.submit(aparear_lento,d,otra,marca)
        check('el apareo concurrente ya tiene el lock antes de vincular '+str(i+1),esperar_lock(marca))
        b=pool.submit(vincular,d,None,None,'nc',False,None)
        a.result(); respuesta=b.result()
    falla_con(respuesta,'cambió','el apareo concurrente frena el vínculo a la factura vieja '+str(i+1))
    check('y no quedó ninguna nota atada a la factura vieja '+str(i+1),
          sql(f"select count(*) from hojas_ruta_ajustes where tenant_id={lit(d['tenant'])}")=='0')

# 🔑 El caso del handler real: la entrega trae su factura en `hojas_ruta_pedidos` (FA1) y el
# apareo mete OTRA en `presupuestos_facturados` (FA2) sin tocar `hojas_ruta.version`. El snapshot
# de la hoja sigue diciendo FA1 y la versión no cambió, así que nada de lo que mira el handler se
# entera: la identidad tiene que resolverse contra `facturas_de_entrega`.
for i in range(2):
    d=seed()
    otra=str(uuid.uuid4().int % 10**12 + 3*10**12)
    marca='apareo-hp-'+uuid.uuid4().hex[:8]
    version=int(sql(f"select version from hojas_ruta where id={lit(d['hoja'])}"))
    sql(f"insert into presupuestos_facturados(tenant_id,im_comprobante_id,cod_cliente,cod_empresa,im_factura_id,facturado_at) "
        f"values({lit(d['tenant'])},{lit(d['delivery'])},{d['client']},{d['company']},{lit(d['invoice'])},now())")
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        a=pool.submit(aparear_lento,d,otra,marca)
        check('apareo con la hoja intacta ya tiene el lock '+str(i+1),esperar_lock(marca))
        b=pool.submit(vincular,d,None,None,'nc',False,version)
        a.result(); respuesta=b.result()
    check('la hoja no cambió de versión, así que el handler no se habría enterado '+str(i+1),
          int(sql(f"select version from hojas_ruta where id={lit(d['hoja'])}"))==version)
    falla_con(respuesta,'unívoca','dos facturas para la misma entrega frenan el vínculo '+str(i+1))
    check('y tampoco quedó nota '+str(i+1),
          sql(f"select count(*) from hojas_ruta_ajustes where tenant_id={lit(d['tenant'])}")=='0')

# ── Permisos ───────────────────────────────────────────────────────────────────
for role in ['anon','authenticated']:
    r=sql(f"SET ROLE {role}; SELECT vincular_nota_existente({lit(identity())},{lit(actor)},{lit(identity())},1,'{{}}'::jsonb,'1')",False)
    check('vincular no accesible por '+role,r.returncode!=0 and 'permission denied' in r.stderr)
    r=sql(f"SET ROLE {role}; SELECT controlar_vinculo_nota({lit(identity())},'1',1,1,'nc','1')",False)
    check('la guarda no accesible por '+role,r.returncode!=0 and 'permission denied' in r.stderr)

estado=json.loads(sql('select reparto_estado_esquema()'))
check('la capacidad de vínculo queda acreditada',estado.get('vinculo_listo') is True and estado.get('version_vinculo')==43)
check('y la preparación 41/42 de la app publicada no se mueve',estado.get('version')==41 and estado.get('version_cierre')==42)

print(json.dumps({'scope':'043 PostgreSQL real, datos ficticios y cero red','passed':len(checks),'checks':checks},ensure_ascii=False,indent=2))
