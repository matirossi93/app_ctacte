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

describe('armarFraccionado', () => {
  it('🔴 cada cantidad es un PAQUETE aparte: no se suman', () => {
    // Mati: "no se puede globalizar cantidades". Cuatro pedidos de 30 kg son cuatro paquetes
    // de 30, no uno de 120: si se sumaran, el sector prepararía un solo bulto.
    const r = armarFraccionado([
      { cod_articulo: 1, cantidad: 30 }, { cod_articulo: 1, cantidad: 30 },
      { cod_articulo: 1, cantidad: 30 }, { cod_articulo: 1, cantidad: 30 },
    ], CAT);
    expect(r).toHaveLength(1);
    expect(r[0].cantidades).toEqual([30, 30, 30, 30]);
    expect(r[0].paquetes).toBe(4);
    expect(r[0].kg).toBe(120);
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
    // Se arranca por los paquetes grandes, que son los que definen cuántas bolsas se abren.
    const r = armarFraccionado([
      { cod_articulo: 2, cantidad: 10 }, { cod_articulo: 1, cantidad: 20 },
      { cod_articulo: 2, cantidad: 60 }, { cod_articulo: 2, cantidad: 20 },
    ], CAT);
    expect(r.map(x => x.descripcion)).toEqual(['AVENA INSTANTANEA', 'MEZCLA FINA ESPECIAL']);
    expect(r[0].cantidades).toEqual([60, 20, 10]);
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
  it('cuenta productos, paquetes y kilos', () => {
    const t = totalesFraccionado(armarFraccionado([
      { cod_articulo: 1, cantidad: 30 }, { cod_articulo: 1, cantidad: 20 },
      { cod_articulo: 2, cantidad: 60 },
    ], CAT));
    expect(t).toEqual({ productos: 2, paquetes: 3, kg: 110 });
  });
});
