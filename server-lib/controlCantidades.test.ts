import { describe, it, expect, vi } from 'vitest';
import { revisarCantidades } from './controlCantidades.js';

// `formatosBolsa` arrastra el cliente de InfoManager, que aborta sin credenciales. Acá sólo se
// prueba la parte pura (de qué cantidades sale el formato de bolsa).
vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });
const { formatoDominante } = await import('./formatosBolsa.js');

/**
 * El control que pidió Mati: que las cantidades se correspondan con el formato del producto.
 * Los casos salen de renglones REALES de InfoManager (30 días, 8.623 renglones, 10/08→08/09).
 */

const CAT = new Map<number, { descripcion: string; equivalencia_um: number | null }>([
  [1, { descripcion: 'MAIZ QUEBRADO MEDIANO X 30 KG', equivalencia_um: 30 }],
  [2, { descripcion: 'INICIADOR X 40 KG', equivalencia_um: 40 }],
  [3, { descripcion: 'GRAN CAMPEON CACHORRO X 10 KG', equivalencia_um: 10 }],
  [4, { descripcion: 'ALPISTE', equivalencia_um: 1 }],
  [5, { descripcion: 'PRODUCTO SIN FICHA', equivalencia_um: null }],
]);

describe('revisarCantidades', () => {
  it('🔴 caza el error real: 30 bolsas de 30 kg = 900 kg', () => {
    // PR 57778 del 04/09/2026. Lo habitual en ese artículo son 2 bolsas.
    const r = revisarCantidades([{ cod_articulo: 1, cantidad: 30 }], CAT);
    expect(r).toHaveLength(1);
    expect(r[0].kg_total).toBe(900);
    expect(r[0].texto).toMatch(/900 kg/);
  });

  it('🔴 y el de 1.600 kg', () => {
    // PR 58190: 40 × INICIADOR X 40 KG, donde lo habitual es 1 bolsa.
    const r = revisarCantidades([{ cod_articulo: 2, cantidad: 40 }], CAT);
    expect(r[0].kg_total).toBe(1600);
  });

  it('🔴 NO marca 10 bolsas de 10 kg: es una venta normal', () => {
    // Sin el corte por peso esto marcaba 83 renglones en 30 días y nadie miraría ninguno.
    expect(revisarCantidades([{ cod_articulo: 3, cantidad: 10 }], CAT)).toHaveLength(0);
  });

  it('🔴 el granel no se controla así: la cantidad son kilos sueltos', () => {
    // ALPISTE tiene equivalencia 1 en el catálogo: 30 son 30 kilos, no 30 bolsas.
    expect(revisarCantidades([{ cod_articulo: 4, cantidad: 30 }], CAT)).toHaveLength(0);
    expect(revisarCantidades([{ cod_articulo: 4, cantidad: 210 }], CAT)).toHaveLength(0);
  });

  it('una cantidad normal de un artículo pesado no se marca', () => {
    // 2 bolsas de 30 kg: lo de todos los días.
    expect(revisarCantidades([{ cod_articulo: 1, cantidad: 2 }], CAT)).toHaveLength(0);
    // 31 bolsas tampoco: la sospecha es que la cantidad SEA el peso del bulto.
    expect(revisarCantidades([{ cod_articulo: 1, cantidad: 31 }], CAT)).toHaveLength(0);
  });

  it('un artículo sin ficha en el catálogo no genera avisos falsos', () => {
    expect(revisarCantidades([{ cod_articulo: 5, cantidad: 30 }], CAT)).toHaveLength(0);
    expect(revisarCantidades([{ cod_articulo: 999, cantidad: 30 }], CAT)).toHaveLength(0);
  });

  it('🔴 granel: 25 kg de una mezcla cuya bolsa es de 30 se marca', () => {
    // El caso que describió Mati, con el formato confirmado por él el 08/09/2026. En IM el
    // artículo dice `equivalencia_um: 1`, así que el formato sale del histórico de pedidos.
    const FORMATOS = new Map([[4, 30]]);            // ALPISTE: bolsa de 30 kg
    const r = revisarCantidades([{ cod_articulo: 4, cantidad: 25 }], CAT, FORMATOS);
    expect(r).toHaveLength(1);
    expect(r[0].tipo).toBe('no_es_la_bolsa');
    expect(r[0].texto).toMatch(/la bolsa es de 30/);
  });

  it('🔴 pero NO marca la bolsa entera, ni varias bolsas, ni el fraccionado chico', () => {
    const FORMATOS = new Map([[4, 30]]);
    for (const cant of [30, 60, 90, 150, 210, 5, 10]) {
      expect(revisarCantidades([{ cod_articulo: 4, cantidad: cant }], CAT, FORMATOS)).toHaveLength(0);
    }
  });

  it('🔴 sin formato conocido el granel no se controla: no se inventa una bolsa', () => {
    // El cache de formatos arranca vacío y se llena en segundo plano; hasta entonces, nada.
    expect(revisarCantidades([{ cod_articulo: 4, cantidad: 25 }], CAT, null)).toHaveLength(0);
    expect(revisarCantidades([{ cod_articulo: 4, cantidad: 25 }], CAT, new Map())).toHaveLength(0);
  });

  it('revisa todos los renglones del pedido, no sólo el primero', () => {
    const r = revisarCantidades([
      { cod_articulo: 3, cantidad: 5 },
      { cod_articulo: 1, cantidad: 30 },
      { cod_articulo: 2, cantidad: 40 },
    ], CAT);
    expect(r.map(x => x.cod_articulo)).toEqual([1, 2]);
  });
});

describe('formatoDominante — de dónde sale la bolsa', () => {
  it('🔴 saca 30 de las cantidades reales del alpiste (30 días de IM)', () => {
    // 5×19 · 10×8 · 25×6 · 30×23 · 60 · 90 · 150 · 210, y Mati confirmó que la bolsa es de 30.
    const cants = [
      ...Array(19).fill(5), ...Array(8).fill(10), ...Array(6).fill(25),
      ...Array(23).fill(30), 60, 60, 90, 150, 210,
    ];
    expect(formatoDominante(cants)).toBe(30);
  });

  it('🔴 ignora el fraccionado chico: la bolsa no es de 5 kg aunque sea lo más pedido', () => {
    const cants = [...Array(40).fill(5), ...Array(25).fill(25), ...Array(5).fill(50)];
    expect(formatoDominante(cants)).toBe(25);
  });

  it('🔴 sin repetición no inventa un formato', () => {
    expect(formatoDominante([...Array(25).fill(3), 40, 55])).toBeNull();   // dos ventas sueltas
    expect(formatoDominante([25, 25, 25])).toBeNull();                     // poca historia
  });
});
