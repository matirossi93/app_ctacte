import { describe, it, expect } from 'vitest';
import { armarFraccionado, totalesFraccionado, esKilo } from './fraccionado.js';

/**
 * El listado que va al sector de fraccionado. Si está mal, preparan de más, de menos, o
 * fraccionan algo que venía en bolsa cerrada.
 */

const CAT = new Map<number, { descripcion: string; unidad_de_medida: string | null }>([
  [1, { descripcion: 'MEZCLA FINA ESPECIAL', unidad_de_medida: 'KG' }],
  [2, { descripcion: 'AVENA INSTANTANEA', unidad_de_medida: 'Kilos' }],
  [3, { descripcion: 'ALIMENTO PERRO 22KG', unidad_de_medida: 'BOLSA' }],
  [4, { descripcion: 'PASTA DE MANI', unidad_de_medida: 'UNIDAD' }],
]);

/** Lo que `formatosBolsa` deduce de los pedidos: la mezcla y la avena vienen en bolsa. */
const FORMATOS = new Map<number, number>([[1, 30], [2, 20]]);

describe('armarFraccionado', () => {
  it('🔑 cuatro pedidos de 30 kg son cuatro BOLSAS CERRADAS: no se fracciona nada', () => {
    // 🔄 Cambió el 09/09/2026. Antes esto daba cuatro paquetes de 30 para fraccionar; Mati:
    // "si dice 60 kilos, no son 60 kilos fraccionados, son 2 bolsas de 30". Un múltiplo exacto
    // de la bolsa ya viene preparado del depósito.
    const r = armarFraccionado([
      { cod_articulo: 1, cantidad: 30 }, { cod_articulo: 1, cantidad: 30 },
      { cod_articulo: 1, cantidad: 30 }, { cod_articulo: 1, cantidad: 30 },
    ], CAT, FORMATOS);
    expect(r).toHaveLength(1);
    expect(r[0].bolsas_enteras).toBe(4);
    expect(r[0].paquetes).toBe(0);
  });

  it('🔴 "no se puede globalizar": dos pedidos de 15 kg son dos juegos de paquetes, no uno de 30', () => {
    // Mati (07/09/2026). Si se sumaran, el sector prepararía un solo bulto para dos clientes.
    const r = armarFraccionado([
      { cod_articulo: 1, cantidad: 15 }, { cod_articulo: 1, cantidad: 15 },
    ], CAT, FORMATOS);
    expect(r[0].cantidades).toEqual([10, 10, 5, 5]);
    expect(r[0].kg).toBe(30);
  });

  it('🔴 lo que NO se vende por kilo no se fracciona', () => {
    // Una bolsa cerrada de 22 kg viaja como está. Si entrara al listado, alguien la abriría.
    const r = armarFraccionado([
      { cod_articulo: 3, cantidad: 10 }, { cod_articulo: 4, cantidad: 5 },
      { cod_articulo: 2, cantidad: 60 },
    ], CAT);
    expect(r.map(x => x.descripcion)).toEqual(['AVENA INSTANTANEA']);
  });

  it('las cantidades salen de mayor a menor y los productos en orden alfabético', () => {
    // La avena viene en bolsa de 20: los pedidos de 60 y 20 son bolsas cerradas y el de 10 se
    // fracciona. La mezcla de 20 no es múltiplo de 30, así que va en 10 + 10.
    const r = armarFraccionado([
      { cod_articulo: 2, cantidad: 10 }, { cod_articulo: 1, cantidad: 20 },
      { cod_articulo: 2, cantidad: 60 }, { cod_articulo: 2, cantidad: 20 },
    ], CAT, FORMATOS);
    expect(r.map(x => x.descripcion)).toEqual(['AVENA INSTANTANEA', 'MEZCLA FINA ESPECIAL']);
    expect(r[0].cantidades).toEqual([10]);
    expect(r[0].bolsas_enteras).toBe(4);          // 60 = 3 bolsas + 20 = 1 bolsa
    expect(r[1].cantidades).toEqual([10, 10]);
  });

  it('un artículo que no está en el catálogo no se inventa', () => {
    // Sin ficha no se sabe si va por kilo: queda afuera y el pedido igual se prepara a mano.
    expect(armarFraccionado([{ cod_articulo: 999, cantidad: 30 }], CAT)).toHaveLength(0);
  });

  it('cantidades en cero o negativas no generan paquetes', () => {
    expect(armarFraccionado([
      { cod_articulo: 1, cantidad: 0 }, { cod_articulo: 1, cantidad: -5 },
    ], CAT)).toHaveLength(0);
  });

  it('los kilos no arrastran el error del punto flotante', () => {
    // 30,1 + 30,2 da 60,29999... y esto se pesa en una balanza.
    const r = armarFraccionado([
      { cod_articulo: 1, cantidad: 30.1 }, { cod_articulo: 1, cantidad: 30.2 },
    ], CAT);
    expect(r[0].kg).toBe(60.3);
  });

  it('esKilo reconoce cómo lo escribe IM, y no confunde otras unidades', () => {
    for (const u of ['KG', 'kg', ' Kilos ', 'KILOGRAMO']) expect(esKilo(u)).toBe(true);
    for (const u of ['BOLSA', 'UNIDAD', '', null, undefined, 'KGS']) expect(esKilo(u)).toBe(false);
  });
});

describe('totalesFraccionado', () => {
  it('cuenta productos, paquetes y kilos de lo que SÍ hay que fraccionar', () => {
    // Mezcla (bolsa 30): 30 es bolsa entera, 20 va en 10 + 10. Avena (bolsa 20): 60 son 3
    // bolsas enteras. Así que se fraccionan 2 paquetes y 20 kg, no los 110 pedidos.
    const lineas = armarFraccionado([
      { cod_articulo: 1, cantidad: 30 }, { cod_articulo: 1, cantidad: 20 },
      { cod_articulo: 2, cantidad: 60 },
    ], CAT, FORMATOS);
    expect(totalesFraccionado(lineas)).toEqual({ productos: 2, paquetes: 2, kg: 20 });
    expect(lineas.reduce((s, l) => s + l.bolsas_enteras, 0)).toBe(4);
  });
});

it('conserva código y separa artículos con el mismo nombre en el impreso',()=>{
 const cat=new Map([[10,{descripcion:'MEZCLA',unidad_de_medida:'KG'}],[20,{descripcion:'MEZCLA',unidad_de_medida:'KG'}]]);
 const r=armarFraccionado([{cod_articulo:10,cantidad:5},{cod_articulo:20,cantidad:3}],cat);
 expect(r).toHaveLength(2);expect(r[0]).toMatchObject({cod_articulo:10,kg:5});expect(r[1]).toMatchObject({cod_articulo:20,kg:3});
});
