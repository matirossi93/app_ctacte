"""Pruebas adversariales de reparto en PostgreSQL efímero sin red ni datos reales."""
import concurrent.futures
import atexit
import json
import subprocess
import sys
import uuid

CONTAINER = sys.argv[1] if len(sys.argv) > 1 else 'ctacte-audit-db-20260911'
assert CONTAINER.startswith('ctacte-audit-db-')
T, U, T2 = [str(uuid.uuid4()) for _ in range(3)]
checks = []
atexit.register(lambda: print(json.dumps({'scope':'PostgreSQL 17 efímero, datos ficticios','passed':len(checks),'checks':checks},ensure_ascii=False,indent=2)))
serial = int(uuid.uuid4().hex[:11], 16)

def sql(q, ok=True):
    p = subprocess.run(['docker','exec','-i',CONTAINER,'psql','-U','postgres','-At','-v','ON_ERROR_STOP=1','-c',q],text=True,capture_output=True)
    if ok and p.returncode:
        raise AssertionError(p.stderr)
    return p.stdout.strip() if ok else p

def lit(v): return "'" + str(v).replace("'", "''") + "'"
def js(v): return lit(json.dumps(v)) + '::jsonb'
def check(name, yes):
    assert yes, name
    checks.append(name)

def rpc(action, data, ok=True, tenant=T):
    result = sql(f'select mutar_reparto({lit(tenant)},{lit(U)},{lit(action)},{js(data)})', ok)
    return json.loads(result) if ok else result

def new_sheet(tenant=T):
    return rpc('hoja_crear', {'fecha':'2026-09-11'}, tenant=tenant)['id']

def version(h): return int(sql(f'select version from hojas_ruta where id={lit(h)}'))
def delivery():
    global serial
    serial += 1
    return {'im_comprobante_id':str(serial),'im_factura_id':str(serial+1000000000000),'im_numero':100,'cod_cliente':101,'cliente_nombre':'Cliente prueba','fecha':'2026-09-11','cod_empresa':1,'tipo_comprobante':'RE','total':1000,'bultos':10,'kg':300,'peso_completo':True,'renglones_sin_peso':0,'datos_consultados_at':'2026-09-11T01:00:00Z'}

def assign(h, rows, ok=True, **extra):
    return rpc('asignar', {'hoja_id':h,'version_esperada':version(h),'pedidos':rows,**extra},ok)

def parallel(calls):
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        return list(pool.map(lambda fn: fn(), calls))

def rows(h): return int(sql(f'select count(*) from hojas_ruta_pedidos where hoja_id={lit(h)}'))
def total_rows(d): return int(sql(f"select count(*) from hojas_ruta_pedidos where im_comprobante_id={lit(d['im_comprobante_id'])}"))
def close(h, v=None, ok=True): return rpc('hoja_editar', {'hoja_id':h,'version_esperada':v or version(h),'cambios':{'estado':'cerrada'}},ok)

def adjustment(h, d, quantities=(6,), ok=True):
    return rpc('ajuste_reclamar', {'hoja_id':h,'version_esperada':version(h),'ajuste':{'im_comprobante_id':d['im_comprobante_id'],'cod_empresa':1,'cod_cliente':101,'tipo':'nc','motivo':'Ensayo','importe':sum(quantities)*100,'items':[{'cod_articulo':11,'cantidad':q,'precio':100} for q in quantities],'claim_token':str(uuid.uuid4())},'limites':[{'cod_articulo':11,'cantidad':10}]},ok)

def result_adjustment(r): return r['filas']
def finish(a, state='completo', ok=True, **extra):
    return rpc('ajuste_finalizar', {'id':a['id'],'claim_token':a['claim_token'],'estado_operacion':state,'im_ajuste_id':str(uuid.uuid4()),'im_ajuste_numero':200,'im_ajuste_tipo':'NC B',**extra},ok)

sql(f'insert into usuarios(id) values({lit(U)})')
h1,h2=new_sheet(),new_sheet()
check('numeración inicial conserva el piso real3405', sql(f'select numero from hojas_ruta where id={lit(h1)}') == '3405')
check('creación genera números únicos', sql(f'select numero from hojas_ruta where id={lit(h1)}') != sql(f'select numero from hojas_ruta where id={lit(h2)}'))
floor_tenant = str(uuid.uuid4())
created = parallel([lambda: rpc('hoja_crear', {'fecha':'2026-09-11','numero_minimo':4500}, tenant=floor_tenant) for _ in range(8)])
numbers = sorted(int(sql(f"select numero from hojas_ruta where id={lit(x['id'])}")) for x in created)
check('ocho creaciones simultáneas respetan piso configurado sin duplicados', numbers == list(range(4500,4508)))
d=delivery()
r=parallel([lambda h=h: assign(h,[d],False) for h in [h1,h2]+[new_sheet() for _ in range(6)]])
check('ocho asignaciones simultáneas: un destino, un ganador', sum(x.returncode==0 for x in r)==1 and total_rows(d)==1)
source=sql(f"select hoja_id from hojas_ruta_pedidos where im_comprobante_id={lit(d['im_comprobante_id'])}")
target=h2 if source==h1 else h1
old_version=version(source)
assign(target,[d],mover=True,origenes={d['im_comprobante_id']:{'hoja_id':source,'version':old_version}})
assign(source,[d],mover=True,origenes={d['im_comprobante_id']:{'hoja_id':target,'version':version(target)}})
r=assign(target,[d],False,mover=True,origenes={d['im_comprobante_id']:{'hoja_id':source,'version':old_version}})
check('mover de ida y vuelta no habilita origen con versión antigua',r.returncode!=0 and total_rows(d)==1)
source_version=version(source)
rpc('quitar',{'hoja_id':source,'version_esperada':source_version,'im_comprobante_id':d['im_comprobante_id']})
r=assign(target,[d],False,mover=True,origenes={d['im_comprobante_id']:{'hoja_id':source,'version':source_version}})
check('movimiento cuyo origen se eliminó no resucita la entrega',r.returncode!=0 and total_rows(d)==0)

h3=new_sheet(); d2=delivery()
r=parallel([lambda: assign(h3,[d2],False),lambda:rpc('retiro_marcar',{'pedidos':[d2]},False)])
check('retirar vs asignar: una sola operación gana',sum(x.returncode==0 for x in r)==1)
check('entrega jamás figura en hoja y retiro',total_rows(d2)+int(sql(f"select count(*) from retiros_sucursal where tenant_id={lit(T)} and im_comprobante_id={lit(d2['im_comprobante_id'])}"))==1)

h4=new_sheet(); d3=delivery(); v4=version(h4)
r=parallel([lambda:rpc('asignar',{'hoja_id':h4,'version_esperada':v4,'pedidos':[d3]},False),lambda:close(h4,v4,False)])
check('cerrar vs asignar con misma versión: una sola transición gana',sum(x.returncode==0 for x in r)==1)

h5=new_sheet(); dd=delivery(); bad={**delivery(),'cod_empresa':None}; v5=version(h5)
r=assign(h5,[dd,bad],False,saldos=[{'cod_empresa':1,'cod_cliente':101,'pendientes':[],'consultado_at':'2026-09-11T03:00:00Z'}])
check('última fila inválida revierte lote completo',r.returncode!=0 and rows(h5)==0 and version(h5)==v5)
check('rollback tampoco guarda saldo',sql(f'select count(*) from hojas_ruta_saldos where hoja_id={lit(h5)}')=='0')

h6=new_sheet(); pr,re=delivery(),delivery(); pr['tipo_comprobante']='PR'
sql(f"insert into presupuestos_facturados(tenant_id,im_comprobante_id,cod_cliente,cod_empresa,im_factura_id,im_remito_id,estado_emision) values({lit(T)},{lit(pr['im_comprobante_id'])},101,1,'FA-ALIAS',{lit(re['im_comprobante_id'])},'completo')")
r=assign(h6,[pr,re],False)
check('lote con PR y su RE se rechaza sin entregas dobles',r.returncode!=0 and rows(h6)==0)
assign(h6,[pr])
r=assign(new_sheet(),[re],False)
check('remito gemelo no roba presupuesto previamente asignado',r.returncode!=0)

pr1,pr2,re2=delivery(),delivery(),delivery()
pr1['tipo_comprobante']=pr2['tipo_comprobante']='PR'
ambiguous_sheet=new_sheet(); assign(ambiguous_sheet,[pr2])
for p in [pr1,pr2]:
    sql(f"insert into presupuestos_facturados(tenant_id,im_comprobante_id,cod_cliente,cod_empresa,im_factura_id,im_remito_id,estado_emision) values({lit(T)},{lit(p['im_comprobante_id'])},101,1,'FA-AMBIGUA',{lit(re2['im_comprobante_id'])},'completo')")
check('dos presupuestos enlazados al mismo remito no duplican destino',assign(new_sheet(),[pr1],False).returncode!=0)

other=new_sheet(T2); foreign=delivery(); rpc('asignar',{'hoja_id':other,'version_esperada':1,'pedidos':[foreign]},tenant=T2)
r=rpc('quitar',{'hoja_id':other,'version_esperada':2,'im_comprobante_id':foreign['im_comprobante_id']},False)
check('tenant ajeno no puede quitar entrega',r.returncode!=0 and rows(other)==1)
r=assign(new_sheet(),[foreign],False,mover=True,origenes={foreign['im_comprobante_id']:{'hoja_id':other,'version':2}})
check('tenant ajeno no puede mover entrega por ID global',r.returncode!=0 and rows(other)==1)

ha=new_sheet(); da=delivery(); assign(ha,[da]); before=version(ha)
a=result_adjustment(adjustment(ha,da)); check('claim incrementa versión hoja',version(ha)>before)
check('claim pendiente bloquea cierre',close(ha,ok=False).returncode!=0)
check('claim pendiente bloquea anulación de hoja',rpc('hoja_editar',{'hoja_id':ha,'version_esperada':version(ha),'cambios':{'estado':'anulada'}},False).returncode!=0)
check('claim pendiente bloquea quitar',rpc('quitar',{'hoja_id':ha,'version_esperada':version(ha),'im_comprobante_id':da['im_comprobante_id']},False).returncode!=0)
check('claim pendiente bloquea borrado hoja',rpc('hoja_borrar',{'hoja_id':ha,'version_esperada':version(ha)},False).returncode!=0)
check('claim pendiente no se borra para reemitir',rpc('ajuste_borrar',{'id':a['id']},False).returncode!=0)
check('token incorrecto no finaliza claim',finish(a,ok=False,claim_token=str(uuid.uuid4())).returncode!=0)
finish(a,'incierto'); sql(f"update hojas_ruta_ajustes set reclamado_at=now()-interval '1 day' where id={lit(a['id'])}")
check('claim incierto de un día no se borra',rpc('ajuste_borrar',{'id':a['id']},False).returncode!=0)
finish(a)
check('cantidad acumulada 6 más 6 sobre 10 no emite segunda nota',adjustment(ha,da,ok=False).returncode!=0)
check('checkpoint anterior permanece al rechazar siguiente cantidad',sql(f'select count(*) from hojas_ruta_ajustes where hoja_id={lit(ha)}')=='1')

hb=new_sheet(); db=delivery(); assign(hb,[db])
check('renglones repetidos 8 más 8 sobre 10 se consolidan y rechazan',adjustment(hb,db,(8,8),False).returncode!=0)
check('rechazo de cantidad no deja claim',sql(f'select count(*) from hojas_ruta_ajustes where hoja_id={lit(hb)}')=='0')
vb=version(hb)
r=parallel([lambda:adjustment(hb,db,ok=False),lambda:close(hb,vb,False)])
check('cerrar vs reclamar ajuste: una sola transición gana',sum(x.returncode==0 for x in r)==1)

hc=new_sheet(); dc=delivery(); assign(hc,[dc])
def link(h,d,note): return rpc('ajuste_vincular',{'hoja_id':h,'version_esperada':version(h),'ajuste':{'im_comprobante_id':d['im_comprobante_id'],'cod_empresa':1,'cod_cliente':101,'tipo':'nc','motivo':'Vinculada','importe':10,'items':[],'im_ajuste_id':note,'im_ajuste_numero':300,'im_ajuste_tipo':'NC B'}},False)
hd=new_sheet(); de=delivery(); assign(hd,[de]); note=str(uuid.uuid4())
r=parallel([lambda:link(hc,dc,note),lambda:link(hd,de,note)])
check('misma NC se vincula a una sola entrega',sum(x.returncode==0 for x in r)==1)
check('número de NC repetido con otro ID no bloquea distinto talonario',link(hc,dc,str(uuid.uuid4())).returncode==0)
check('NC vinculada sin detalle impide asumir cantidad acreditada cero',adjustment(hc,dc,ok=False).returncode!=0)
linked=json.loads(sql(f'select to_jsonb(a) from hojas_ruta_ajustes a where hoja_id={lit(hc)} limit 1'))
check('borrar ajuste exige versión aunque sólo envíe ID',rpc('ajuste_borrar',{'id':linked['id'],'version_esperada':1},False).returncode!=0)
check('borrar ajuste con versión vigente libera vínculo conocido',rpc('ajuste_borrar',{'id':linked['id'],'version_esperada':version(hc)},False).returncode==0)

hs=new_sheet()
def saldo(at, amount): return rpc('saldo_guardar',{'hoja_id':hs,'saldos':[{'cod_empresa':1,'cod_cliente':101,'pendientes':[{'id':'DEUDA','saldo':amount}],'consultado_at':at}]})
saldo('2026-09-11T04:00:00Z',20); saldo('2026-09-11T03:00:00Z',100)
check('saldo antiguo que termina tarde no pisa saldo nuevo',json.loads(sql(f'select pendientes from hojas_ruta_saldos where hoja_id={lit(hs)}'))[0]['saldo']==20)
for role in ['anon','authenticated']:
    r=sql(f'SET ROLE {role}; select mutar_reparto({lit(T)},{lit(U)},\'hoja_crear\',\'{{"fecha":"2026-09-11"}}\')',False)
    check(f'{role} no ejecuta mutaciones de reparto',r.returncode!=0 and 'permission denied' in r.stderr)
service=sql(f'SET ROLE service_role; select mutar_reparto({lit(T)},{lit(U)},\'hoja_crear\',\'{{"fecha":"2026-09-11"}}\')',False)
check('service_role sí puede ejecutar la mutación con RLS',service.returncode==0)
