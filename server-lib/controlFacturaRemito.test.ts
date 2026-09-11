import { describe, expect, it } from 'vitest';
import { compararFacturaRemito, textoControl } from './controlFacturaRemito.js';

const r = (cod: number, cant: unknown, extra: any = {}) => ({ cod_articulo: cod, cantidad: cant, ...extra });

describe('cuándo coinciden', () => {
  it('🔑 mismas cantidades, aunque el orden cambie', () => {
    const fa = [r(509, 1), r(101, 2), r(166, 3)];
    const re = [r(166, 3), r(509, 1), r(101, 2)];
    expect(compararFacturaRemito(fa, re).estado).toBe('coinciden');
  });

  it('granel con cuatro decimales', () => {
    expect(compararFacturaRemito([r(401, 0.0450)], [r(401, 0.045)]).estado).toBe('coinciden');
  });

  it('filas repetidas del mismo artículo se suman', () => {
    expect(compararFacturaRemito([r(722, 2), r(722, 3)], [r(722, 5)]).estado).toBe('coinciden');
  });

  it('🪤 cero es una cantidad, no un dato faltante', () => {
    expect(compararFacturaRemito([r(722, 0)], [r(722, 0)]).estado).toBe('coinciden');
  });

  it('🪤 `cod_uni_venta: 0` es la emisión normal, no una incompatibilidad', () => {
    const fa = [r(101, 2, { cod_uni_venta: 0, cant_uni_venta: 0 })];
    const re = [r(101, 2, { cod_uni_venta: 0, cant_uni_venta: 0 })];
    expect(compararFacturaRemito(fa, re).estado).toBe('coinciden');
  });

  it('sin marcadores de unidad se compara igual: no se exigen', () => {
    expect(compararFacturaRemito([r(101, 2)], [r(101, 2, { cod_uni_venta: null })]).estado).toBe('coinciden');
  });
});

describe('cuándo hay diferencias', () => {
  /** 🔴 El caso real: FERNÁNDEZ, remito de 14 renglones contra factura de 12. */
  it('🔑 lo que está en el remito y no en la factura', () => {
    const fa = [r(509, 1), r(101, 2)];
    const re = [r(509, 1), r(101, 2), r(378, 1), r(379, 1)];
    const res = compararFacturaRemito(fa, re);
    expect(res.estado).toBe('diferencias');
    expect(res.diferencias).toEqual([
      { cod_articulo: 378, factura: 0, remito: 1 },
      { cod_articulo: 379, factura: 0, remito: 1 },
    ]);
    expect(textoControl(res)).toContain('378 (factura 0, remito 1)');
    // No nombra entrega ni stock: sólo lo que dicen los papeles.
    expect(textoControl(res)).not.toMatch(/stock|entreg/i);
  });

  it('y también al revés, y por cantidad distinta', () => {
    expect(compararFacturaRemito([r(101, 5)], [r(101, 3)]).diferencias)
      .toEqual([{ cod_articulo: 101, factura: 5, remito: 3 }]);
  });

  it('🪤 el COSTO DE DISTRIBUCIÓN no cuenta: va en la factura y no es mercadería', () => {
    expect(compararFacturaRemito([r(101, 2), r(13819, 1)], [r(101, 2)]).estado).toBe('coinciden');
  });
});

describe('cuándo NO se puede afirmar nada', () => {
  it('🔑 sin evidencia de alguno de los dos', () => {
    expect(compararFacturaRemito(null, [r(101, 2)]).estado).toBe('no_verificado');
    expect(compararFacturaRemito([r(101, 2)], undefined).estado).toBe('no_verificado');
  });

  it('🔑 un comprobante sin renglones no es "coinciden con vacío"', () => {
    expect(compararFacturaRemito([], []).estado).toBe('no_verificado');
    expect(compararFacturaRemito([r(101, 2)], []).estado).toBe('no_verificado');
  });

  /** 🔴 `Number(null)` es 0: dos "no sé" convertidos a 0 darían coinciden. */
  it('🔑 null y 0 NO son lo mismo', () => {
    expect(compararFacturaRemito([r(101, null)], [r(101, null)]).estado).toBe('no_verificado');
    expect(compararFacturaRemito([r(101, null)], [r(101, 0)]).estado).toBe('no_verificado');
    expect(compararFacturaRemito([r(101, '')], [r(101, '')]).estado).toBe('no_verificado');
  });

  it('🪤 una cantidad que se coerce desde un array tampoco', () => {
    expect(compararFacturaRemito([r(101, ['2'])], [r(101, 2)]).estado).toBe('no_verificado');
  });

  it('🔑 unidad alternativa explícita distinta en cada comprobante', () => {
    const fa = [r(163, 10, { cod_uni_venta: 5, cant_uni_venta: 15 })];
    const re = [r(163, 10, { cod_uni_venta: 7, cant_uni_venta: 30 })];
    const res = compararFacturaRemito(fa, re);
    expect(res.estado).toBe('no_verificado');
    expect(res.motivo).toContain('unidad de venta alternativa');
  });

  /**
   * 🔴 Bloqueante que encontró Astra: el mismo marcador de los dos lados daba "coinciden". Sin
   * la equivalencia acreditada, afirmar que 1 de una unidad es 1 de la otra sería inventar una
   * conversión — aunque los dos digan lo mismo.
   */
  it('🔑 el MISMO marcador en los dos lados tampoco se puede acreditar', () => {
    const iguales = [r(163, 10, { cod_uni_venta: 2, cant_uni_venta: 1 })];
    expect(compararFacturaRemito(iguales, iguales).estado).toBe('no_verificado');
  });

  it('🔑 un marcador ilegible no es un marcador ausente', () => {
    const fa = [r(163, 10, { cod_uni_venta: 'X' })];
    expect(compararFacturaRemito(fa, [r(163, 10)]).estado).toBe('no_verificado');
    expect(compararFacturaRemito(fa, fa).estado).toBe('no_verificado');
  });

  it('🔑 ni un marcador negativo', () => {
    const fa = [r(163, 10, { cant_uni_venta: -1 })];
    expect(compararFacturaRemito(fa, fa).estado).toBe('no_verificado');
  });

  it('🪤 uno declara unidad alternativa y el otro no', () => {
    const fa = [r(163, 10, { cod_uni_venta: 5, cant_uni_venta: 15 })];
    expect(compararFacturaRemito(fa, [r(163, 10)]).estado).toBe('no_verificado');
  });

  it('filas repetidas del mismo artículo con unidades distintas entre sí', () => {
    const fa = [r(163, 5, { cod_uni_venta: 5 }), r(163, 5, { cod_uni_venta: 9 })];
    expect(compararFacturaRemito(fa, [r(163, 10)]).estado).toBe('no_verificado');
  });

  it('un renglón sin artículo legible', () => {
    expect(compararFacturaRemito([r(0, 2)], [r(101, 2)]).estado).toBe('no_verificado');
    expect(compararFacturaRemito([{ cod_articulo: null, cantidad: 2 }], [r(101, 2)]).estado).toBe('no_verificado');
  });

  it('🪤 si sólo quedaban renglones no físicos, no hay nada que afirmar', () => {
    expect(compararFacturaRemito([r(13819, 1)], [r(13819, 1)]).estado).toBe('no_verificado');
  });
});

describe('el texto para la pantalla', () => {
  it('la etiqueta positiva dice "registradas", no "correcto"', () => {
    expect(textoControl({ estado: 'coinciden' })).toBe('Coinciden las cantidades registradas en la factura y el remito.');
  });
  it('y el no verificado explica por qué', () => {
    expect(textoControl({ estado: 'no_verificado', motivo: 'Uno de los dos comprobantes vino sin renglones.' }))
      .toBe('Uno de los dos comprobantes vino sin renglones.');
  });
});

/** Casos que salieron de la revisión de Astra: la coerción y los bordes numéricos. */
describe('lo que NO es una cantidad', () => {
  it('🔑 booleanos, arrays y objetos', () => {
    for (const v of [true, false, [], [1], ['2'], {}, { valueOf: () => 2 }]) {
      expect(compararFacturaRemito([r(101, v)], [r(101, 2)]).estado, JSON.stringify(v)).toBe('no_verificado');
    }
  });

  it('🔑 negativos: en una factura o un remito son un dato anómalo', () => {
    expect(compararFacturaRemito([r(101, -1)], [r(101, -1)]).estado).toBe('no_verificado');
  });

  it('🔑 sumas que desbordan no pueden dar coinciden', () => {
    const enorme = [r(101, 1e308), r(101, 1e308)];
    expect(compararFacturaRemito(enorme, enorme).estado).toBe('no_verificado');
  });

  it('🔑 una diferencia de 0,0001 es real y se ve', () => {
    const res = compararFacturaRemito([r(401, 1.0001)], [r(401, 1.0002)]);
    expect(res.estado).toBe('diferencias');
  });

  it('🔑 cant_uni_venta sin su código no se puede acreditar, aunque esté de los dos lados', () => {
    const fa = [r(163, 10, { cant_uni_venta: 15 })];
    const re = [r(163, 10, { cant_uni_venta: 15 })];
    expect(compararFacturaRemito(fa, re).estado).toBe('no_verificado');
  });
});

it('🔑 un código fuera del entero seguro no se aparea: dos distintos colapsarían en uno', () => {
  const a = [r(9007199254740993, 1)];          // 2^53+1, indistinguible de 2^53 en JS
  expect(compararFacturaRemito(a, a).estado).toBe('no_verificado');
  expect(compararFacturaRemito([r(1.5, 1)], [r(1.5, 1)]).estado).toBe('no_verificado');
});
