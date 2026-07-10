// ═══════════════════════════════════════════════════════════════════════════
// Rebotes de reparto — LÓGICA PURA de parseo/normalización/matching.
//
// Separado de rebotes.ts (que hace el IO: descarga, Supabase, endpoints)
// porque infomanager.ts hace process.exit(1) al importarse sin env vars y
// eso mata los tests — mismo patrón que recibosImputacion.ts vs recibos.ts.
//
// El sheet "Faltantes de mercaderia" lo carga administración a mano (una
// pestaña por mes: ENERO..DICIEMBRE, columnas FECHA|CLIENTE|VENDEDOR|COD-ART|
// ARTICULO|MOTIVO|CANTIDAD|PRECIO|TOTAL).
//
// Realidades del sheet (verificadas contra el archivo real ene-jul 2026):
//   · motivos con variantes de escritura por mes: "M.C DEPOSITO", "M.C. DEPOSITO",
//     "M.C. DEPOSITO S.", "M.C. DEPOSITO E." → acá se normalizan a un canónico.
//   · fechas con typos (un "7-nov" en la pestaña ENERO): la PESTAÑA manda —
//     se toma el día y se fuerza mes/año de la pestaña.
//   · vendedor por nombre ("BRIAN"/"BRAIAN") → cod_vendedor IM; DARIO ya no
//     está en la empresa → cod_vendedor null (queda como histórico).
//   · cliente por nombre libre sin código → match contra maestro IM con el
//     scoring de nombres del cruce de carpeta (mojibake CP850 incluido).
// ═══════════════════════════════════════════════════════════════════════════
import XLSX from 'xlsx';
import { normalizarNombre, scoreNombres, SHEET_VENDEDOR, UMBRAL_MATCH } from './cruceCarpeta.js';

// Pestañas mensuales del sheet. SETIEMBRE por si lo escriben a la tucumana.
const MES_POR_PESTANA: Record<string, number> = {
  ENERO: 1, FEBRERO: 2, MARZO: 3, ABRIL: 4, MAYO: 5, JUNIO: 6,
  JULIO: 7, AGOSTO: 8, SEPTIEMBRE: 9, SETIEMBRE: 9, OCTUBRE: 10,
  NOVIEMBRE: 11, DICIEMBRE: 12,
};

// ─── Motivos ─────────────────────────────────────────────────────────────────

export type MotivoRebote =
  | 'mc_vendedor' | 'mc_deposito' | 'devolucion' | 'sin_dinero' | 'cerrado'
  | 'falto' | 'sin_stock' | 'error_adm' | 'logistica' | 'error_sistema'
  | 'sin_clasificar';

/**
 * Decisiones de negocio (Mati, 10/07/2026). Las usan las fases 2 y 3;
 * viven acá desde fase 1 para que la clasificación quede documentada
 * junto a la normalización.
 */
export const MOTIVOS_DESCUENTO_VENDEDOR: ReadonlySet<MotivoRebote> = new Set(['mc_vendedor']);
export const MOTIVOS_RECARGO_CLIENTE: ReadonlySet<MotivoRebote> = new Set(['devolucion', 'sin_dinero', 'cerrado']);

/**
 * Normaliza el texto de MOTIVO del sheet al canónico. Tolerante a puntos,
 * espacios, tildes y sufijos ("M.C. DEPOSITO S." → mc_deposito). Lo que no
 * reconoce cae a 'sin_clasificar' (visible en la UI admin, sin cargos).
 */
export function normalizarMotivo(raw: any): MotivoRebote {
  const s = String(raw ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return 'sin_clasificar';
  if (/^M ?C VENDEDOR/.test(s)) return 'mc_vendedor';
  if (/^M ?C DEPOSITO/.test(s)) return 'mc_deposito';
  if (s.startsWith('DEVOLUCION')) return 'devolucion';
  if (s.startsWith('SIN DINERO')) return 'sin_dinero';
  if (s.startsWith('CERRADO')) return 'cerrado';
  if (s.startsWith('FALT')) return 'falto';
  if (s.startsWith('SIN STOCK')) return 'sin_stock';
  if (s.startsWith('ERROR ADM')) return 'error_adm';
  if (s.startsWith('LOGISTICA')) return 'logistica';
  if (s.startsWith('ERROR SIST')) return 'error_sistema';
  return 'sin_clasificar';
}

// ─── Vendedor ────────────────────────────────────────────────────────────────

// Aliases extra sobre el mapa del cruce (SHEET_VENDEDOR): BRAIAN es typo real
// del sheet (pestaña "vendedores" de junio). DARIO fue vendedor y ya no está:
// no se mapea a propósito → cod_vendedor null, queda como histórico.
const VENDEDOR_ALIASES: Record<string, number> = { ...SHEET_VENDEDOR, BRAIAN: 12 };

/** Nombre de vendedor del sheet → cod_vendedor IM, o null si no mapea. */
export function codVendedorRebote(raw: any): number | null {
  const s = String(raw ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().trim();
  if (!s) return null;
  for (const [prefijo, cod] of Object.entries(VENDEDOR_ALIASES)) {
    if (s.startsWith(prefijo)) return cod;
  }
  return null;
}

// ─── Fecha ───────────────────────────────────────────────────────────────────

function pad2(n: number): string { return String(n).padStart(2, '0'); }

function diasEnMes(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const MES_ABREV: Record<string, number> = {
  ENE: 1, FEB: 2, MAR: 3, ABR: 4, MAY: 5, JUN: 6,
  JUL: 7, AGO: 8, SEP: 9, SET: 9, OCT: 10, NOV: 11, DIC: 12,
};

/**
 * Fecha de una celda → ISO YYYY-MM-DD forzada al mes de la PESTAÑA.
 * El sheet tiene typos reales ("7-nov" y "2-feb" en la pestaña ENERO): la
 * pestaña define a qué mes pertenece el rebote (así lo suman los resúmenes
 * del propio sheet), por eso conservamos solo el DÍA y pisamos mes/año.
 * Día inválido para el mes o celda no parseable → null (la fila se ingesta
 * igual, sin fecha).
 */
export function parseFechaRebote(v: any, year: number, month: number): string | null {
  let day: number | null = null;
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Serial Excel (días desde 1899-12-30), rango sano ≈ 1954..2064.
    if (v < 20000 || v > 60000) return null;
    day = new Date(Math.round((v - 25569) * 86400000)).getUTCDate();
  } else if (v instanceof Date && !isNaN(v.getTime())) {
    day = v.getUTCDate();
  } else if (typeof v === 'string') {
    const s = v.trim().toUpperCase();
    // "2-ENE", "7/11", "07-NOV.", "2/1/2026"
    let m = s.match(/^(\d{1,2})[\/-]([A-ZÑ]{3})/);
    if (m && MES_ABREV[m[2]] != null) day = +m[1];
    else {
      m = s.match(/^(\d{1,2})[\/-](\d{1,2})/);
      if (m) day = +m[1];
    }
  }
  if (day == null || day < 1 || day > diasEnMes(year, month)) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

// ─── Números ─────────────────────────────────────────────────────────────────

/**
 * Number directo, o string en formato AR o US — el sheet MEZCLA ambos según
 * el mes (realidad verificada 10/07: ene-may números crudos, JUNIO 1 fila
 * texto y JULIO casi todo texto US "$ 435,420.00"). Regla: si hay coma y
 * punto, el ÚLTIMO separador es el decimal; si hay uno solo, "x,ddd"/"x.ddd"
 * con exactamente 3 dígitos por grupo se lee como MILES.
 *   "$ 5.558,00" → 5558   ·   "$ 435,420.00" → 435420   ·   "1.500" → 1500
 */
export function parseNumeroRebote(v: any): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v * 100) / 100;
  if (typeof v !== 'string') return null;
  let s = v.trim().replace(/\$/g, '').replace(/\s+/g, '');
  if (!s) return null;
  const neg = s.startsWith('-');
  s = s.replace(/^-/, '');
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(/,/g, '.'); // AR: 5.558,00
    else s = s.replace(/,/g, '');                                        // US: 435,420.00
  } else if (lastComma !== -1) {
    if (/^\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, '');           // 435,420 = miles
    else if ((s.match(/,/g) ?? []).length === 1) s = s.replace(',', '.'); // 1234,56 = decimal AR
    else return null;
  } else if (lastDot !== -1) {
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');         // 5.558 = miles AR
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round((neg ? -n : n) * 100) / 100;
}

// ─── Parseo del workbook ─────────────────────────────────────────────────────

export interface RebRow {
  fila: number;
  fecha: string | null;
  fecha_raw: string | null;
  cliente_raw: string;
  cod_cliente: number | null;
  cliente_match_score: number | null;
  vendedor_raw: string | null;
  cod_vendedor: number | null;
  cod_articulo: number | null;
  articulo: string | null;
  motivo_raw: string | null;
  motivo: MotivoRebote;
  cantidad: number | null;
  precio: number | null;
  total: number | null;
}

export interface RebotesMesParseado {
  month: number;
  hoja: string;
  rows: RebRow[];
  descartadas: number;
}

function normHeader(s: any): string {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

const COLUMNAS: Record<string, string[]> = {
  fecha: ['fecha'],
  cliente: ['cliente'],
  vendedor: ['vendedor'],
  cod_articulo: ['cod art', 'cod articulo', 'codart', 'cod'],
  articulo: ['articulo'],
  motivo: ['motivo'],
  cantidad: ['cantidad', 'cant'],
  precio: ['precio'],
  total: ['total'],
};

/**
 * Ubica la fila de headers (la fila 1 de cada pestaña es un título mergeado
 * "FALTANTE DE MERCADERIA <MES> 2026") y mapea campo lógico → índice de columna.
 */
export function buildRebotesFieldIndex(rows: any[][]): { headerRow: number; idx: Record<string, number> } | null {
  for (let r = 0; r < Math.min(rows.length, 5); r++) {
    const headers = (rows[r] || []).map(normHeader);
    if (!headers.includes('fecha') || !headers.includes('cliente')) continue;
    const idx: Record<string, number> = {};
    for (const [campo, aliases] of Object.entries(COLUMNAS)) {
      for (const alias of aliases) {
        const i = headers.indexOf(alias);
        if (i !== -1) { idx[campo] = i; break; }
      }
    }
    if (idx.motivo != null && idx.articulo != null) return { headerRow: r, idx };
  }
  return null;
}

function toStr(v: any): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

/**
 * Parsea todas las pestañas mensuales del workbook. Pura (sin IO) para poder
 * testearla con el sheet real como fixture. El match de cliente contra IM se
 * hace después (matchClientesRebotes) porque necesita el maestro.
 */
export function parseRebotesWorkbook(wb: XLSX.WorkBook, year: number): { meses: RebotesMesParseado[]; warnings: string[] } {
  const meses: RebotesMesParseado[] = [];
  const warnings: string[] = [];
  for (const hoja of wb.SheetNames) {
    const month = MES_POR_PESTANA[hoja.trim().toUpperCase()];
    if (!month) continue; // "vendedores" y cualquier otra pestaña no mensual
    const ws = wb.Sheets[hoja];
    const rows = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, raw: true });
    const fi = buildRebotesFieldIndex(rows);
    if (!fi) { warnings.push(`Pestaña "${hoja}": no encontré la fila de headers (FECHA/CLIENTE/MOTIVO) — pestaña salteada.`); continue; }
    const { headerRow, idx } = fi;
    const get = (r: any[], campo: string): any => (idx[campo] != null ? r[idx[campo]] : null);

    const out: RebRow[] = [];
    let descartadas = 0;
    for (let i = headerRow + 1; i < rows.length; i++) {
      const r: any[] = rows[i] || [];
      const cliente = toStr(get(r, 'cliente'));
      const articulo = toStr(get(r, 'articulo'));
      // Filas de relleno: vacías, resúmenes al pie (sin CLIENTE) y los "#N/A"
      // de fórmulas rotas del sheet. Solo cuentan como descartadas las que
      // tienen ALGO cargado (una fila 100% vacía no es un dato perdido).
      if (!cliente || !articulo || articulo.toUpperCase() === '#N/A') {
        if (r.some(c => toStr(c))) descartadas++;
        continue;
      }
      const cantidad = parseNumeroRebote(get(r, 'cantidad'));
      const precio = parseNumeroRebote(get(r, 'precio'));
      let total = parseNumeroRebote(get(r, 'total'));
      if (total == null && cantidad != null && precio != null) {
        total = Math.round(cantidad * precio * 100) / 100;
      }
      const fechaCell = get(r, 'fecha');
      const vendedorRaw = toStr(get(r, 'vendedor'));
      const motivoRaw = toStr(get(r, 'motivo'));
      out.push({
        fila: i + 1, // 1-based como se ve en Sheets
        fecha: parseFechaRebote(fechaCell, year, month),
        fecha_raw: toStr(fechaCell),
        cliente_raw: cliente,
        cod_cliente: null,
        cliente_match_score: null,
        vendedor_raw: vendedorRaw,
        cod_vendedor: codVendedorRebote(vendedorRaw),
        cod_articulo: (() => { const n = Number(get(r, 'cod_articulo')); return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null; })(),
        articulo,
        motivo_raw: motivoRaw,
        motivo: normalizarMotivo(motivoRaw),
        cantidad, precio, total,
      });
    }
    meses.push({ month, hoja, rows: out, descartadas });
  }
  return { meses, warnings };
}

// ─── Match de clientes contra el maestro IM ──────────────────────────────────

export interface ClienteMaestro { cod_cliente: number; razon_social: string }

/**
 * Completa cod_cliente/score matcheando cliente_raw por similitud de nombre
 * (mismo scoring que el cruce de carpeta: mojibake CP850, iniciales, Dice/
 * Jaccard/containment). Cachea por nombre único: el mismo cliente rebota
 * muchas veces. Umbral = UMBRAL_MATCH (0.66) del cruce, ya validado con
 * nombres reales de estos mismos clientes.
 */
export function matchClientesRebotes(meses: RebotesMesParseado[], maestro: ClienteMaestro[]): void {
  if (!maestro.length) return;
  const cache = new Map<string, { cod: number | null; score: number | null }>();
  const porNorm = new Map<string, number>();
  for (const c of maestro) porNorm.set(normalizarNombre(c.razon_social), c.cod_cliente);

  const matchUno = (raw: string): { cod: number | null; score: number | null } => {
    const norm = normalizarNombre(raw);
    const exacto = porNorm.get(norm);
    if (exacto != null) return { cod: exacto, score: 1 };
    let bestCod: number | null = null;
    let bestScore = 0;
    for (const c of maestro) {
      const s = scoreNombres(raw, c.razon_social);
      if (s > bestScore) { bestScore = s; bestCod = c.cod_cliente; }
    }
    if (bestScore >= UMBRAL_MATCH) return { cod: bestCod, score: Math.round(bestScore * 1000) / 1000 };
    return { cod: null, score: null };
  };

  for (const mes of meses) {
    for (const row of mes.rows) {
      let m = cache.get(row.cliente_raw);
      if (!m) { m = matchUno(row.cliente_raw); cache.set(row.cliente_raw, m); }
      row.cod_cliente = m.cod;
      row.cliente_match_score = m.score;
    }
  }
}

// ─── Cargos del 3% (fases 2 y 3) ─────────────────────────────────────────────

/**
 * Los cargos del 3% rigen desde JULIO 2026 (decisión de Mati 10/07/2026:
 * "empieza a correr desde este mes, los meses anteriores no nos interesan").
 * Los meses previos del sheet quedan como estadística: se ven en el tab
 * Rebotes pero no descuentan comisión ni recargan al cliente.
 */
export const CARGOS_RIGEN_DESDE = { year: 2026, month: 7 } as const;

export function rigenCargosRebotes(year: number, month: number): boolean {
  return year > CARGOS_RIGEN_DESDE.year
    || (year === CARGOS_RIGEN_DESDE.year && month >= CARGOS_RIGEN_DESDE.month);
}

export const PCT_CARGO_REBOTE = 0.03;

export interface DescuentoRebotes {
  /** Suma de TOTAL de los renglones rebotados por error del vendedor. */
  total_rebotado: number;
  /** 3% de total_rebotado — se resta de la comisión del mes. */
  descuento: number;
  renglones: number;
}

/**
 * Agrupa por vendedor el descuento del 3% sobre lo rebotado por su error
 * (motivos en MOTIVOS_DESCUENTO_VENDEDOR). Aplica SIEMPRE, también en
 * devoluciones parciales (decisión de Mati 10/07). asOfDate recorta al día
 * (consistente con el corte de comisiones); los renglones sin fecha cuentan
 * siempre — mejor descontar de más un renglón dudoso que esconderlo.
 * La vigencia (julio 2026+) la chequea el llamador con rigenCargosRebotes.
 */
export function calcDescuentosVendedor(
  rows: Array<{ cod_vendedor: number | null; motivo: string; total: number | null; fecha: string | null }>,
  asOfDate?: string | null,
): Map<number, DescuentoRebotes> {
  const out = new Map<number, DescuentoRebotes>();
  for (const r of rows) {
    if (r.cod_vendedor == null) continue;
    if (!MOTIVOS_DESCUENTO_VENDEDOR.has(r.motivo as MotivoRebote)) continue;
    const total = Number(r.total);
    if (!Number.isFinite(total) || total <= 0) continue;
    if (asOfDate && r.fecha && r.fecha > asOfDate) continue;
    let d = out.get(r.cod_vendedor);
    if (!d) { d = { total_rebotado: 0, descuento: 0, renglones: 0 }; out.set(r.cod_vendedor, d); }
    d.total_rebotado += total;
    d.renglones++;
  }
  for (const d of out.values()) {
    d.total_rebotado = Math.round(d.total_rebotado * 100) / 100;
    d.descuento = Math.round(d.total_rebotado * PCT_CARGO_REBOTE * 100) / 100;
  }
  return out;
}

// ─── Recargo 3% al cliente (fase 3) ──────────────────────────────────────────
//
// Decisión de Mati (10/07/2026, REVISADA): se cobra el 3% de TODO lo que el
// cliente rebota por su culpa (devolucion/sin_dinero/cerrado), sin importar si
// fue el pedido completo o solo una parte. Queda simétrico con el descuento al
// vendedor. (La primera versión cruzaba contra las facturas de IM para cobrar
// solo el pedido completo; esa regla se descartó — ahora se cobra todo.)
//
// Agrupamos los renglones por (cliente, fecha) = "evento" solo para presentar:
// una línea por cliente y día, con el contador de reincidencia del mes. El
// cálculo es puro y NO depende de InfoManager (a diferencia de la v1).

export interface EventoRecargo {
  cod_cliente: number | null;
  cliente_raw: string;
  cod_vendedor: number | null;
  vendedor_raw: string | null;
  fecha: string;
  motivos: MotivoRebote[];
  total_rebotado: number;
  renglones: number;
  /** 3% de total_rebotado — se cobra siempre (regla revisada 10/07). */
  recargo: number;
  /** N° de evento del cliente en el mes (1 = primero): para marcar reincidentes. */
  reincidencia: number;
}

/**
 * Eventos de recargo del mes: renglones rebotados por culpa del cliente
 * (devolucion/sin_dinero/cerrado) agrupados por (cliente, fecha). Cada evento
 * lleva 3% de recargo sobre lo rebotado — SIEMPRE, sea el pedido completo o
 * parcial. Puro y sin dependencia de IM: se calcula solo con los renglones de
 * la tabla rebotes. La vigencia (julio 2026+) la chequea el llamador con
 * rigenCargosRebotes.
 */
export function detectarEventosRecargo(
  rows: Array<{
    cod_cliente: number | null; cliente_raw: string; cod_vendedor: number | null;
    vendedor_raw: string | null; fecha: string | null; motivo: string; total: number | null;
  }>,
): EventoRecargo[] {
  // Agrupar por (cliente, fecha). Sin cod_cliente agrupamos por el nombre
  // crudo; sin fecha usamos '' (igual se cobra, se ve en la lista).
  const grupos = new Map<string, EventoRecargo>();
  for (const r of rows) {
    if (!MOTIVOS_RECARGO_CLIENTE.has(r.motivo as MotivoRebote)) continue;
    const total = Number(r.total);
    if (!Number.isFinite(total) || total <= 0) continue;
    const key = `${r.cod_cliente ?? `raw:${r.cliente_raw}`}|${r.fecha ?? ''}`;
    let ev = grupos.get(key);
    if (!ev) {
      ev = {
        cod_cliente: r.cod_cliente,
        cliente_raw: r.cliente_raw,
        cod_vendedor: r.cod_vendedor,
        vendedor_raw: r.vendedor_raw,
        fecha: r.fecha ?? '',
        motivos: [],
        total_rebotado: 0,
        renglones: 0,
        recargo: 0,
        reincidencia: 1,
      };
      grupos.set(key, ev);
    }
    ev.total_rebotado += total;
    ev.renglones++;
    if (!ev.motivos.includes(r.motivo as MotivoRebote)) ev.motivos.push(r.motivo as MotivoRebote);
  }

  const eventos = [...grupos.values()];
  for (const ev of eventos) {
    ev.total_rebotado = Math.round(ev.total_rebotado * 100) / 100;
    ev.recargo = Math.round(ev.total_rebotado * PCT_CARGO_REBOTE * 100) / 100;
  }

  // Reincidencia por cliente (orden cronológico dentro del mes).
  eventos.sort((a, b) => (a.fecha || '9999') < (b.fecha || '9999') ? -1 : 1);
  const vistos = new Map<string, number>();
  for (const ev of eventos) {
    const k = ev.cod_cliente != null ? String(ev.cod_cliente) : `raw:${ev.cliente_raw}`;
    const n = (vistos.get(k) ?? 0) + 1;
    vistos.set(k, n);
    ev.reincidencia = n;
  }
  // Presentación: más recientes primero.
  eventos.reverse();
  return eventos;
}
