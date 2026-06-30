import { describe, it, expect } from 'vitest';

// Supabase y el cache se importan a nivel módulo en sheetImport.ts pero las
// funciones puras que testeamos (buildFieldIndex / buildMaestroRows) no los usan.
import { vi } from 'vitest';
vi.mock('./supabase.js', () => ({
  sb: vi.fn(),
  TENANT_ID: 'test-tenant',
  hasSupabase: () => true,
}));
vi.mock('./goalsResponseCache.js', () => ({ invalidateAll: vi.fn() }));

import { buildFieldIndex, buildMaestroRows } from './sheetImport.js';

// Header real del Maestro Clientes (hoja "MES ACTUAL", 30/06/2026).
const HEADER = ['Cod', 'Cod Vend', 'vendedor', 'Razon Social', 'Direccion', 'Dia de visita', 'VISITA', 'Frecuencia', 'Localidad', 'HR', 'Repartidor', 'Dia de Entrega', 'Cond Pago', 'Tipo', 'OBJETIVO OK', 'AVANCE', 'Falta'];
const OPTS = { tenantId: 'test-tenant', year: 2026, month: 7, updatedAt: '2026-06-30T00:00:00.000Z' };

// Helper para armar una fila alineada al HEADER.
function row(cod: any, vend: any, razon: string, objetivo: any): any[] {
  const r: any[] = new Array(HEADER.length).fill(null);
  r[0] = cod; r[1] = vend; r[3] = razon; r[14] = objetivo;
  return r;
}

describe('buildFieldIndex', () => {
  it('mapea Cod, Cod Vend y OBJETIVO OK', () => {
    const idx = buildFieldIndex(HEADER);
    expect(idx.cod_cliente).toBe(0);
    expect(idx.cod_vendedor).toBe(1);
    expect(idx.objetivo_mes).toBe(14);
  });
});

describe('buildMaestroRows', () => {
  it('deduplica cod_cliente repetido (incidente 30/06: cod 742 y 1193 cargados 2x)', () => {
    const idx = buildFieldIndex(HEADER);
    const rows = [
      HEADER,
      row(100, 5, 'CLIENTE A', 50000),
      row(742, 12, 'CARDENES, WALTER (ALBERDI)', 1636728),
      row(1193, 3, 'VAZQUEZ CRISTIAN', 373970),
      row(742, 12, 'CARDENES, WALTER (ALBERDI)', 1636728),   // duplicado
      row(1193, 3, 'VAZQUEZ CRISTIAN', 373970),              // duplicado
    ];
    const { out, dupCods, descartadas } = buildMaestroRows(rows, idx, OPTS);

    // 3 clientes únicos, sin filas con la misma clave de conflicto.
    expect(out).toHaveLength(3);
    const cods = out.map(r => r.cod_cliente).sort((a, b) => a - b);
    expect(cods).toEqual([100, 742, 1193]);
    expect(new Set(cods).size).toBe(3);
    expect(dupCods.sort((a, b) => a - b)).toEqual([742, 1193]);
    expect(descartadas).toBe(0);
  });

  it('last-write-wins: se queda con la última aparición del código', () => {
    const idx = buildFieldIndex(HEADER);
    const rows = [
      HEADER,
      row(742, 12, 'NOMBRE VIEJO', 1000),
      row(742, 99, 'NOMBRE NUEVO', 2000),
    ];
    const { out, dupCods } = buildMaestroRows(rows, idx, OPTS);
    expect(out).toHaveLength(1);
    expect(out[0].razon_social).toBe('NOMBRE NUEVO');
    expect(out[0].cod_vendedor).toBe(99);
    expect(out[0].objetivo_mes).toBe(2000);
    expect(dupCods).toEqual([742]);
  });

  it('descarta filas sin código de cliente y cuenta conObjetivo', () => {
    const idx = buildFieldIndex(HEADER);
    const rows = [
      HEADER,
      row(100, 5, 'CON OBJETIVO', 50000),
      row(null, 5, 'SIN COD', 999),     // descartada
      row(200, 5, 'SIN OBJETIVO', null),
    ];
    const { out, descartadas, conObjetivo, dupCods } = buildMaestroRows(rows, idx, OPTS);
    expect(out).toHaveLength(2);
    expect(descartadas).toBe(1);
    expect(conObjetivo).toBe(1);
    expect(dupCods).toEqual([]);
  });

  it('aplica year/month/tenant del request a cada fila', () => {
    const idx = buildFieldIndex(HEADER);
    const { out } = buildMaestroRows([HEADER, row(100, 5, 'A', 1)], idx, OPTS);
    expect(out[0]).toMatchObject({
      tenant_id: 'test-tenant', objetivo_year: 2026, objetivo_month: 7, objetivo_source: 'sheet',
    });
  });
});
