import { beforeEach, describe, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({ventas:vi.fn(),items:vi.fn(),catalogo:vi.fn(),clientes:vi.fn(),tablas:{} as Record<string,any>}));
vi.mock('./infomanager.js',()=>({fetchVentas:m.ventas,fetchVentasItems:m.items,fetchArticulosCatalogo:m.catalogo,fetchClientesIMCached:m.clientes}));
vi.mock('./supabase.js',()=>({TENANT_ID:'t',sb:()=>({from:(t:string)=>{const q:any={then:(r:any)=>Promise.resolve(m.tablas[t]??{data:[],error:null}).then(r)};for(const k of ['range','order','select','eq','or','in','not']) q[k]=()=>q;return q;}})}));
import { verificarEntregas, enriquecerEntregas, enriquecerHojas, notasDeHoja, netoNotas, leerPaginas } from './repartoDatos.js';
const venta=(id:number,tipo:string,extra={})=>({id,tipo_comprobante:tipo,cod_empresa:1,cod_cliente:7,fecha:'2026-09-11',numero:id,total:80,anulada:'N',...extra});
beforeEach(()=>{vi.clearAllMocks();m.tablas={};m.items.mockResolvedValue([{id_comprobante:10,cod_articulo:3,cantidad:2}]);m.catalogo.mockResolvedValue(new Map([[3,{equivalencia_um:25}]]));m.clientes.mockResolvedValue([{cod_cliente:7,nombre:'Cliente verificado'}]);});
describe('entregas verificadas',()=>{
 it('ignora nombre, peso, total y factura enviados por browser; excluye FA anulada o ajena',async()=>{
  m.ventas.mockResolvedValue([venta(10,'RE'),venta(20,'FA',{anulada:'S'}),venta(21,'FA',{cod_empresa:2}),venta(22,'FA')]);
  const [p]=await verificarEntregas([{im_comprobante_id:'10',fecha:'2026-09-11',total:1,kg:999,peso_completo:true,cliente_nombre:'Inventado',im_factura_id:'20'}]);
  expect(p).toMatchObject({total:80,kg:50,cliente_nombre:'Cliente verificado',im_factura_id:'22',factura_origen:'unica',cod_empresa:1,peso_completo:true});
 });
 it('reserva la factura vinculada de otros remitos del rango aun al seleccionar sólo uno',async()=>{
  m.ventas.mockResolvedValue([venta(10,'RE'),venta(11,'RE'),venta(20,'FA')]);
  m.tablas.presupuestos_facturados={data:[{im_comprobante_id:'1',im_remito_id:'11',im_factura_id:'20',im_factura_numero:20,cod_empresa:1,cod_cliente:7}],error:null};
  const [p]=await verificarEntregas([{im_comprobante_id:'10',fecha:'2026-09-11'}]);expect(p.im_factura_id).toBeNull();
 });
 it('items ausentes no se transforman en peso verificado',async()=>{m.ventas.mockResolvedValue([venta(10,'RE')]);m.items.mockResolvedValue([]);const [p]=await verificarEntregas([{im_comprobante_id:'10',fecha:'2026-09-11',kg:50,peso_completo:true}]);expect(p.peso_completo).toBe(false);expect(p.kg).toBe(0);});
 it('importe definitivo conserva snapshot y empresa desconocida sin vínculo',async()=>{
  m.tablas.presupuestos_facturados={data:[{im_comprobante_id:'1',im_remito_id:'10',cod_cliente:7,cod_empresa:1,total:80,facturado_at:'2026-09-10'}],error:null};
  const [a,b]=await enriquecerEntregas([{im_comprobante_id:'10',cod_cliente:7,total:100},{im_comprobante_id:'11',cod_cliente:7,total:40}]);
  expect(a).toMatchObject({total:80,total_snapshot:100,cod_empresa:1,empresa_fuente:'vinculo_panel'});expect(a.datos_consultados_at).toBeUndefined();expect(b.cod_empresa).toBeNull();
 });
 it('NC misma ID en ambas tablas sólo descuenta una vez',async()=>{
  m.tablas.facturas_correcciones={data:[{im_factura_id:'20',im_comprobante_id:'30',tipo:'nc',total:10,numero:5}],error:null};
  m.tablas.hojas_ruta_ajustes={data:[{im_comprobante_id:'10',im_ajuste_id:'30',tipo:'nc',importe:10,im_ajuste_numero:5}],error:null};
  const [p]=await notasDeHoja('h',[{im_comprobante_id:'10',im_factura_id:'20',total:80}]);expect(p.total+netoNotas(p.notas)).toBe(70);expect(p.notas).toHaveLength(1);
 });
 it('error de segunda página impide publicar un acumulado parcial',async()=>{
  const q=vi.fn().mockResolvedValueOnce({data:Array(500).fill({total:1}),error:null}).mockResolvedValueOnce({data:null,error:{message:'falló segunda página'}});
  await expect(leerPaginas(()=>({range:q}))).rejects.toThrow('segunda página');expect(q).toHaveBeenCalledTimes(2);
 });
});

it('cantidad ilegible de IM queda como peso incompleto aunque el browser mande peso_completo',async()=>{
 m.ventas.mockResolvedValue([venta(10,'RE')]);m.items.mockResolvedValue([{id_comprobante:'10',cod_articulo:3,cantidad:'dato ilegible'}]);
 const [p]=await verificarEntregas([{im_comprobante_id:'10',fecha:'2026-09-11',peso_completo:true,kg:50}]);
 expect(p).toMatchObject({kg:0,peso_completo:false,renglones_sin_peso:1});
});

it('hoja abierta sigue FA editada; cerrada mantiene base histórica sin consultar su FA',async()=>{
 m.tablas.presupuestos_facturados={data:[{im_comprobante_id:'1',im_remito_id:'10',im_factura_id:'20',cod_cliente:7,cod_empresa:1,total:100,facturado_at:'2026-09-11'}, {im_comprobante_id:'2',im_remito_id:'11',im_factura_id:'21',cod_cliente:7,cod_empresa:1,total:200,facturado_at:'2026-09-11'}],error:null};
 m.ventas.mockResolvedValue([venta(20,'FA',{total:80}),venta(21,'FA',{total:30})]);
 const filas=await enriquecerHojas([{estado:'abierta',hojas_ruta_pedidos:[{im_comprobante_id:'10',cod_cliente:7,cod_empresa:1,total:100,fecha:'2026-09-11'}]}, {estado:'cerrada',hojas_ruta_pedidos:[{im_comprobante_id:'11',cod_cliente:7,cod_empresa:1,total:200,fecha:'2026-09-11'}]}]);
 expect(filas.find(f=>f.im_comprobante_id==='10').total).toBe(80);expect(filas.find(f=>f.im_comprobante_id==='11').total).toBe(200);
 m.ventas.mockClear();await enriquecerHojas([{estado:'cerrada',hojas_ruta_pedidos:[{im_comprobante_id:'11',cod_cliente:7,cod_empresa:1,total:200}]}]);expect(m.ventas).not.toHaveBeenCalled();
});

it('la misma hoja conserva el total vigente al pasar de abierta a cerrada',async()=>{
 m.tablas.presupuestos_facturados={data:[{im_comprobante_id:'1',im_remito_id:'10',im_factura_id:'20',cod_cliente:7,cod_empresa:1,total:100,facturado_at:'2026-09-11'}],error:null};
 const h:any={estado:'abierta',hojas_ruta_pedidos:[{im_comprobante_id:'10',cod_cliente:7,cod_empresa:1,total:100,fecha:'2026-09-11'}]};
 m.ventas.mockResolvedValue([venta(20,'FA',{total:80})]);
 const abierta=await enriquecerHojas([h]);expect(abierta[0].total).toBe(80);
 h.estado='cerrada';h.cierres_importes=[{pedidos:[{im_comprobante_id:'10',cod_cliente:7,cod_empresa:1,im_factura_id:'20',total:80}]}];
 m.ventas.mockClear();m.ventas.mockRejectedValue(Error('IM caído'));m.tablas.presupuestos_facturados.data[0].total=999;
 const cerrada=await enriquecerHojas([h]);expect(cerrada[0].total).toBe(80);expect(cerrada[0].total_snapshot).toBe(100);expect(m.ventas).not.toHaveBeenCalled();
 h.estado='abierta';m.ventas.mockResolvedValue([venta(20,'FA',{total:70})]);expect((await enriquecerHojas([h]))[0].total).toBe(70);
});
it('listar conserva la hoja legacy y las demás aunque una factura no sea verificable',async()=>{
 m.ventas.mockResolvedValue([venta(20,'FA',{total:80}),venta(21,'FA',{cod_cliente:99})]);
 const pedidos=[{im_comprobante_id:'10',im_factura_id:'20',cod_cliente:7,cod_empresa:null,total:100,fecha:'2026-09-11'},
  {im_comprobante_id:'11',im_factura_id:'21',cod_cliente:7,cod_empresa:1,total:200,fecha:'2026-09-11'}];
 const hojas=pedidos.map(p=>({estado:'abierta',hojas_ruta_pedidos:[p]}));
 const filas=await enriquecerHojas(hojas,false,true);
 expect(filas).toHaveLength(2);expect(filas[0]).toMatchObject({total:80,cod_empresa:1});
 expect(filas[1]).toMatchObject({total:null,importe_fuente:'no_verificado'});
 await expect(enriquecerEntregas(pedidos)).rejects.toThrow('verificar');
 await expect(enriquecerHojas(hojas)).rejects.toThrow('verificar');
});
