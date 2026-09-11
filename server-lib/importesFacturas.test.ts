import {beforeEach, expect, it, vi} from 'vitest';
const m=vi.hoisted(()=>({ventas:vi.fn(),cabecera:vi.fn()}));
vi.mock('./infomanager.js',()=>({fetchVentas:m.ventas,cabeceraComprobante:m.cabecera}));
import {actualizarImportesFacturas,invalidarImportesFacturas} from './importesFacturas.js';
const original={im_comprobante_id:'10',im_factura_id:'20',im_factura_numero:50444,cod_cliente:430,cod_empresa:1,fecha:'2026-09-11',total:1111521};
const actual={id:'20',tipo_comprobante:'FA',anulada:'N' as const,cod_empresa:1,cod_cliente:430,total:1073534.08};
beforeEach(()=>{vi.clearAllMocks();invalidarImportesFacturas();m.ventas.mockResolvedValue([actual]);m.cabecera.mockResolvedValue({...actual,anulada:false,existe:true});});
it('adopta la factura vigente sin pisar snapshot, remito ni notas',async()=>{
 const filas=[{...original,notas:[{tipo:'NC',total:100}]}]; const [r]=await actualizarImportesFacturas(filas);
 expect(r).toMatchObject({total:1073534.08,total_snapshot:1111521,importe_fuente:'factura_im',notas:[{tipo:'NC',total:100}]});
 expect(filas[0].total).toBe(1111521);expect(m.ventas).toHaveBeenCalledTimes(1);expect(m.cabecera).not.toHaveBeenCalled();
});
it('reutiliza la consulta del tablero y no hace un GET por factura',async()=>{
 const r=await actualizarImportesFacturas(Array.from({length:50},()=>({...original})),{ventas:[actual]});
 expect(r).toHaveLength(50);expect(m.ventas).not.toHaveBeenCalled();expect(m.cabecera).not.toHaveBeenCalled();
});
it('Actualizar descarta el cache puntual de una factura movida fuera del rango',async()=>{
 const opciones={ventas:[]};expect((await actualizarImportesFacturas([original],opciones))[0].total).toBe(1073534.08);
 m.cabecera.mockResolvedValue({...actual,anulada:false,existe:true,total:100});
 expect((await actualizarImportesFacturas([original],opciones))[0].total).toBe(1073534.08);
 expect((await actualizarImportesFacturas([original],{...opciones,actualizar:true}))[0].total).toBe(100);
 expect(m.cabecera).toHaveBeenCalledTimes(2);
});
it('la invalidación elimina el importe puntual anterior',async()=>{
 await actualizarImportesFacturas([original],{ventas:[]});invalidarImportesFacturas();
 await actualizarImportesFacturas([original],{ventas:[]});expect(m.cabecera).toHaveBeenCalledTimes(2);
});
it.each([{cod_cliente:9},{cod_empresa:2},{tipo_comprobante:'RE'},{anulada:'S'},{total:null},{total:''},{total:' '},{total:'invalido'}])('rechaza importe o identidad no verificables %j',async cambio=>{
 await expect(actualizarImportesFacturas([original],{ventas:[{...actual,...cambio} as any]})).rejects.toThrow('verificar');
});
it('una caída de IM no imprime el snapshot como importe vigente',async()=>{
 m.ventas.mockRejectedValue(Error('sin conexión'));await expect(actualizarImportesFacturas([original])).rejects.toThrow('sin conexión');
 expect(m.cabecera).not.toHaveBeenCalled();
});
it('una FA fuera de rango inexistente o incierta no se reemplaza por el PR',async()=>{
 m.cabecera.mockResolvedValue({existe:null,anulada:null,total:null});await expect(actualizarImportesFacturas([original],{ventas:[]})).rejects.toThrow('verificar');
});
it('acepta cero explícito; un pedido aún sin factura no dispara consultas',async()=>{
 expect((await actualizarImportesFacturas([original],{ventas:[{...actual,total:0}]}))[0].total).toBe(0);
 await actualizarImportesFacturas([{total:100}]);expect(m.ventas).not.toHaveBeenCalled();
});
