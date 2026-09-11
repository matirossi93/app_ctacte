"""Cierre atómico con importes vivos, bajo el mismo lock de reparto y control de versión."""
import sys, subprocess, json, uuid, concurrent.futures
container=sys.argv[1]
assert container.startswith('ctacte-audit-db-')
def sql(s,ok=True):
 r=subprocess.run(['docker','exec','-i',container,'psql','-U','postgres','-Atq','-v','ON_ERROR_STOP=1','-c',s],text=True,capture_output=True)
 if ok and r.returncode: raise AssertionError(r.stderr)
 return r.stdout.strip() if ok else r
T,U,H=[str(uuid.uuid4()) for _ in range(3)]
def val(x):return "'"+json.dumps(x).replace("'","''")+"'::jsonb"
def close(version,rows,ok=True):
 return sql("select cerrar_hoja_con_importes('%s','%s',%s)"%(T,U,val({'hoja_id':H,'version_esperada':version,'importes':rows,'cambios':{'estado':'cerrada'}})),ok)
sql("insert into usuarios values('%s'); insert into hojas_ruta(id,tenant_id,numero,fecha,estado) values('%s','%s',1,'2026-09-11','abierta');"%(U,H,T))
sql("insert into hojas_ruta_pedidos(hoja_id,im_comprobante_id,cod_cliente,cod_empresa,total,im_factura_id) values('%s','20',430,1,100,'30'),('%s','21',431,1,200,'31')"%(H,H))
row={'im_comprobante_id':'20','cod_cliente':430,'cod_empresa':1,'im_factura_id':'30','total':80}
row2={'im_comprobante_id':'21','cod_cliente':431,'cod_empresa':1,'im_factura_id':'31','total':180}
v=int(sql("select version from hojas_ruta where id='%s'"%H))
for bad in [[],[row,row],[dict(row,cod_cliente=2),row2],[dict(row,im_factura_id='31'),row2],[dict(row,total=-1),row2]]:
 assert close(v,bad,False).returncode!=0
assert sql("select estado from hojas_ruta where id='%s'"%H)=='abierta'
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
 results=list(pool.map(lambda _:close(v,[row,row2],False),[1,2]))
assert sum(r.returncode==0 for r in results)==1, [(r.returncode,r.stderr) for r in results]
h=json.loads(sql("select to_jsonb(h) from hojas_ruta h where id='%s'"%H))
assert h['estado']=='cerrada' and h['cierres_importes'][-1]['pedidos'][0]['total']==80
assert sorted(p['total'] for p in h['cierres_importes'][-1]['originales'])==[100,200]
assert float(sql("select total from hojas_ruta_pedidos where hoja_id='%s' and im_comprobante_id='20'"%H))==100
sql("select mutar_reparto('%s','%s','hoja_editar',%s)"%(T,U,val({'hoja_id':H,'version_esperada':h['version'],'cambios':{'estado':'abierta'}})))
close(h['version']+1,[dict(row,total=70),row2])
h=json.loads(sql("select to_jsonb(h) from hojas_ruta h where id='%s'"%H))
assert [c['pedidos'][0]['total'] for c in h['cierres_importes']]==[80,70]
print(json.dumps({'cierre_importes':'PASS','casos':['no parcial','identidad','version','dos cierres un ganador','original100 preservado','cierre80','reapertura y segundo cierre70 conservan historial']}))
