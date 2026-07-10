import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';

// rebotesParser.ts importa cruceCarpeta.js (por normalizarNombre/scoreNombres),
// que arrastra infomanager.js (process.exit si falta el secret), supabase.js y
// conciliacion.js. Mockeamos SOLO las hojas con side-effects — mismo patrón
// que cruceCarpeta.test.ts.
vi.mock('./infomanager.js', () => ({
  fetchComprobPendientes: vi.fn(),
  fetchClientesIMCached: vi.fn(),
  fetchVendedores: vi.fn(),
}));
vi.mock('./supabase.js', () => ({
  sb: vi.fn(),
  TENANT_ID: 'test-tenant',
  hasSupabase: () => true,
}));

import {
  normalizarMotivo, codVendedorRebote, parseFechaRebote, parseNumeroRebote,
  buildRebotesFieldIndex, parseRebotesWorkbook, matchClientesRebotes,
  MOTIVOS_DESCUENTO_VENDEDOR, MOTIVOS_RECARGO_CLIENTE,
} from './rebotesParser.js';

// ─── normalizarMotivo: variantes REALES del sheet (cambian por mes) ──────────

describe('normalizarMotivo', () => {
  it('mapea todas las variantes reales de M.C. DEPOSITO', () => {
    expect(normalizarMotivo('M.C DEPOSITO')).toBe('mc_deposito');    // enero
    expect(normalizarMotivo('M.C. DEPOSITO')).toBe('mc_deposito');   // febrero
    expect(normalizarMotivo('M.C. DEPOSITO S.')).toBe('mc_deposito'); // junio
    expect(normalizarMotivo('M.C. DEPOSITO E.')).toBe('mc_deposito'); // junio
  });

  it('mapea variantes de M.C. VENDEDOR (el motivo que descuenta comisión)', () => {
    expect(normalizarMotivo('M.C VENDEDOR')).toBe('mc_vendedor');
    expect(normalizarMotivo('M.C. VENDEDOR')).toBe('mc_vendedor');
    expect(normalizarMotivo('m.c. vendedor ')).toBe('mc_vendedor');
  });

  it('mapea el resto de los motivos conocidos', () => {
    expect(normalizarMotivo('DEVOLUCION')).toBe('devolucion');
    expect(normalizarMotivo('SIN DINERO')).toBe('sin_dinero');
    expect(normalizarMotivo('CERRADO')).toBe('cerrado');
    expect(normalizarMotivo('FALTO')).toBe('falto');
    expect(normalizarMotivo('SIN STOCK')).toBe('sin_stock');
    expect(normalizarMotivo('ERROR ADM.')).toBe('error_adm');
    expect(normalizarMotivo('LOGISTICA')).toBe('logistica');
    expect(normalizarMotivo('ERROR SISTEMA')).toBe('error_sistema');
  });

  it('motivo desconocido o vacío → sin_clasificar (no genera cargos)', () => {
    expect(normalizarMotivo('ROTURA CAMION')).toBe('sin_clasificar');
    expect(normalizarMotivo('')).toBe('sin_clasificar');
    expect(normalizarMotivo(null)).toBe('sin_clasificar');
    expect(normalizarMotivo(undefined)).toBe('sin_clasificar');
  });

  it('las decisiones de negocio quedan fijadas: 3% vendedor solo M.C. VENDEDOR; 3% cliente = devolucion+sin_dinero+cerrado', () => {
    expect([...MOTIVOS_DESCUENTO_VENDEDOR]).toEqual(['mc_vendedor']);
    expect(MOTIVOS_DESCUENTO_VENDEDOR.has(normalizarMotivo('M.C. DEPOSITO S.'))).toBe(false);
    expect([...MOTIVOS_RECARGO_CLIENTE].sort()).toEqual(['cerrado', 'devolucion', 'sin_dinero']);
    expect(MOTIVOS_RECARGO_CLIENTE.has(normalizarMotivo('FALTO'))).toBe(false);
  });
});

// ─── codVendedorRebote ───────────────────────────────────────────────────────

describe('codVendedorRebote', () => {
  it('mapea los vendedores activos por nombre (incluye typo BRAIAN del sheet)', () => {
    expect(codVendedorRebote('BRIAN')).toBe(12);
    expect(codVendedorRebote('BRAIAN')).toBe(12);
    expect(codVendedorRebote('JULIO')).toBe(4);
    expect(codVendedorRebote('MARCELO')).toBe(3);
    expect(codVendedorRebote('SEBASTIAN')).toBe(2);
    expect(codVendedorRebote('Seba')).toBe(2);
  });

  it('DARIO (ex-vendedor, ya no está) y desconocidos → null (histórico, sin impacto)', () => {
    expect(codVendedorRebote('DARIO')).toBe(null);
    expect(codVendedorRebote('')).toBe(null);
    expect(codVendedorRebote(null)).toBe(null);
  });
});

// ─── parseFechaRebote: la PESTAÑA manda sobre la fecha tipeada ───────────────

describe('parseFechaRebote', () => {
  const serial = (iso: string): number => {
    // días desde 1899-12-30 (serial Excel)
    return Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse('1899-12-30T00:00:00Z')) / 86400000);
  };

  it('serial Excel y Date con mes correcto → fecha del día', () => {
    expect(parseFechaRebote(serial('2026-01-02'), 2026, 1)).toBe('2026-01-02');
    expect(parseFechaRebote(new Date(Date.UTC(2026, 0, 15)), 2026, 1)).toBe('2026-01-15');
  });

  it('typo real del sheet: "7-nov" / serial de febrero en la pestaña ENERO → conserva el día, fuerza el mes de la pestaña', () => {
    // en ENERO 2026 el sheet real tiene un 2026-02-02 y un 2026-11-07 tipeados mal
    expect(parseFechaRebote(serial('2026-02-02'), 2026, 1)).toBe('2026-01-02');
    expect(parseFechaRebote(serial('2026-11-07'), 2026, 1)).toBe('2026-01-07');
  });

  it('strings estilo "2-ene" y "7/11"', () => {
    expect(parseFechaRebote('2-ene', 2026, 1)).toBe('2026-01-02');
    expect(parseFechaRebote('7-NOV', 2026, 1)).toBe('2026-01-07');
    expect(parseFechaRebote('12/1', 2026, 1)).toBe('2026-01-12');
  });

  it('día inválido para el mes de la pestaña o basura → null (la fila se ingesta igual)', () => {
    expect(parseFechaRebote('31/2', 2026, 2)).toBe(null);
    expect(parseFechaRebote('xx', 2026, 1)).toBe(null);
    expect(parseFechaRebote(null, 2026, 1)).toBe(null);
    expect(parseFechaRebote(12, 2026, 1)).toBe(null); // serial fuera de rango sano
  });
});

// ─── parseNumeroRebote ───────────────────────────────────────────────────────

describe('parseNumeroRebote', () => {
  it('number directo y string formato AR', () => {
    expect(parseNumeroRebote(16674)).toBe(16674);
    expect(parseNumeroRebote('$ 5.558,00')).toBe(5558);
    expect(parseNumeroRebote('-1.234,50')).toBe(-1234.5);
    expect(parseNumeroRebote('')).toBe(null);
    expect(parseNumeroRebote('N/A')).toBe(null);
  });
});

// ─── Parser del workbook (sintético, replica la estructura real) ─────────────

function wbSintetico(): XLSX.WorkBook {
  const aoa = [
    ['FALTANTE DE MERCADERIA ENERO 2026', null, null, null, null, null, null, null, null],
    ['FECHA', 'CLIENTE', 'VENDEDOR', 'COD-ART', 'ARTICULO', 'MOTIVO ', 'CANTIDAD', 'PRECIO', 'TOTAL'], // "MOTIVO " con espacio: real
    [46024, 'FORRAJERIA HUELLITAS', 'JULIO', 1016, 'ARENA SANITARIA VITAL FUN X6K', 'M.C DEPOSITO', 3, 5558, 16674],
    [46024, 'RENGEL FERNANDO', 'BRIAN', 704, 'AVENA INSTANTANEA', 'DEVOLUCION', 10, 1737, 17370],
    [46029, 'MEJIAS NESTOR', 'DARIO', 470, 'MEZCLA P/PAJARO', 'MOTIVO RARO', 30, 1058, null], // total vacío → cantidad×precio
    [null, null, null, null, '#N/A', null, null, null, 0],       // fila #N/A real → descartada
    [null, null, null, null, null, null, null, 'TOTAL', 5899519], // resumen al pie → descartada
    [null, null, null, null, null, null, null, null, null],       // vacía → ignorada (no cuenta)
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'ENERO');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['CAUSALES REBOTES JULIO']]), 'vendedores');
  return wb;
}

describe('parseRebotesWorkbook', () => {
  it('encuentra headers bajo el título mergeado, extrae filas válidas y saltea pestañas no mensuales', () => {
    const { meses, warnings } = parseRebotesWorkbook(wbSintetico(), 2026);
    expect(warnings).toEqual([]);
    expect(meses).toHaveLength(1); // "vendedores" no es pestaña mensual
    const enero = meses[0];
    expect(enero.month).toBe(1);
    expect(enero.rows).toHaveLength(3);
    expect(enero.descartadas).toBe(2); // #N/A + resumen; la 100% vacía no cuenta

    const [r1, r2, r3] = enero.rows;
    expect(r1.cliente_raw).toBe('FORRAJERIA HUELLITAS');
    expect(r1.cod_vendedor).toBe(4);
    expect(r1.motivo).toBe('mc_deposito');
    expect(r1.cod_articulo).toBe(1016);
    expect(r1.total).toBe(16674);
    expect(r1.fecha).toBe('2026-01-02'); // serial 46024

    expect(r2.cod_vendedor).toBe(12);
    expect(r2.motivo).toBe('devolucion');

    expect(r3.cod_vendedor).toBe(null);          // DARIO → histórico
    expect(r3.motivo).toBe('sin_clasificar');    // motivo desconocido
    expect(r3.total).toBe(31740);                // cantidad × precio
    expect(r3.fila).toBe(5);                     // 1-based como en Sheets
  });

  it('buildRebotesFieldIndex tolera header con espacios y devuelve null si no hay headers', () => {
    expect(buildRebotesFieldIndex([['cualquier', 'cosa'], ['sin', 'headers']])).toBe(null);
    const fi = buildRebotesFieldIndex([
      ['TITULO'],
      ['FECHA', 'CLIENTE', 'VENDEDOR', 'COD-ART', 'ARTICULO', 'MOTIVO ', 'CANTIDAD', 'PRECIO', 'TOTAL'],
    ]);
    expect(fi?.headerRow).toBe(1);
    expect(fi?.idx.motivo).toBe(5);
    expect(fi?.idx.cod_articulo).toBe(3);
  });
});

// ─── Matching de clientes contra maestro IM ──────────────────────────────────

describe('matchClientesRebotes', () => {
  const maestro = [
    { cod_cliente: 100, razon_social: 'FORRAJERIA HUELLITAS' },
    { cod_cliente: 200, razon_social: 'DIAZ ALFREDO' },
    { cod_cliente: 300, razon_social: 'SUPER DEYUV' },
  ];

  const mesCon = (clientes: string[]) => [{
    month: 1, hoja: 'ENERO', descartadas: 0,
    rows: clientes.map((c, i) => ({
      fila: i + 3, fecha: null, fecha_raw: null, cliente_raw: c,
      cod_cliente: null as number | null, cliente_match_score: null as number | null,
      vendedor_raw: 'JULIO', cod_vendedor: 4, cod_articulo: 1, articulo: 'X',
      motivo_raw: 'DEVOLUCION', motivo: 'devolucion' as const, cantidad: 1, precio: 1, total: 1,
    })),
  }];

  it('exacto, fuzzy sobre umbral y sin-match', () => {
    const meses = mesCon(['FORRAJERIA HUELLITAS', 'ALFREDO DIAZ', 'ZZZZZ WWWW QQQQ']);
    matchClientesRebotes(meses, maestro);
    const [exacto, fuzzy, nada] = meses[0].rows;
    expect(exacto.cod_cliente).toBe(100);
    expect(exacto.cliente_match_score).toBe(1);
    expect(fuzzy.cod_cliente).toBe(200);         // tokens invertidos: Jaccard = 1
    expect(nada.cod_cliente).toBe(null);
    expect(nada.cliente_match_score).toBe(null);
  });

  it('maestro vacío → no toca nada', () => {
    const meses = mesCon(['FORRAJERIA HUELLITAS']);
    matchClientesRebotes(meses, []);
    expect(meses[0].rows[0].cod_cliente).toBe(null);
  });
});

// ─── Validación contra el sheet REAL (fixture ene-jul 2026) ──────────────────
// Perfilado con openpyxl el 10/07/2026: conteos por pestaña y por motivo.
// Si administración cambia el formato del sheet, este test avisa antes que
// el cron de producción.

const FIXTURE = path.resolve(process.cwd(), 'docs/validacion-rebotes-2026/faltantes_2026-07-10.xlsx');

describe.skipIf(!fs.existsSync(FIXTURE))('parseRebotesWorkbook · sheet real ene-jul 2026', () => {
  const wb = XLSX.read(fs.readFileSync(FIXTURE), { type: 'buffer' });
  const { meses, warnings } = parseRebotesWorkbook(wb, 2026);

  it('7 pestañas mensuales, sin warnings, conteos exactos del perfilado', () => {
    expect(warnings).toEqual([]);
    expect(meses.map(m => m.month)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const filas = Object.fromEntries(meses.map(m => [m.hoja, m.rows.length]));
    expect(filas).toEqual({
      ENERO: 95, FEBRERO: 182, MARZO: 160, ABRIL: 145, MAYO: 167, JUNIO: 163, JULIO: 29,
    });
  });

  it('normaliza las variantes de motivo de JUNIO (M.C. DEPOSITO S./E., LOGISTICA)', () => {
    const junio = meses.find(m => m.month === 6)!;
    const conteo: Record<string, number> = {};
    for (const r of junio.rows) conteo[r.motivo] = (conteo[r.motivo] ?? 0) + 1;
    expect(conteo).toEqual({
      devolucion: 57, sin_dinero: 44, mc_vendedor: 21, logistica: 13, mc_deposito: 16, cerrado: 12,
    });
    expect(junio.rows.every(r => r.motivo !== 'sin_clasificar')).toBe(true);
  });

  it('todas las fechas quedan dentro del mes de su pestaña (o null), incluso los typos', () => {
    for (const mes of meses) {
      for (const r of mes.rows) {
        if (r.fecha == null) continue;
        expect(r.fecha.slice(0, 7)).toBe(`2026-${String(mes.month).padStart(2, '0')}`);
      }
    }
  });

  it('todo vendedor ESCRITO mapea a un cod; solo quedan null las celdas vacías (2 filas reales de FEBRERO)', () => {
    const sinMapear: string[] = [];
    const celdaVacia: string[] = [];
    for (const mes of meses) {
      for (const r of mes.rows) {
        if (r.cod_vendedor != null) continue;
        if (r.vendedor_raw) sinMapear.push(`${mes.hoja}:${r.fila}:${r.vendedor_raw}`);
        else celdaVacia.push(`${mes.hoja}:${r.fila}`);
      }
    }
    // Un nombre nuevo sin mapear = vendedor nuevo o typo nuevo → agregar a
    // VENDEDOR_ALIASES en rebotesParser.ts.
    expect(sinMapear).toEqual([]);
    // GUERRA JAVIER y SOTO SERGIO (27/02): cargados sin vendedor en el sheet.
    expect(celdaVacia).toEqual(['FEBRERO:162', 'FEBRERO:163']);
  });
});
