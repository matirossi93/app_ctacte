import {beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({pendientes:vi.fn(),tablas:{} as Record<string,any>,rpc:vi.fn()}));
vi.mock('./infomanager.js',()=>({fechaArgentina:()=> '2026-09-11',fetchVentas:vi.fn(async()=>[{id:'20',tipo_comprobante:'FA',cod_cliente:7,cod_empresa:1,anulada:'N',total:80}]),fetchVentasItems:vi.fn(async()=>[{id_comprobante:'10',cod_articulo:3,cantidad:1}]),fetchArticulosCatalogo:vi.fn(async()=>new Map([[3,{descripcion:'Alpiste',unidad_de_medida:'Kilos',equivalencia_um:1}]])),fetchClientesIMCached:vi.fn(async()=>[]),comprobantesPendientesCliente:m.pendientes}));
vi.mock('./formatosBolsa.js',()=>({formatosDeBolsa:()=>new Map()}));
vi.mock('./supabase.js',()=>({TENANT_ID:'t',sb:()=>({rpc:m.rpc,from:(t:string)=>{const q:any={then:(r:any)=>Promise.resolve({data:m.tablas[t]??[],error:null}).then(r),maybeSingle:async()=>({data:m.tablas[t],error:null})};for(const k of ['range','order','select','eq','in','or','not','order'])q[k]=()=>q;return q;}})}));
import {impresionHoja} from './hojasRuta.js';
const pendientes=[{id:'20',saldo:80},{id:'30',saldo:-10},{id:'40',saldo:20}];
async function imprimir(){const res:any={statusCode:200,status(n:number){this.statusCode=n;return this},json(d:any){this.body=d;}};await impresionHoja({params:{id:'h'},user:{sub:'u',rol:'administrativo'}} as any,res);return res;}
beforeEach(()=>{vi.clearAllMocks();m.pendientes.mockResolvedValue(pendientes);m.rpc.mockResolvedValue({data:{ok:true},error:null});m.tablas={
 hojas_ruta:{id:'h',numero:3405,fecha:'2026-09-11',estado:'abierta',hojas_ruta_pedidos:[{im_comprobante_id:'10',im_numero:10,cod_cliente:7,cod_empresa:1,total:100,saldo_anterior:9999,fecha:'2026-09-11',kg:1,bultos:1}]},
 presupuestos_facturados:[{im_comprobante_id:'1',im_remito_id:'10',im_factura_id:'20',cod_cliente:7,cod_empresa:1,total:80,facturado_at:'2026-09-11'}],
 hojas_ruta_ajustes:[{hoja_id:'h',im_comprobante_id:'10',im_ajuste_id:'30',tipo:'nc',importe:10,im_ajuste_numero:30,emitido_at:'2026-09-11'}],
 hojas_ruta_saldos:[{cod_cliente:7,cod_empresa:1,pendientes,consultado_at:'2026-09-10T10:00:00Z'}]
};});
it('FA80 + NC10 sólo ajuste: cliente70, pie70 y saldo previo20',async()=>{const r=await imprimir();expect(r.statusCode).toBe(200);expect(r.body.clientes[0]).toMatchObject({total:70,saldo_anterior:20,saldo_fuente:'en_vivo'});expect(r.body.totales.total).toBe(70);expect(m.rpc.mock.calls[0][1].p_datos.saldos[0].pendientes).toEqual(pendientes);});
it('misma NC en ajuste y corrección no resta dos veces',async()=>{m.tablas.facturas_correcciones=[{im_factura_id:'20',im_comprobante_id:'30',tipo:'nc',total:10,numero:30}];const r=await imprimir();expect(r.body.clientes[0].total).toBe(70);expect(r.body.clientes[0].notas).toHaveLength(1);expect(r.body.totales.total).toBe(70);});
it('IM caído recalcula el respaldo crudo y nunca reutiliza el saldo numérico legado',async()=>{m.pendientes.mockRejectedValue(Error('sin red'));const r=await imprimir();expect(r.body.clientes[0]).toMatchObject({saldo_anterior:20,saldo_fuente:'respaldo',saldo_actualizado:false,saldo_consultado_at:'2026-09-10T10:00:00Z'});expect(r.body.sin_actualizar_saldo).toBe(1);});
it('sin empresa verificable no presume Casa Central ni transforma9999 en saldo vigente',async()=>{m.tablas.presupuestos_facturados=[];m.tablas.hojas_ruta.hojas_ruta_pedidos[0].cod_empresa=null;const r=await imprimir();expect(r.body.clientes[0].saldo_anterior).toBeNull();expect(m.pendientes).not.toHaveBeenCalled();});

it('HTTP200 con error conserva respaldo20 y no guarda snapshot vacío nuevo',async()=>{
 const {parsearPendientesCliente}=await import('./respuestaPendientesCliente.js');
 m.pendientes.mockImplementation(async()=>parsearPendientesCliente({error:99,mensaje:'sin datos'}));
 const r=await imprimir();expect(r.statusCode).toBe(200);expect(r.body.clientes[0]).toMatchObject({saldo_anterior:20,saldo_fuente:'respaldo',saldo_actualizado:false});expect(m.rpc).not.toHaveBeenCalled();
});
it('HTTP200 con error sin respaldo deja saldo desconocido, no cero en vivo',async()=>{
 const {parsearPendientesCliente}=await import('./respuestaPendientesCliente.js');
 m.tablas.hojas_ruta_saldos=[];m.pendientes.mockImplementation(async()=>parsearPendientesCliente({error:99}));
 const r=await imprimir();expect(r.body.clientes[0]).toMatchObject({saldo_anterior:null,saldo_fuente:'desconocido',saldo_actualizado:false});expect(m.rpc).not.toHaveBeenCalled();
});
