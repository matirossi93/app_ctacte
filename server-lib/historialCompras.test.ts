import { describe, it, expect } from 'vitest';
import { esLineaTecnica, agregarPorArticulo } from './historialCompras.js';

describe('esLineaTecnica', () => {
  it('matchea flete (case insensitive)', () => {
    expect(esLineaTecnica('FLETE EMPRESA TRANSPORTE')).toBe(true);
    expect(esLineaTecnica('Flete CABA')).toBe(true);
    expect(esLineaTecnica('flete')).toBe(true);
  });

  it('matchea descuento, bonif, ajuste, redondeo, percepcion', () => {
    expect(esLineaTecnica('DESCUENTO COMERCIAL')).toBe(true);
    expect(esLineaTecnica('BONIF VOLUMEN')).toBe(true);
    expect(esLineaTecnica('AJUSTE PRECIO')).toBe(true);
    expect(esLineaTecnica('REDONDEO')).toBe(true);
    expect(esLineaTecnica('PERCEPCION IIBB')).toBe(true);
  });

  it('NO matchea productos reales', () => {
    expect(esLineaTecnica('MIX ENERGETICO 25KG')).toBe(false);
    expect(esLineaTecnica('TIERNITOS 25KG')).toBe(false);
    expect(esLineaTecnica('GRAN CAMPEON CARNE 21KG')).toBe(false);
  });

  it('strings vacíos / null tratados como NO técnicos (no descartar línea por dato faltante)', () => {
    expect(esLineaTecnica('')).toBe(false);
    expect(esLineaTecnica(null as any)).toBe(false);
    expect(esLineaTecnica(undefined as any)).toBe(false);
  });
});

describe('agregarPorArticulo', () => {
  it('suma cantidades e importes con signo por cabecera', () => {
    const items = [
      { id_comprobante: 1, cod_articulo: 100, cantidad: 2, importe: 1000 },
      { id_comprobante: 1, cod_articulo: 101, cantidad: 1, importe: 500 },
      { id_comprobante: 2, cod_articulo: 100, cantidad: 3, importe: 1500 },
      // NC: signo -1
      { id_comprobante: 3, cod_articulo: 100, cantidad: 1, importe: 500 },
    ];
    const signos = new Map<number, { sign: 1 | -1; fecha: string }>([
      [1, { sign: 1, fecha: '2026-05-10' }],
      [2, { sign: 1, fecha: '2026-05-20' }],
      [3, { sign: -1, fecha: '2026-05-22' }],
    ]);
    const articulosMap = new Map<number, { descripcion: string }>([
      [100, { descripcion: 'Mix Energético 25kg' }],
      [101, { descripcion: 'Tiernitos 25kg' }],
    ]);
    const agg = agregarPorArticulo(items, signos, articulosMap);

    const a100 = agg.get(100)!;
    // FA1: 2 + FA2: 3 - NC3: 1 = 4 unidades
    expect(a100.cantidad_total).toBe(4);
    // FA1: 1000 + FA2: 1500 - NC3: 500 = 2000
    expect(a100.importe_total).toBe(2000);
    // Aparece en 3 facturas distintas (id 1, 2 y 3)
    expect(a100.num_facturas).toBe(3);
    expect(a100.ultima_compra).toBe('2026-05-22');
    expect(a100.detalle).toBe('Mix Energético 25kg');

    const a101 = agg.get(101)!;
    expect(a101.cantidad_total).toBe(1);
    expect(a101.importe_total).toBe(500);
    expect(a101.num_facturas).toBe(1);
  });

  it('excluye items sin cabecera válida (no en signos map)', () => {
    const items = [{ id_comprobante: 999, cod_articulo: 100, cantidad: 5, importe: 5000 }];
    const signos = new Map<number, { sign: 1 | -1; fecha: string }>();
    const articulosMap = new Map<number, { descripcion: string }>([[100, { descripcion: 'X' }]]);
    const agg = agregarPorArticulo(items, signos, articulosMap);
    expect(agg.size).toBe(0);
  });

  it('usa detalle del item si articulosMap no tiene el código', () => {
    const items = [{ id_comprobante: 1, cod_articulo: 555, cantidad: 1, importe: 100, detalle: 'PRODUCTO DESDE ITEM' } as any];
    const signos = new Map([[1, { sign: 1 as const, fecha: '2026-05-01' }]]);
    const articulosMap = new Map<number, { descripcion: string }>();
    const agg = agregarPorArticulo(items, signos, articulosMap);
    expect(agg.get(555)?.detalle).toBe('PRODUCTO DESDE ITEM');
  });
});
