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

import { buildFieldIndex, buildMaestroRows, bufferDeDescargaSheet, plazosDeCuentaCorriente, completarPlazosFaltantes } from './sheetImport.js';

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

// Traer el Maestro directo del sheet (sin subir el XLSX a mano).
describe('bufferDeDescargaSheet', () => {
  it('rechaza el HTML de login que Google manda con 200 cuando el sheet no es público', () => {
    // Google no contesta 401: devuelve la pantalla de login con status 200. Sin
    // este chequeo el XLSX.read explota con "Unsupported file" y el error no se
    // ata al permiso del sheet.
    const html = Buffer.from('<!DOCTYPE html><html><head><title>Iniciar sesión</title>');
    expect(() => bufferDeDescargaSheet('text/html; charset=utf-8', html))
      .toThrow(/no está compartido públicamente/);
  });

  it('devuelve el buffer cuando Google manda el XLSX', () => {
    const xlsx = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);   // 'PK\x03\x04' = zip/xlsx
    const buf = bufferDeDescargaSheet(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      xlsx,
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect([...buf]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });
});

// Plazo de cta cte leído de la hoja BASE DE DATOS (la fuente de Amira).
// Header real de esa pestaña (gid 2120998313, 16/09/2026).
const HEADER_PLAZOS = ['Cod', 'Cod Vend', 'vendedor', 'Razon Social', 'Direccion', 'Dia de visita', 'VISITA', 'COD PAGO', 'Frecuencia', 'Localidad', 'HR', 'Repartidor', 'Dia de Entrega', 'Cond Pago', 'Tipo', ' Facturacion Promedio 3 meses'];
function filaPlazo(cod: any, visita: any, condPago: any, frecuencia: any = 'SEMANAL'): any[] {
  const r: any[] = new Array(HEADER_PLAZOS.length).fill(null);
  r[0] = cod; r[6] = visita; r[8] = frecuencia; r[13] = condPago;
  return r;
}

describe('plazosDeCuentaCorriente', () => {
  it('toma VISITA 7/15 sólo de los clientes de cuenta corriente', () => {
    const plazos = plazosDeCuentaCorriente([
      HEADER_PLAZOS,
      filaPlazo(34, '7', 'cc'),
      filaPlazo(2, '15', 'cc'),
      filaPlazo(99, '7', 'CONTADO'),    // no es cta cte → afuera
      filaPlazo(421, '', 'cc'),         // cta cte sin plazo → afuera
      filaPlazo(500, '30', 'cc'),       // valor que no es plazo pactado → afuera
    ]);
    expect(plazos.get(34)).toBe('7');
    expect(plazos.get(2)).toBe('15');
    expect(plazos.size).toBe(2);
  });

  it('acepta las variantes de Cond Pago que usaba el script de cobranzas', () => {
    const plazos = plazosDeCuentaCorriente([
      HEADER_PLAZOS,
      filaPlazo(1, '7', 'Cuenta Cte'),
      filaPlazo(2, '7', 'CTA CTE'),
      filaPlazo(3, '7', ' cuenta corriente '),
    ]);
    expect([...plazos.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it('normaliza el 7.0 que sale cuando la celda viene como número', () => {
    const plazos = plazosDeCuentaCorriente([HEADER_PLAZOS, filaPlazo(34, '7.0', 'cc'), filaPlazo(35, 7, 'cc')]);
    expect(plazos.get(34)).toBe('7');
    expect(plazos.get(35)).toBe('7');
  });

  it('NO usa Frecuencia como plazo (incidente 02/07: 6 avisos de cobranza indebidos)', () => {
    // Cliente SEMANAL pero sin VISITA: no tiene plazo pactado, no entra.
    const plazos = plazosDeCuentaCorriente([HEADER_PLAZOS, filaPlazo(77, '', 'cc', 'SEMANAL')]);
    expect(plazos.size).toBe(0);
  });

  it('devuelve vacío si la hoja no tiene las columnas esperadas', () => {
    expect(plazosDeCuentaCorriente([['Cod', 'Razon Social'], [34, 'AMADO GRACIELA']]).size).toBe(0);
  });
});

describe('completarPlazosFaltantes', () => {
  it('completa sólo las filas sin plazo y no pisa las que ya lo traen', () => {
    const out = [
      { cod_cliente: 34, visita: null },     // BASE DE DATOS dice 7 → se completa
      { cod_cliente: 2, visita: '15' },      // ya tiene → no se toca
      { cod_cliente: 99, visita: null },     // no está en la hoja de plazos → queda sin plazo
    ];
    const plazos = new Map([[34, '7'], [2, '7']]);
    expect(completarPlazosFaltantes(out, plazos)).toBe(1);
    expect(out[0].visita).toBe('7');
    expect(out[1].visita).toBe('15');
    expect(out[2].visita).toBeNull();
  });
});
