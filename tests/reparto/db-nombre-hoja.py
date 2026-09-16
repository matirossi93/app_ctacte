"""044: el rótulo de la hoja. Se guarda por el mismo camino que el resto y con las mismas guardas."""
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
    return p
def lit(v): return "'"+str(v).replace("'","''")+"'"
def js(v): return lit(json.dumps(v))+'::jsonb'
def check(name,condition):
    assert condition,name
    checks.append(name)
def falla_con(respuesta,texto,nombre):
    check(nombre, respuesta.returncode != 0 and texto in respuesta.stderr)
def identity(): return str(uuid.uuid4())

actor=identity()
sql(f'insert into usuarios(id) values({lit(actor)})')
def hoja(tenant=None):
    tenant=tenant or identity()
    h=json.loads(sql(f"select mutar_reparto({lit(tenant)},{lit(actor)},'hoja_crear','{{\"fecha\":\"2026-09-14\"}}')"))
    return {'tenant':tenant,'id':h['id']}
def editar(d,cambios,ok=True):
    v=int(sql(f"select version from hojas_ruta where id={lit(d['id'])}"))
    return sql(f"select mutar_reparto({lit(d['tenant'])},{lit(actor)},'hoja_editar',{js({'hoja_id':d['id'],'version_esperada':v,'cambios':cambios})})",ok)
def leer(d,col='nombre'): return sql(f"select coalesce({col},'∅') from hojas_ruta where id={lit(d['id'])}")

# ── Se guarda, y se puede sacar ────────────────────────────────────────────────
d=hoja()
check('la hoja nace sin nombre',leer(d)=='∅')
editar(d,{'nombre':'Lules y Famaillá'})
check('el rótulo se guarda',leer(d)=='Lules y Famaillá')
editar(d,{'nombre':None})
check('y se puede dejar sin nombre otra vez',leer(d)=='∅')

# 🔑 Lo que se editaba antes tiene que seguir andando: la 044 reemplaza `mutar_reparto` entera.
editar(d,{'nombre':'Banda','turno':'Tarde','transporte':'Flete Pérez','observaciones':'sale 7am'})
check('y no pisa los campos que ya se editaban',
      sql(f"select nombre||'|'||turno||'|'||transporte||'|'||observaciones from hojas_ruta where id={lit(d['id'])}")=='Banda|Tarde|Flete Pérez|sale 7am')
editar(d,{'turno':'Mañana'})
check('cambiar otro campo no borra el rótulo',leer(d)=='Banda')

# ── Las mismas guardas que el resto de la hoja ─────────────────────────────────
v=int(sql(f"select version from hojas_ruta where id={lit(d['id'])}"))
falla_con(sql(f"select mutar_reparto({lit(d['tenant'])},{lit(actor)},'hoja_editar',{js({'hoja_id':d['id'],'version_esperada':v+99,'cambios':{'nombre':'Otra'}})})",False),
          'La hoja cambió','con la versión vieja no se renombra')
check('y el rótulo quedó como estaba',leer(d)=='Banda')

editar(d,{'estado':'cerrada'})
falla_con(editar(d,{'nombre':'Ya liquidada'},False),'Reabrí la hoja','una hoja cerrada no se renombra')
check('el rótulo de la hoja cerrada no cambió',leer(d)=='Banda')

# ── El tope de largo ──────────────────────────────────────────────────────────
# 🔴 Esto sale impreso en la cabecera del papel que va al camión: un párrafo entero la rompe.
otra=hoja()
editar(otra,{'nombre':'x'*60})
check('60 caracteres entran',len(leer(otra))==60)
falla_con(editar(otra,{'nombre':'x'*61},False),'hojas_ruta_nombre_check','61 no: lo frena la base, no sólo la app')
check('y el rótulo anterior sobrevive al rechazo',len(leer(otra))==60)

# ── Capacidad ──────────────────────────────────────────────────────────────────
estado=json.loads(sql('select reparto_estado_esquema()'))
check('la capacidad del rótulo queda acreditada',estado.get('nombre_listo') is True and estado.get('version_nombre')==44)
check('y lo de 41/42/43 no se mueve',
      estado.get('version')==41 and estado.get('version_cierre')==42
      and estado.get('version_vinculo')==43 and estado.get('vinculo_listo') is True and estado.get('listo') is True)

print(json.dumps({'scope':'044 PostgreSQL real, datos ficticios y cero red','passed':len(checks),'checks':checks},ensure_ascii=False,indent=2))
