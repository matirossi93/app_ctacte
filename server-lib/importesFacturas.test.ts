import {beforeEach, describe, expect, it, vi} from 'vitest';
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
 m.cabecera.mockResolvedValue({existe:null,anulada:null,total:null});await expect(actualizarImportesFacturas([original],{ventas:[]})).rejects.toThrow(/no pude leer/i);
});
it('acepta cero explícito; un pedido aún sin factura no dispara consultas',async()=>{
 expect((await actualizarImportesFacturas([original],{ventas:[{...actual,total:0}]}))[0].total).toBe(0);
 await actualizarImportesFacturas([{total:100}]);expect(m.ventas).not.toHaveBeenCalled();
});
it('una entrega legacy obtiene empresa de su FA vigente sólo con cliente y Casa Central confirmados',async()=>{
 const [r]=await actualizarImportesFacturas([{...original,cod_empresa:null}],{ventas:[actual]});
 expect(r).toMatchObject({cod_empresa:1,empresa_fuente:'factura_im',total:1073534.08});
 await expect(actualizarImportesFacturas([{...original,cod_empresa:null}],{ventas:[{...actual,cod_empresa:2}]})).rejects.toThrow('verificar');
 await expect(actualizarImportesFacturas([{...original,cod_empresa:null}],{ventas:[{...actual,cod_cliente:9}]})).rejects.toThrow('verificar');
});
it('un importe no verificable en lectura no oculta otras entregas ni muestra total viejo o cero',async()=>{
 const mala={...original,im_factura_id:'30',im_factura_numero:50422};
 const ventas=[actual,{...actual,id:'30',anulada:'S' as const}];
 const r=await actualizarImportesFacturas([original,mala],{ventas,tolerarErrores:true});
 expect(r[0].total).toBe(1073534.08);
 expect(r[1]).toMatchObject({total:null,total_snapshot:1111521,importe_fuente:'no_verificado'});
 expect(r[1]).toMatchObject({importe_error:expect.stringContaining('50422')});
 await expect(actualizarImportesFacturas([original,mala],{ventas})).rejects.toThrow('50422');
});
it('lectura tolerante ante caída conserva filas desconocidas y no dispara una consulta por cada FA',async()=>{
 m.ventas.mockRejectedValue(Error('IM no responde'));
 const [r]=await actualizarImportesFacturas([original],{tolerarErrores:true});
 expect(r).toMatchObject({total:null,importe_fuente:'no_verificado'});
 expect(m.cabecera).not.toHaveBeenCalled();
});

/**
 * 🔑 CON UN LECTOR DE PETICIÓN, EL CACHE GLOBAL NO MANDA.
 *
 * `puntuales.obtener` devuelve el total cacheado sin invocar al lector. Si esta ruta lo usara,
 * la vigencia saldría de la cabecera nueva y el importe de una vieja — justo lo contrario de
 * compartir una sola lectura.
 */
it('🔑 con lector de petición gana la lectura de ESTA petición, no el cache caliente',async()=>{
 // La FA es de otro día: no está en el listado del rango, va por el camino puntual.
 m.ventas.mockResolvedValue([]);
 // Cache caliente con 100.
 m.cabecera.mockResolvedValue({...actual,total:100,anulada:false,existe:true});
 const [previo]=await actualizarImportesFacturas([{...original}]);
 expect(previo.total).toBe(100);
 expect(m.cabecera).toHaveBeenCalledTimes(1);

 // Y ahora una lectura de petición que dice 200.
 const leerCabecera=vi.fn(async()=>({...actual,total:200,anulada:false,existe:true} as any));
 const [r]=await actualizarImportesFacturas([{...original}],{leerCabecera});
 expect(r.total).toBe(200);
 expect(leerCabecera).toHaveBeenCalledTimes(1);
 expect(m.cabecera).toHaveBeenCalledTimes(1);   // no volvió al camino global
});

it('🪤 un lector que no sabe NO se rescata con el valor cacheado',async()=>{
 m.ventas.mockResolvedValue([]);
 m.cabecera.mockResolvedValue({...actual,total:100,anulada:false,existe:true});
 await actualizarImportesFacturas([{...original}]);   // deja 100 en el cache

 const leerCabecera=vi.fn(async()=>({existe:null,anulada:null,total:null} as any));
 const [r]=await actualizarImportesFacturas([{...original}] as any[],{leerCabecera,tolerarErrores:true});
 expect(r.total).toBeNull();
 expect(r.importe_fuente).toBe('no_verificado');
 expect(r.total_snapshot).toBe(1111521);
});

/**
 * 🔴 22/09/2026 — EL AVISO TIENE QUE DECIR QUÉ PASÓ.
 *
 * Mati mandó la captura de una hoja de ruta con *"No pude verificar el importe actual de la
 * factura 58879767 en InfoManager"*. Ese texto salía para TRES situaciones distintas: la factura
 * no existe, está anulada, o no se pudo leer el importe. La de la captura era la primera —la
 * factura 50695 de BUSTOS se anuló y se borró de IM, mientras su remito seguía vivo en una hoja
 * abierta— y el mensaje mandaba a "actualizar", que no iba a cambiar nada.
 */
describe('qué dice el aviso según lo que pasó', () => {
  const fila = { im_comprobante_id: '1', im_factura_id: '999', im_factura_numero: 50695, cod_cliente: 7, cod_empresa: 1, total: 1000 };
  const correr = (cab: any) => actualizarImportesFacturas([{ ...fila } as any], {
    ventas: [], tolerarErrores: true, leerCabecera: async () => cab,
  });

  it('🔑 anulada lo dice, en vez de mandar a actualizar', async () => {
    const r: any = await correr({ existe: true, anulada: true, total: 1000, tipo_comprobante: 'FA', numero: 50695 });
    expect(r[0].importe_error).toMatch(/anulada/i);
  });

  it('🔑 borrada de InfoManager lo dice', async () => {
    const r: any = await correr({ existe: false, anulada: null, total: null });
    expect(r[0].importe_error).toMatch(/ya no est|no existe/i);
  });

  it('🔑 y "no se pudo leer" queda para lo que de verdad es un problema de lectura', async () => {
    const r: any = await correr({ existe: null, anulada: null, total: null });
    expect(r[0].importe_error).toMatch(/no pude leer|no se pudo/i);
  });
});

/**
 * 🔴 22/09/2026 — SI LA FACTURA CAMBIÓ DE TALONARIO, HAY QUE AVISAR.
 *
 * Dos de 389 facturas emitidas por la app aparecieron en InfoManager con otro número y otro
 * punto de venta: se las había reasignado al talonario del controlador fiscal (el 15) al
 * imprimirlas. Se descubrió porque Mati notó una impresión rara, dos semanas después.
 *
 * 🪤 El aviso NO invalida el importe: la factura existe y su total es bueno. Va por un campo
 * propio justamente para no bloquear el armado de la hoja, que es lo que hace `importe_error`.
 */
describe('cuando la factura aparece en otro talonario', () => {
  const base = { im_comprobante_id: '1', im_factura_id: '58823047', im_factura_numero: 50520, cod_cliente: 302, cod_empresa: 1, total: 153408.62 };
  const venta = (extra: any) => ({ id: '58823047', tipo_comprobante: 'FA', anulada: 'N', cod_cliente: 302, cod_empresa: 1, total: 153408.62, punto_de_venta: 777, numero: 50520, ...extra });

  it('🔑 avisa el número y el punto nuevos, y NO rompe el importe', async () => {
    const r: any = await actualizarImportesFacturas([{ ...base } as any], { ventas: [venta({ numero: 18475, punto_de_venta: 15 })] as any });
    expect(r[0].total).toBe(153408.62);
    expect(r[0].importe_error).toBeFalsy();
    expect(r[0].aviso_comprobante).toMatch(/18475/);
    expect(r[0].aviso_comprobante).toMatch(/15/);
  });

  it('🔑 sin cambios no avisa nada: un cartel que sale siempre no lo lee nadie', async () => {
    const r: any = await actualizarImportesFacturas([{ ...base } as any], { ventas: [venta({})] as any });
    expect(r[0].aviso_comprobante).toBeUndefined();
  });

  it('🪤 no avisa por un número que nunca registramos', async () => {
    const r: any = await actualizarImportesFacturas([{ ...base, im_factura_numero: null } as any], { ventas: [venta({ numero: 18475, punto_de_venta: 15 })] as any });
    expect(r[0].aviso_comprobante).toBeUndefined();
  });
});
