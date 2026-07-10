import { describe, it, expect, vi } from 'vitest';

// productGoals.ts arrastra módulos con side-effects (infomanager hace
// process.exit sin env; snapshotCache/comisionOverrides dependen de ellos).
// Mockeamos SOLO esas hojas — mismo patrón que cruceCarpeta/rebotes.test.ts.
vi.mock('./infomanager.js', () => ({
  fetchArticulosCatalogo: vi.fn(),
}));
vi.mock('./supabase.js', () => ({
  sb: vi.fn(),
  TENANT_ID: 'test-tenant',
  hasSupabase: () => true,
}));
vi.mock('./snapshotCache.js', () => ({
  getMonthlyVentasRaw: vi.fn(),
  getMonthlyItemsRaw: vi.fn(),
}));
vi.mock('./comisionOverrides.js', () => ({
  loadVendedorOverrides: vi.fn(),
  resolveCodVendedor: vi.fn(),
}));
vi.mock('./goalsResponseCache.js', () => ({
  invalidateAll: vi.fn(),
}));

import { calcUnidadesPorVendedorArticulo } from './productGoals.js';
import { clasificarCabeceraComision } from './comisionesShared.js';

describe('clasificarCabeceraComision (compartida comisiones + objetivos producto)', () => {
  it('FA/FB suman, NC resta, ND/PR/anuladas no cuentan', () => {
    expect(clasificarCabeceraComision({ tipo: 'FA' })).toBe('FA');
    expect(clasificarCabeceraComision({ tipo_comprobante: 'FB' })).toBe('FA');
    expect(clasificarCabeceraComision({ tipo: 'NC' })).toBe('NC');
    expect(clasificarCabeceraComision({ tipo: 'ND' })).toBe(null);
    expect(clasificarCabeceraComision({ tipo: 'PR' })).toBe(null);
    expect(clasificarCabeceraComision({ tipo: 'FA', anulada: 'S' })).toBe(null);
  });
});

describe('calcUnidadesPorVendedorArticulo — avance de objetivos por producto', () => {
  const cabs = new Map<number, { sign: 1 | -1; cod_vendedor: number }>([
    [10, { sign: 1, cod_vendedor: 3 }],   // FA de Marcelo
    [11, { sign: 1, cod_vendedor: 3 }],   // otra FA de Marcelo
    [20, { sign: -1, cod_vendedor: 3 }],  // NC de Marcelo
    [30, { sign: 1, cod_vendedor: 12 }],  // FA de Brian
  ]);

  it('suma unidades por vendedor+artículo con signo (la NC resta el avance)', () => {
    const out = calcUnidadesPorVendedorArticulo(cabs, [
      { id_comprobante: 10, cod_articulo: 150, cantidad: 10, importe: 110310 },
      { id_comprobante: 11, cod_articulo: 150, cantidad: 5, importe: 55155 },
      { id_comprobante: 20, cod_articulo: 150, cantidad: 3, importe: 33093 },  // devolución facturada
      { id_comprobante: 30, cod_articulo: 150, cantidad: 7, importe: 77217 },
      { id_comprobante: 10, cod_articulo: 999, cantidad: 2, importe: 5000 },
    ]);
    expect(out.get('3:150')).toEqual({ unidades: 12, neto: 132372 }); // 10+5−3
    expect(out.get('12:150')).toEqual({ unidades: 7, neto: 77217 });
    expect(out.get('3:999')).toEqual({ unidades: 2, neto: 5000 });
  });

  it('ignora items sin cabecera válida (PR/ND/anuladas quedaron fuera del map)', () => {
    const out = calcUnidadesPorVendedorArticulo(cabs, [
      { id_comprobante: 555, cod_articulo: 150, cantidad: 100, importe: 1 },
    ]);
    expect(out.size).toBe(0);
  });

  it('soloKeys limita el agregado a los pares con objetivo', () => {
    const out = calcUnidadesPorVendedorArticulo(cabs, [
      { id_comprobante: 10, cod_articulo: 150, cantidad: 10, importe: 1 },
      { id_comprobante: 10, cod_articulo: 999, cantidad: 2, importe: 1 },
    ], new Set(['3:150']));
    expect(out.has('3:150')).toBe(true);
    expect(out.has('3:999')).toBe(false);
  });

  it('cantidades decimales (granel) redondean a 2 decimales', () => {
    const out = calcUnidadesPorVendedorArticulo(cabs, [
      { id_comprobante: 10, cod_articulo: 150, cantidad: 0.1, importe: 1 },
      { id_comprobante: 11, cod_articulo: 150, cantidad: 0.2, importe: 1 },
    ]);
    expect(out.get('3:150')!.unidades).toBe(0.3);
  });
});
