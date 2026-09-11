import json
import subprocess
import sys
c=sys.argv[1]
assert c.startswith('ctacte-audit-db-')
def sql(query):
 p=subprocess.run(['docker','exec',c,'psql','-U','postgres','-At','-v','ON_ERROR_STOP=1','-c',query],text=True,capture_output=True,check=True)
 return p.stdout.strip()
checks=[]
def check(name,condition):
 assert condition,name
 checks.append(name)
rows=json.loads(sql("select jsonb_object_agg(im_comprobante_id,to_jsonb(hp)) from hojas_ruta_pedidos hp where hoja_id='10000000-0000-0000-0000-000000000001'"))
for n in ['90000001','90000002']:
 check('empresa recuperada sólo con vínculo unívoco '+n,rows[n]['cod_empresa']==1 and rows[n]['empresa_fuente']=='vinculo_panel')
for n in ['90000003','90000004','90000005','90000006','90000007']:
 check('vínculo ausente/incompatible conserva empresa desconocida '+n,rows[n]['cod_empresa'] is None and rows[n]['empresa_fuente'] is None)
check('ninguna fecha de consulta se inventa durante backfill',all(r['datos_consultados_at'] is None for r in rows.values()))
check('peso anterior no se declara verificado',all(r['peso_completo'] is None for r in rows.values()))
check('importes históricos y saldos no se reescriben',all(r['total']==int(n[-1])*100 and r['saldo_anterior']==int(n[-1])*100+20 for n,r in rows.items()))
r=json.loads(sql("select jsonb_object_agg(im_comprobante_id,to_jsonb(rt)) from retiros_sucursal rt where tenant_id='20000000-0000-0000-0000-000000000001'"))
check('retiro con vínculo recupera empresa sin inventar fecha',r['91000008']['cod_empresa']==1 and r['91000008']['datos_consultados_at'] is None)
check('retiro desconocido sigue sin empresa',r['90000009']['cod_empresa'] is None)
print(json.dumps({'scope':'migración de legado ficticio y reaplicación','passed':len(checks),'checks':checks},ensure_ascii=False,indent=2))
