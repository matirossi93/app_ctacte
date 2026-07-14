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
  getCached: vi.fn(() => null),
  setCached: vi.fn(),
  invalidateAll: vi.fn(),
}));

import {
  calcUnidadesPorVendedorArticulo, calcAvancePorGrupo,
  expandirComisionOverrides, validarUpsertGrupo,
} from './productGoals.js';
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

describe('calcAvancePorGrupo — familias suman variedades a la misma meta', () => {
  // Avance por (vendedor:artículo) ya con signo aplicado (la NC de 150 ya restó).
  const ventasPorArt = new Map([
    ['3:150', { unidades: 12, neto: 132372 }],   // Barra Monkey sabor A (Marcelo)
    ['3:151', { unidades: 8, neto: 80000 }],      // Barra Monkey sabor B (Marcelo)
    ['3:152', { unidades: 3, neto: 30000 }],      // Barra Monkey sabor C (Marcelo)
    ['12:150', { unidades: 5, neto: 55000 }],     // sabor A de Brian (otro vendedor)
    ['3:900', { unidades: 4, neto: 40000 }],      // artículo suelto de Marcelo
  ]);

  it('la familia suma las unidades de todas sus variedades de ESE vendedor', () => {
    const out = calcAvancePorGrupo([
      { id: 'monkey', cod_vendedor: 3, articulos: [150, 151, 152] },
    ], ventasPorArt);
    expect(out.get('monkey')).toEqual({ unidades: 23, neto: 242372 }); // 12+8+3, no toma el 5 de Brian
  });

  it('un artículo de la familia sin ventas simplemente no suma', () => {
    const out = calcAvancePorGrupo([
      { id: 'g', cod_vendedor: 3, articulos: [150, 777] }, // 777 no vendió
    ], ventasPorArt);
    expect(out.get('g')).toEqual({ unidades: 12, neto: 132372 });
  });

  it('familia de 1 artículo = el avance de ese artículo', () => {
    const out = calcAvancePorGrupo([
      { id: 'solo', cod_vendedor: 3, articulos: [900] },
    ], ventasPorArt);
    expect(out.get('solo')).toEqual({ unidades: 4, neto: 40000 });
  });

  it('no cruza vendedores: el mismo artículo suma distinto por vendedor', () => {
    const out = calcAvancePorGrupo([
      { id: 'gA', cod_vendedor: 3, articulos: [150] },
      { id: 'gB', cod_vendedor: 12, articulos: [150] },
    ], ventasPorArt);
    expect(out.get('gA')!.unidades).toBe(12);
    expect(out.get('gB')!.unidades).toBe(5);
  });

  it('redondea a 2 decimales (granel)', () => {
    const out = calcAvancePorGrupo(
      [{ id: 'g', cod_vendedor: 3, articulos: [1, 2] }],
      new Map([['3:1', { unidades: 0.1, neto: 1 }], ['3:2', { unidades: 0.2, neto: 1 }]]),
    );
    expect(out.get('g')!.unidades).toBe(0.3);
  });
});

describe('expandirComisionOverrides — la comisión especial rige toda la familia', () => {
  it('cada artículo de la familia hereda el pct de la familia', () => {
    const out = expandirComisionOverrides([
      { cod_vendedor: 3, comision_pct: 0.08, product_goal_articulos: [{ cod_articulo: 150 }, { cod_articulo: 151 }] },
    ]);
    expect(out.get('3:150')).toBe(0.08);
    expect(out.get('3:151')).toBe(0.08);
    expect(out.size).toBe(2);
  });

  it('familias sin pct (o pct inválido) no entran al override', () => {
    const out = expandirComisionOverrides([
      { cod_vendedor: 3, comision_pct: null, product_goal_articulos: [{ cod_articulo: 150 }] },
      { cod_vendedor: 4, comision_pct: 0, product_goal_articulos: [{ cod_articulo: 200 }] },
      { cod_vendedor: 12, comision_pct: 0.05, product_goal_articulos: [{ cod_articulo: 300 }] },
    ]);
    expect(out.has('3:150')).toBe(false);
    expect(out.has('4:200')).toBe(false);
    expect(out.get('12:300')).toBe(0.05);
  });
});

describe('validarUpsertGrupo — saneo del alta/edición', () => {
  const base = { year: 2026, month: 7, cod_vendedor: 3, target_unidades: 20, cod_articulos: [150] };

  it('acepta una familia válida y normaliza', () => {
    const r = validarUpsertGrupo({ ...base, nombre: 'Barras Monkey', cod_articulos: [150, 151], comision_pct: 0.05 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.nombre).toBe('Barras Monkey');
      expect(r.value.codArticulos).toEqual([150, 151]);
      expect(r.value.pct).toBe(0.05);
    }
  });

  it('familia de 1 sin nombre → nombre null (lo completa el catálogo)', () => {
    const r = validarUpsertGrupo({ ...base });
    expect(r.ok && r.value.nombre).toBe(null);
  });

  it('familia de >1 sin nombre → error', () => {
    const r = validarUpsertGrupo({ ...base, cod_articulos: [150, 151] });
    expect(r.ok).toBe(false);
  });

  it('sin artículos → error', () => {
    expect(validarUpsertGrupo({ ...base, cod_articulos: [] }).ok).toBe(false);
  });

  it('deduplica artículos conservando el orden', () => {
    const r = validarUpsertGrupo({ ...base, nombre: 'X', cod_articulos: [151, 150, 151, 150] });
    expect(r.ok && r.value.codArticulos).toEqual([151, 150]);
  });

  it('rechaza vendedor no visible, target ≤ 0 y pct fuera de rango', () => {
    expect(validarUpsertGrupo({ ...base, cod_vendedor: 6 }).ok).toBe(false);   // Andrea backoffice
    expect(validarUpsertGrupo({ ...base, target_unidades: 0 }).ok).toBe(false);
    expect(validarUpsertGrupo({ ...base, comision_pct: 0.5 }).ok).toBe(false); // 50% > tope 20%
  });

  it('comision_pct vacío o null = sin comisión especial (pct null)', () => {
    expect((validarUpsertGrupo({ ...base, comision_pct: '' }) as any).value.pct).toBe(null);
    expect((validarUpsertGrupo({ ...base, comision_pct: null }) as any).value.pct).toBe(null);
  });
});
