"""041: cruce real de correcciones y notas de entrega; concurrencia en PG sin red."""
import concurrent.futures
import json
import subprocess
import sys
import uuid

container = sys.argv[1]
assert container.startswith('ctacte-audit-db-')
checks = []
def sql(query, ok=True):
    p = subprocess.run(['docker','exec',container,'psql','-U','postgres','-Atq','-v','ON_ERROR_STOP=1','-c',
                        "SET statement_timeout='5s';"+query],text=True,capture_output=True,timeout=8)
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
def start(d,op=None,kind='productos',ok=True):
    op=op or identity()
    petition={'motivo':'prueba cruce','numero_factura':100,'origen':{'cliente':d['client'],'empresa':d['company']}}
    components=[{'tipo':'NC','datos':{'cod_cliente':d['client'],'cod_empresa':d['company'],'total':100}}]
    original=[{'cod_articulo':11,'cantidad':10,'precio':100}]
    return sql(f"select iniciar_operacion_factura({lit(d['tenant'])},{lit(op)},{lit(d['invoice'])},0,{lit(kind)},{js(petition)},{js(components)},{js(original)},{js(original)},{lit(actor)})",ok)
def link(d,note=None,ok=True):
    version=int(sql(f"select version from hojas_ruta where id={lit(d['hoja'])}"))
    note=note or str(uuid.uuid4().int % 10**14 + 1)
    data={'hoja_id':d['hoja'],'version_esperada':version,'ajuste':{'im_comprobante_id':d['delivery'],'cod_cliente':d['client'],
          'cod_empresa':d['company'],'tipo':'nc','importe':800,'items':[],'im_ajuste_id':note,'motivo':'devolución','emitido_at':'2026-09-11T12:00:00Z'}}
    return sql(f"select mutar_reparto({lit(d['tenant'])},{lit(actor)},'ajuste_vincular',{js(data)})",ok)

d=seed();link(d)
check('NC entrega externa bloquea nueva corrección de productos',start(d,ok=False).returncode!=0)
check('NC entrega no impide nota financiera independiente',json.loads(start(d,kind='financiera'))['estado']=='listo')

d=seed();o=json.loads(start(d))
check('corrección pendiente bloquea vínculo externo',link(d,ok=False).returncode!=0)
token=identity()
sql(f"select tomar_paso_factura({lit(d['tenant'])},{lit(o['id'])},0,{lit(token)})")
check('corrección en emisión bloquea vínculo externo',link(d,ok=False).returncode!=0)
sql(f"select terminar_paso_factura({lit(d['tenant'])},{lit(o['id'])},{lit(token)},null,'timeout',true)")
check('corrección incierta conserva exclusión',link(d,ok=False).returncode!=0)

d=seed();o=json.loads(start(d));token=identity();note=str(uuid.uuid4().int % 10**14 + 1)
sql(f"select tomar_paso_factura({lit(d['tenant'])},{lit(o['id'])},0,{lit(token)})")
sql(f"select terminar_paso_factura({lit(d['tenant'])},{lit(o['id'])},{lit(token)},{js({'id':note,'numero':999,'tipo':'NC B'})},null,false)")
wrong=seed(tenant=d['tenant'])
check('NC confirmada de facturaA no puede vincularse a entregaB mismo cliente',link(wrong,note,False).returncode!=0)
link(d,note)
check('NC del journal vinculada no se interpreta como crédito externo',sql(f"select ajuste_entrega_sin_conciliar({lit(d['tenant'])},{lit(d['invoice'])},101,1)")=='f')

for kind in ['productos','financiera']:
    d=seed();other=seed(tenant=d['tenant']);o=json.loads(start(d,kind=kind));token=identity()
    sql(f"select tomar_paso_factura({lit(d['tenant'])},{lit(o['id'])},0,{lit(token)})")
    check('NC pendiente '+kind+' impide vínculo anticipado a otra FA del mismo cliente',link(other,ok=False).returncode!=0)
    unrelated=seed(client=202,tenant=d['tenant'])
    check('NC pendiente '+kind+' no impide vínculo de otro cliente',link(unrelated,ok=False).returncode==0)

d=seed();other=seed(tenant=d['tenant']);note=str(uuid.uuid4().int % 10**14 + 1);link(other,note)
o=json.loads(start(d));token=identity()
sql(f"select tomar_paso_factura({lit(d['tenant'])},{lit(o['id'])},0,{lit(token)})")
response=sql(f"select terminar_paso_factura({lit(d['tenant'])},{lit(o['id'])},{lit(token)},{js({'id':note,'numero':999,'tipo':'NC B'})},null,false)",False)
check('checkpoint rechaza nota previamente ligada a otra factura',response.returncode!=0)
state=json.loads(sql(f"select to_jsonb(o) from facturas_operaciones o where tenant_id={lit(d['tenant'])} and id={lit(o['id'])}"))
check('checkpoint en conflicto no avanza ni permite reemitir',state['estado']=='emitiendo' and state['indice']==0 and state['token']==token)
check('checkpoint en conflicto no publica segunda deducción',sql(f"select count(*) from facturas_correcciones where tenant_id={lit(d['tenant'])}")=='0')

missing=seed(known=False)
check('nuevo vínculo sin factura unívoca requiere conciliación',link(missing,ok=False).returncode!=0)
# Simula dato histórico previo a041 sin desactivar definitivamente ninguna protección.
sql("BEGIN; ALTER TABLE hojas_ruta_ajustes DISABLE TRIGGER integridad_vinculo_correccion;"+
    f"INSERT INTO hojas_ruta_ajustes(tenant_id,hoja_id,im_comprobante_id,cod_cliente,cod_empresa,tipo,importe,items,motivo,im_ajuste_id,emitido_at) VALUES({lit(missing['tenant'])},{lit(missing['hoja'])},{lit(missing['delivery'])},101,null,'nc',800,'[]','legacy','NC-LEGACY-'+gen_random_uuid()::text,now());".replace("'NC-LEGACY-'+", "'NC-LEGACY-'||")+
    'ALTER TABLE hojas_ruta_ajustes ENABLE TRIGGER integridad_vinculo_correccion; COMMIT;')
same=seed(tenant=missing['tenant'])
check('legacy sin factura bloquea productos de mismo cliente sin inventar asociación',start(same,ok=False).returncode!=0)
other=seed(client=202,tenant=missing['tenant'])
check('legacy de otro cliente no bloquea su corrección',json.loads(start(other))['estado']=='listo')
other_tenant=seed()
check('legacy de otro tenant no bloquea su corrección',json.loads(start(other_tenant))['estado']=='listo')

for i in range(8):
    d=seed()
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        a=pool.submit(start,d,None,'productos',False)
        b=pool.submit(link,d,None,False)
        responses=[a.result(),b.result()]
    check('iniciar vs vincular concurrentes: exactamente un ganador '+str(i+1),sum(r.returncode==0 for r in responses)==1)

for role in ['anon','authenticated']:
    response=sql(f"SET ROLE {role}; SELECT ajuste_entrega_sin_conciliar({lit(identity())},'FA',101,1)",False)
    check('consulta de conciliación no accesible por '+role,response.returncode!=0 and 'permission denied' in response.stderr)
print(json.dumps({'scope':'041 PostgreSQL17 real, datos ficticios y cero red','passed':len(checks),'checks':checks},ensure_ascii=False,indent=2))
