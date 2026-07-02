import * as XLSX from 'xlsx';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { fetchClientesIMCached } from './infomanager.js';
import { COD_CLIENTES_INTERNOS } from './comisionesShared.js';
import {
  clasificarRecibos, fetchPendientesCached, fetchRecibosTransito,
  getSnapshotRows, guardarSnapshotConciliacion, hoyISOArgentina,
  type PendienteIM, type ClienteMaestro, type ReciboTransito,
} from './conciliacion.js';
import type { JwtPayload } from './auth.js';

// ═══════════════════════════════════════════════════════════════════════════
// Cruce carpeta vs sistema — motor del "Cruce carpeta" del panel Conciliación
//
// El proceso mensual real de Mati es CARPETA FÍSICA del vendedor (transcripta
// a un Google Sheet) vs InfoManager. Esto lo automatiza: parsea el .xlsx del
// Sheet (una pestaña por vendedor), lo cruza contra la cta cte IM A UNA FECHA
// DE CORTE (snapshot exacto si existe, foto viva aproximada si no) y matchea
// clientes por similitud de nombre con asignación best-first global.
// Algoritmo portado del cruce manual de junio 2026 (validado contra casos
// reales: DANTE/DONET, MONTERO cross-vendedor, SARACHO fecha typo).
// ═══════════════════════════════════════════════════════════════════════════

/** Pestaña del Sheet → cod_vendedor IM. Matching case-insensitive por prefijo. */
export const SHEET_VENDEDOR: Record<string, number> = {
  JULIO: 4,
  MARCELO: 3,
  SEBA: 2,     // matchea también "SEBASTIAN"
  BRIAN: 12,
  ANDREA: 6,   // mostrador — matches siempre tentativos (nombres de pila)
};

const PESTANA_POR_COD: Record<number, string> = Object.fromEntries(
  Object.entries(SHEET_VENDEDOR).map(([k, v]) => [v, k]),
);

/** Score mínimo para considerar match dentro del vendedor. */
export const UMBRAL_MATCH = 0.66;
/** Score mínimo (más exigente) para sugerir contraparte en OTRO vendedor. */
export const UMBRAL_CROSS_VENDEDOR = 0.82;
/** Diferencia carpeta-sistema tolerada como "CUADRA" (residuos de centavos IM). */
export const TOLERANCIA_DEFAULT = 20;

/** Ruido de centavos del lado sistema (mismo criterio que el panel en vivo). */
const UMBRAL_RUIDO = 1;

function r2(n: number): number { return Math.round(n * 100) / 100; }
function pad2(n: number): string { return String(n).padStart(2, '0'); }

// ─── Normalización y scoring de nombres ──────────────────────────────────────

/**
 * Normaliza un nombre para comparar: quita texto entre paréntesis (zona),
 * comas, acentos/ñ (NFD + strip de diacríticos), uppercase, solo [A-Z0-9 ],
 * espacios colapsados.
 */
export function normalizarNombre(s: string): string {
  return String(s ?? '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/,/g, ' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Dice coefficient de bigramas (multiset) — equivalente práctico de difflib.ratio. */
function diceBigramas(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const mapA = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const bg = a.slice(i, i + 2);
    mapA.set(bg, (mapA.get(bg) ?? 0) + 1);
  }
  let inter = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bg = b.slice(i, i + 2);
    const c = mapA.get(bg) ?? 0;
    if (c > 0) { inter++; mapA.set(bg, c - 1); }
  }
  return (2 * inter) / (a.length - 1 + b.length - 1);
}

/** Jaccard de tokens (solo tokens con len>1 — ignora iniciales sueltas). */
function jaccardTokens(A: string[], B: string[]): number {
  if (!A.length || !B.length) return 0;
  const sa = new Set(A);
  const sb2 = new Set(B);
  let inter = 0;
  for (const t of sa) if (sb2.has(t)) inter++;
  const uni = new Set([...sa, ...sb2]).size;
  return uni === 0 ? 0 : inter / uni;
}

/** Containment: qué fracción de los tokens del nombre más corto está en el otro. */
function containmentTokens(A: string[], B: string[]): number {
  if (!A.length || !B.length) return 0;
  const [corto, largo] = A.length <= B.length ? [A, B] : [B, A];
  const setLargo = new Set(largo);
  const hits = corto.filter(t => setLargo.has(t)).length;
  return hits / corto.length;
}

/**
 * Score de similitud entre un nombre de carpeta y uno del sistema:
 * max(Dice de bigramas, Jaccard de tokens, containment × 0.95).
 */
export function scoreNombres(a: string, b: string): number {
  const na = normalizarNombre(a);
  const nb = normalizarNombre(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = na.split(' ').filter(t => t.length > 1);
  const tb = nb.split(' ').filter(t => t.length > 1);
  return Math.max(
    diceBigramas(na, nb),
    jaccardTokens(ta, tb),
    containmentTokens(ta, tb) * 0.95,
  );
}

// ─── Parseo del Sheet de carpeta ─────────────────────────────────────────────

/**
 * Fecha de una celda de la carpeta → ISO YYYY-MM-DD, o null si no parseable.
 * Realidades del archivo de junio: datetime serial de Excel (number), Date,
 * strings dd/mm/yyyy, dd/mm/yy, dd/mm (asume el año del corte) y basura con
 * typos tipo "2✱/05" con asterisco (→ null → la fila va a `sin_fecha` pero SE
 * INCLUYE en el cruce).
 */
export function parseFechaCarpeta(v: any, anioDefault: number): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Serial Excel (días desde 1899-12-30). Rango sano ≈ 1954..2064.
    if (v < 20000 || v > 60000) return null;
    return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  }
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === 'string') {
    const s = v.trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${pad2(+m[2])}-${pad2(+m[3])}`;
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (m) {
      const d = +m[1], mo = +m[2];
      let y = +m[3];
      if (y < 100) y += 2000;
      if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) return `${y}-${pad2(mo)}-${pad2(d)}`;
      return null;
    }
    m = s.match(/^(\d{1,2})\/(\d{1,2})$/);
    if (m) {
      const d = +m[1], mo = +m[2];
      if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) return `${anioDefault}-${pad2(mo)}-${pad2(d)}`;
      return null;
    }
  }
  return null;
}

/** Monto de celda: number directo o string estilo AR ('$ 1.234,56', '1234.5'). */
export function parseMontoCarpeta(v: any): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return null;
  let s = v.trim().replace(/\$/g, '').replace(/\s+/g, '');
  if (!s) return null;
  const neg = s.startsWith('-') || /^\(.*\)$/.test(s);
  s = s.replace(/^[-(]+/, '').replace(/\)+$/, '');
  if (s.includes(',')) {
    // Formato AR: puntos = miles, coma = decimal
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    const puntos = (s.match(/\./g) ?? []).length;
    if (puntos > 1) s = s.replace(/\./g, '');
    else if (puntos === 1 && s.split('.')[1].length === 3) s = s.replace('.', ''); // 1.234 = miles
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

export interface ClienteCarpeta { nombre: string; saldo: number; n_filas: number }
export interface FilaExcluida { vendedor: string; fila: number; fecha: string; cliente: string; monto: number }
export interface FilaSinFecha { vendedor: string; fila: number; cliente: string; monto: number; valor_fecha: string }

export interface CarpetaParseada {
  vendedores: Array<{ pestana: string; cod_vendedor: number; clientes: ClienteCarpeta[] }>;
  excluidas_por_fecha: FilaExcluida[];
  sin_fecha: FilaSinFecha[];
  pestanas_ignoradas: string[];
}

/** Nombre de pestaña → clave de vendedor (case-insensitive, prefijo, tolera extras). */
function vendedorDePestana(sheetName: string): string | null {
  const norm = normalizarNombre(sheetName);
  for (const key of Object.keys(SHEET_VENDEDOR)) {
    if (norm === key || norm.startsWith(key)) return key;
  }
  return null;
}

/**
 * Parsea el workbook de la carpeta. Por pestaña de vendedor: fila 1 título,
 * fila 2 headers, desde fila 3 datos FECHA|CLIENTE|SALDO (cols A/B/C). Un
 * cliente puede tener VARIAS filas (comprobantes) → se SUMAN. Filas vacías se
 * saltean. Filas con fecha > corte se EXCLUYEN del cruce (van a
 * `excluidas_por_fecha` — caso real SARACHO 21/11/2026 typo). Filas sin fecha
 * parseable SE INCLUYEN pero se listan en `sin_fecha`.
 */
export function parseCarpeta(wb: XLSX.WorkBook, corte: string): CarpetaParseada {
  const anioCorte = Number(corte.slice(0, 4));
  const out: CarpetaParseada = { vendedores: [], excluidas_por_fecha: [], sin_fecha: [], pestanas_ignoradas: [] };

  for (const sheetName of wb.SheetNames) {
    const key = vendedorDePestana(sheetName);
    if (!key) { out.pestanas_ignoradas.push(sheetName); continue; }

    const ws = wb.Sheets[sheetName];
    const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
    const clientes = new Map<string, ClienteCarpeta>();

    for (let i = 2; i < rows.length; i++) { // desde fila 3 (índice 2)
      const row = rows[i] ?? [];
      const rawFecha = row[0];
      const cliente = row[1] == null ? '' : String(row[1]).trim();
      const monto = parseMontoCarpeta(row[2]);
      if (!cliente || monto == null) continue; // fila vacía/incompleta intercalada

      const filaNum = i + 1; // 1-based, como se ve en el Sheet
      const fecha = parseFechaCarpeta(rawFecha, anioCorte);
      if (fecha == null) {
        // Sin fecha parseable: INCLUIR en el cruce pero avisar.
        out.sin_fecha.push({
          vendedor: key, fila: filaNum, cliente, monto,
          valor_fecha: rawFecha == null ? '' : String(rawFecha),
        });
      } else if (fecha > corte) {
        // Posterior al corte: EXCLUIR del cruce pero listar (puede ser typo).
        out.excluidas_por_fecha.push({ vendedor: key, fila: filaNum, fecha, cliente, monto });
        continue;
      }

      const nkey = normalizarNombre(cliente);
      if (!nkey) continue;
      const prev = clientes.get(nkey);
      if (prev) { prev.saldo = r2(prev.saldo + monto); prev.n_filas += 1; }
      else clientes.set(nkey, { nombre: cliente, saldo: r2(monto), n_filas: 1 });
    }

    out.vendedores.push({ pestana: sheetName, cod_vendedor: SHEET_VENDEDOR[key], clientes: [...clientes.values()] });
  }
  return out;
}

// ─── Lado sistema ────────────────────────────────────────────────────────────

/**
 * Resuelve las filas del lado sistema para el corte:
 *  - hay snapshot de esa fecha → corte EXACTO;
 *  - no hay → reporte vivo filtrando comprobantes con fecha_factura > corte,
 *    corte APROXIMADO con advertencia (los pagos posteriores al corte ya
 *    están aplicados a los saldos de la foto actual).
 */
export function resolverLadoSistema(
  snapshotRows: PendienteIM[] | null,
  vivoRows: PendienteIM[],
  corte: string,
): { rows: PendienteIM[]; corte_exacto: boolean; advertencia: string | null } {
  if (snapshotRows) return { rows: snapshotRows, corte_exacto: true, advertencia: null };
  const rows = vivoRows.filter(r => !r.fecha_factura || String(r.fecha_factura).slice(0, 10) <= corte);
  return {
    rows,
    corte_exacto: false,
    advertencia: 'Sin snapshot para esa fecha: se usa la foto ACTUAL de IM aproximada al corte. Los comprobantes posteriores al corte se excluyen, pero los pagos posteriores YA están aplicados a los saldos.',
  };
}

export interface ClienteSistema {
  cod_cliente: number;
  nombre: string;
  saldo: number;
  cod_vendedor: number | null;
}

interface SistemaArmado {
  porVendedor: Map<number, ClienteSistema[]>;
  todos: ClienteSistema[];
  internas: Array<{ cod_cliente: number; nombre: string; saldo: number }>;
}

/**
 * Agrupa las filas IM por cliente (SUM saldo — misma regla que el panel),
 * asigna vendedor por MAESTRO y separa internas. Filtra |saldo| < $1 (ruido).
 * `todos` incluye también clientes de vendedores fuera de las 5 pestañas
 * (p/ búsqueda cross-vendedor), pero esos no participan del cruce por grupo.
 */
function armarSistema(rows: PendienteIM[], maestro: ClienteMaestro[]): SistemaArmado {
  const maestroMap = new Map<number, ClienteMaestro>();
  for (const c of maestro) maestroMap.set(Number(c.cod_cliente), c);

  const porCliente = new Map<number, { nombre: string; saldo: number }>();
  for (const row of rows) {
    const cod = Number(row.cod_cliente);
    if (!Number.isFinite(cod)) continue;
    const prev = porCliente.get(cod);
    const saldo = Number(row.saldo) || 0;
    if (prev) prev.saldo = r2(prev.saldo + saldo);
    else porCliente.set(cod, { nombre: String(row.nombre ?? '').trim(), saldo: r2(saldo) });
  }

  const out: SistemaArmado = { porVendedor: new Map(), todos: [], internas: [] };
  for (const [cod, agg] of porCliente) {
    const m = maestroMap.get(cod);
    const nombre = String(m?.razon_social || agg.nombre || `Cliente ${cod}`).trim();
    if (COD_CLIENTES_INTERNOS.has(cod)) {
      out.internas.push({ cod_cliente: cod, nombre, saldo: agg.saldo });
      continue;
    }
    if (Math.abs(agg.saldo) < UMBRAL_RUIDO) continue;
    const codVend = m?.cod_vendedor != null && Number.isFinite(Number(m.cod_vendedor)) ? Number(m.cod_vendedor) : null;
    const cli: ClienteSistema = { cod_cliente: cod, nombre, saldo: agg.saldo, cod_vendedor: codVend };
    out.todos.push(cli);
    if (codVend != null && PESTANA_POR_COD[codVend]) {
      const arr = out.porVendedor.get(codVend);
      if (arr) arr.push(cli); else out.porVendedor.set(codVend, [cli]);
    }
  }
  out.internas.sort((a, b) => Math.abs(b.saldo) - Math.abs(a.saldo));
  return out;
}

// ─── Matching best-first ─────────────────────────────────────────────────────

export interface TransitoAlCorte { monto: number; fecha: string | null; status: string }

export interface MatchCruce {
  carpeta: string;
  sistema: string;
  cod_cliente: number;
  saldo_carpeta: number;
  saldo_sistema: number;
  dif: number;
  score: number;
  estado: 'CUADRA' | 'DIFERENCIA';
  tentativo?: boolean;
  /** Recibos en tránsito en la app con fecha ≤ corte: explican diferencias. */
  transito_al_corte?: TransitoAlCorte[];
}

export interface SoloCarpeta {
  cliente: string;
  saldo: number;
  /** Contraparte probable bajo OTRO vendedor (score ≥ 0.82) — caso MONTERO. */
  cross_vendedor?: { cod_cliente: number; nombre: string; saldo: number; vendedor: string; score: number };
}

export interface CruceVendedor {
  pestana: string;
  cod_vendedor: number;
  tentativo: boolean;
  total_carpeta: number;
  total_sistema: number;
  n_cuadra: number;
  n_diferencia: number;
  matches: MatchCruce[];
  solo_carpeta: SoloCarpeta[];
  solo_sistema: ClienteSistema[];
}

/**
 * Matching de UN vendedor con asignación BEST-FIRST GLOBAL: se generan todos
 * los pares con score ≥ 0.66, se ordenan por score desc y se asignan greedy
 * sin repetir ninguno de los dos lados. Esto evita que un match débil robe el
 * lugar de uno perfecto (bug real de junio: DANTE se comía a DONET).
 */
export function cruzarVendedor(
  carpeta: ClienteCarpeta[],
  sistema: ClienteSistema[],
  tolerancia: number,
  tentativo: boolean,
): { matches: MatchCruce[]; solo_carpeta: SoloCarpeta[]; solo_sistema: ClienteSistema[] } {
  const pares: Array<{ i: number; j: number; score: number }> = [];
  for (let i = 0; i < carpeta.length; i++) {
    for (let j = 0; j < sistema.length; j++) {
      const score = scoreNombres(carpeta[i].nombre, sistema[j].nombre);
      if (score >= UMBRAL_MATCH) pares.push({ i, j, score });
    }
  }
  pares.sort((a, b) => b.score - a.score);

  const usadoC = new Set<number>();
  const usadoS = new Set<number>();
  const matches: MatchCruce[] = [];
  for (const p of pares) {
    if (usadoC.has(p.i) || usadoS.has(p.j)) continue;
    usadoC.add(p.i);
    usadoS.add(p.j);
    const c = carpeta[p.i];
    const s = sistema[p.j];
    const dif = r2(c.saldo - s.saldo);
    matches.push({
      carpeta: c.nombre,
      sistema: s.nombre,
      cod_cliente: s.cod_cliente,
      saldo_carpeta: c.saldo,
      saldo_sistema: s.saldo,
      dif,
      score: Math.round(p.score * 1000) / 1000,
      estado: Math.abs(dif) <= tolerancia ? 'CUADRA' : 'DIFERENCIA',
      ...(tentativo ? { tentativo: true } : {}),
    });
  }
  matches.sort((a, b) => Math.abs(b.dif) - Math.abs(a.dif));

  const solo_carpeta: SoloCarpeta[] = carpeta
    .filter((_, i) => !usadoC.has(i))
    .map(c => ({ cliente: c.nombre, saldo: c.saldo }));
  const solo_sistema = sistema
    .filter((_, j) => !usadoS.has(j))
    .sort((a, b) => Math.abs(b.saldo) - Math.abs(a.saldo));
  return { matches, solo_carpeta, solo_sistema };
}

// ─── Cruce completo (función pura integradora) ───────────────────────────────

export interface ResultadoCruce {
  corte: string;
  tolerancia: number;
  corte_exacto: boolean;
  advertencia: string | null;
  vendedores: CruceVendedor[];
  internas: Array<{ cod_cliente: number; nombre: string; saldo: number }>;
  excluidas_por_fecha: FilaExcluida[];
  sin_fecha: FilaSinFecha[];
  pestanas_ignoradas: string[];
  totales: {
    carpeta: number;
    sistema: number;
    n_cuadra: number;
    n_diferencia: number;
    n_solo_carpeta: number;
    n_solo_sistema: number;
  };
}

export interface OpcionesCruce {
  carpeta: CarpetaParseada;
  sistemaRows: PendienteIM[];
  maestro: ClienteMaestro[];
  /** Filas crudas de comprobantes_pago no terminales (se clasifican adentro). */
  recibos: ReciboTransito[];
  corte: string;
  tolerancia: number;
  corteExacto: boolean;
  advertencia: string | null;
}

export function cruzarCarpeta(opts: OpcionesCruce): ResultadoCruce {
  const { carpeta, corte, tolerancia } = opts;
  const sistema = armarSistema(opts.sistemaRows, opts.maestro);

  // Recibos EN TRÁNSITO (pendiente/error real — no anticipos ni caducados)
  // con fecha ≤ corte, indexados por cliente: explican diferencias solas.
  const recibosPorCliente = new Map<number, ReciboTransito[]>();
  for (const rec of opts.recibos) {
    const cod = Number(rec.cod_cliente);
    if (!Number.isFinite(cod)) continue;
    const arr = recibosPorCliente.get(cod);
    if (arr) arr.push(rec); else recibosPorCliente.set(cod, [rec]);
  }
  const transitoAlCorte = (cod: number): TransitoAlCorte[] => {
    const recs = recibosPorCliente.get(cod);
    if (!recs?.length) return [];
    return clasificarRecibos(recs).transito
      .filter(t => t.fecha != null && t.fecha <= corte)
      .map(t => ({ monto: t.monto, fecha: t.fecha, status: t.status }));
  };

  const vendedores: CruceVendedor[] = [];
  const totales = { carpeta: 0, sistema: 0, n_cuadra: 0, n_diferencia: 0, n_solo_carpeta: 0, n_solo_sistema: 0 };

  for (const grupo of carpeta.vendedores) {
    const sistemaVend = sistema.porVendedor.get(grupo.cod_vendedor) ?? [];
    const tentativo = grupo.cod_vendedor === SHEET_VENDEDOR.ANDREA;
    const r = cruzarVendedor(grupo.clientes, sistemaVend, tolerancia, tentativo);

    // Anotar tránsito al corte en los matches (clave para explicar diferencias)
    for (const m of r.matches) {
      const tr = transitoAlCorte(m.cod_cliente);
      if (tr.length) m.transito_al_corte = tr;
    }

    // Cross-vendedor: para cada solo-carpeta, buscar contraparte en TODO el
    // sistema bajo OTRO vendedor con score exigente (caso MONTERO: cliente en
    // la carpeta de MARCELO pero asignado a BRIAN en el maestro).
    for (const sc of r.solo_carpeta) {
      let best: { cli: ClienteSistema; score: number } | null = null;
      for (const cli of sistema.todos) {
        if (cli.cod_vendedor === grupo.cod_vendedor) continue;
        const score = scoreNombres(sc.cliente, cli.nombre);
        if (score >= UMBRAL_CROSS_VENDEDOR && (!best || score > best.score)) best = { cli, score };
      }
      if (best) {
        sc.cross_vendedor = {
          cod_cliente: best.cli.cod_cliente,
          nombre: best.cli.nombre,
          saldo: best.cli.saldo,
          vendedor: best.cli.cod_vendedor != null
            ? (PESTANA_POR_COD[best.cli.cod_vendedor] ?? `Vendedor #${best.cli.cod_vendedor}`)
            : 'Sin vendedor',
          score: Math.round(best.score * 1000) / 1000,
        };
      }
    }

    const totalCarpeta = r2(grupo.clientes.reduce((a, c) => a + c.saldo, 0));
    const totalSistema = r2(sistemaVend.reduce((a, c) => a + c.saldo, 0));
    const nCuadra = r.matches.filter(m => m.estado === 'CUADRA').length;
    const nDif = r.matches.length - nCuadra;
    vendedores.push({
      pestana: grupo.pestana,
      cod_vendedor: grupo.cod_vendedor,
      tentativo,
      total_carpeta: totalCarpeta,
      total_sistema: totalSistema,
      n_cuadra: nCuadra,
      n_diferencia: nDif,
      matches: r.matches,
      solo_carpeta: r.solo_carpeta.sort((a, b) => Math.abs(b.saldo) - Math.abs(a.saldo)),
      solo_sistema: r.solo_sistema,
    });

    totales.carpeta = r2(totales.carpeta + totalCarpeta);
    totales.sistema = r2(totales.sistema + totalSistema);
    totales.n_cuadra += nCuadra;
    totales.n_diferencia += nDif;
    totales.n_solo_carpeta += r.solo_carpeta.length;
    totales.n_solo_sistema += r.solo_sistema.length;
  }

  return {
    corte,
    tolerancia,
    corte_exacto: opts.corteExacto,
    advertencia: opts.advertencia,
    vendedores,
    internas: sistema.internas,
    excluidas_por_fecha: carpeta.excluidas_por_fecha,
    sin_fecha: carpeta.sin_fecha,
    pestanas_ignoradas: carpeta.pestanas_ignoradas,
    totales,
  };
}

// ─── Export xlsx con token efímero ───────────────────────────────────────────
// El POST del cruce genera el workbook en RAM y devuelve un token; el GET de
// export lo baja. TTL 30min con limpieza perezosa (volumen: 1-2 cruces/mes).

const EXPORT_TOKEN_TTL_MS = 30 * 60 * 1000;
const exportTokens = new Map<string, { buf: Buffer; fileName: string; expiresAt: number }>();

function sweepExportTokens(): void {
  const now = Date.now();
  for (const [k, v] of exportTokens) if (v.expiresAt < now) exportTokens.delete(k);
}

interface SheetDef { name: string; headers: string[]; rows: (string | number | null)[][] }

function buildXlsxMulti(sheets: SheetDef[]): Buffer {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet([s.headers, ...s.rows]);
    ws['!cols'] = s.headers.map((h, i) => {
      const maxData = s.rows.reduce((m, r) => Math.max(m, String(r[i] ?? '').length), 0);
      return { wch: Math.min(Math.max(h.length, maxData) + 2, 44) };
    });
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function notaMatch(m: MatchCruce): string {
  const partes: string[] = [];
  if (m.transito_al_corte?.length) {
    const tot = r2(m.transito_al_corte.reduce((a, t) => a + t.monto, 0));
    partes.push(`$${tot} en tránsito al corte (${m.transito_al_corte.length} recibo/s sin imputar en IM)`);
  }
  if (m.tentativo) partes.push('match tentativo (nombre de pila)');
  return partes.join(' · ');
}

export function buildCruceXlsx(r: ResultadoCruce): Buffer {
  const resumen: SheetDef = {
    name: 'Resumen',
    headers: ['vendedor', 'total_carpeta', 'total_sistema', 'dif_total', 'cuadran', 'diferencias', 'solo_carpeta', 'solo_sistema'],
    rows: [
      ...r.vendedores.map(v => [
        v.pestana + (v.tentativo ? ' (tentativo)' : ''),
        v.total_carpeta, v.total_sistema, r2(v.total_carpeta - v.total_sistema),
        v.n_cuadra, v.n_diferencia, v.solo_carpeta.length, v.solo_sistema.length,
      ] as (string | number | null)[]),
      ['TOTAL', r.totales.carpeta, r.totales.sistema, r2(r.totales.carpeta - r.totales.sistema),
        r.totales.n_cuadra, r.totales.n_diferencia, r.totales.n_solo_carpeta, r.totales.n_solo_sistema],
      [],
      ['corte', r.corte, null, null, null, null, null, null],
      ['corte_exacto', r.corte_exacto ? 'SÍ (snapshot)' : 'NO (foto actual aproximada)', null, null, null, null, null, null],
      ['tolerancia', r.tolerancia, null, null, null, null, null, null],
      ...(r.advertencia ? [['advertencia', r.advertencia, null, null, null, null, null, null] as (string | number | null)[]] : []),
    ],
  };

  const diferencias: SheetDef = {
    name: 'Diferencias',
    headers: ['vendedor', 'cliente_carpeta', 'cliente_sistema', 'cod_cliente', 'saldo_carpeta', 'saldo_sistema', 'dif', 'score', 'nota'],
    rows: r.vendedores
      .flatMap(v => v.matches.filter(m => m.estado === 'DIFERENCIA').map(m => ({ v, m })))
      .sort((a, b) => Math.abs(b.m.dif) - Math.abs(a.m.dif))
      .map(({ v, m }) => [
        v.pestana, m.carpeta, m.sistema, m.cod_cliente,
        m.saldo_carpeta, m.saldo_sistema, m.dif, m.score, notaMatch(m),
      ] as (string | number | null)[]),
  };

  const soloCarpeta: SheetDef = {
    name: 'Solo carpeta',
    headers: ['vendedor', 'cliente', 'saldo', 'posible_cross_vendedor'],
    rows: r.vendedores.flatMap(v => v.solo_carpeta.map(sc => [
      v.pestana, sc.cliente, sc.saldo,
      sc.cross_vendedor
        ? `existe bajo ${sc.cross_vendedor.vendedor}: ${sc.cross_vendedor.nombre} (#${sc.cross_vendedor.cod_cliente}) $${sc.cross_vendedor.saldo} · score ${sc.cross_vendedor.score}`
        : '',
    ] as (string | number | null)[])),
  };

  const soloSistema: SheetDef = {
    name: 'Solo sistema',
    headers: ['vendedor', 'cod_cliente', 'cliente', 'saldo'],
    rows: r.vendedores.flatMap(v => v.solo_sistema.map(s => [
      v.pestana, s.cod_cliente, s.nombre, s.saldo,
    ] as (string | number | null)[])),
  };

  const excluidas: SheetDef = {
    name: 'Excluidas por fecha',
    headers: ['estado', 'vendedor', 'fila', 'fecha', 'cliente', 'monto'],
    rows: [
      ...r.excluidas_por_fecha.map(e => [
        'EXCLUIDA (fecha > corte — ¿typo?)', e.vendedor, e.fila, e.fecha, e.cliente, e.monto,
      ] as (string | number | null)[]),
      ...r.sin_fecha.map(s => [
        `INCLUIDA sin fecha parseable ("${s.valor_fecha}")`, s.vendedor, s.fila, null, s.cliente, s.monto,
      ] as (string | number | null)[]),
    ],
  };

  const internas: SheetDef = {
    name: 'Internas',
    headers: ['cod_cliente', 'nombre', 'saldo_al_corte'],
    rows: r.internas.map(i => [i.cod_cliente, i.nombre, i.saldo]),
  };

  return buildXlsxMulti([resumen, diferencias, soloCarpeta, soloSistema, excluidas, internas]);
}

// ─── Handlers HTTP ───────────────────────────────────────────────────────────

/**
 * POST /api/conciliacion/cruce — multipart: file (.xlsx), corte (YYYY-MM-DD),
 * tolerancia (default $20), cod_empresa (default 1). Auth admin/gerente.
 * Devuelve el JSON del cruce + download_token para bajar el xlsx.
 */
export async function cruceCarpetaHandler(req: Request & { user?: JwtPayload; file?: any }, res: Response) {
  try {
    const user = req.user!;
    if (user.rol !== 'admin' && user.rol !== 'gerente') { res.status(403).json({ error: 'Requiere admin/gerente' }); return; }

    const file = req.file;
    if (!file?.buffer) { res.status(400).json({ error: 'Falta el archivo .xlsx de la carpeta (campo "file")' }); return; }

    const corte = String(req.body?.corte ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(corte)) { res.status(400).json({ error: 'corte inválido: usar YYYY-MM-DD' }); return; }
    const tolRaw = Number(req.body?.tolerancia);
    const tolerancia = Number.isFinite(tolRaw) && tolRaw >= 0 ? tolRaw : TOLERANCIA_DEFAULT;
    const codEmpresa = Number(req.body?.cod_empresa) || 1;

    let wb: XLSX.WorkBook;
    try {
      wb = XLSX.read(file.buffer, { type: 'buffer', raw: true });
    } catch {
      res.status(400).json({ error: 'No se pudo leer el archivo: ¿es un .xlsx válido?' });
      return;
    }
    const carpeta = parseCarpeta(wb, corte);
    if (carpeta.vendedores.length === 0) {
      res.status(400).json({ error: 'El archivo no tiene pestañas de vendedor reconocibles (JULIO / MARCELO / SEBA / BRIAN / ANDREA)' });
      return;
    }

    // Lado sistema: snapshot exacto si existe; si el corte es HOY y todavía no
    // hay snapshot, sacamos la foto en el momento (on-demand).
    let snapshotRows = await getSnapshotRows(codEmpresa, corte);
    if (!snapshotRows && corte === hoyISOArgentina()) {
      try {
        await guardarSnapshotConciliacion(codEmpresa);
        snapshotRows = await getSnapshotRows(codEmpresa, corte);
      } catch (e: any) {
        console.warn('[cruce] snapshot on-demand falló, sigo con foto viva:', e?.message ?? e);
      }
    }
    const vivo = snapshotRows ? { rows: [] as PendienteIM[] } : await fetchPendientesCached(codEmpresa, false);
    const lado = resolverLadoSistema(snapshotRows, vivo.rows, corte);

    const [maestro, recibos] = await Promise.all([
      fetchClientesIMCached(),
      fetchRecibosTransito(codEmpresa),
    ]);

    const resultado = cruzarCarpeta({
      carpeta,
      sistemaRows: lado.rows,
      maestro,
      recibos,
      corte,
      tolerancia,
      corteExacto: lado.corte_exacto,
      advertencia: lado.advertencia,
    });

    // Workbook del export listo en RAM, canjeable por token durante 30min.
    sweepExportTokens();
    const token = randomUUID();
    exportTokens.set(token, {
      buf: buildCruceXlsx(resultado),
      fileName: `Cruce_Carpeta_emp${codEmpresa}_${corte}.xlsx`,
      expiresAt: Date.now() + EXPORT_TOKEN_TTL_MS,
    });

    res.json({ ok: true, cod_empresa: codEmpresa, ...resultado, download_token: token });
  } catch (err: any) {
    console.error('cruceCarpetaHandler error:', err);
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/** GET /api/conciliacion/cruce/export?token=... — baja el xlsx del cruce. */
export async function exportCruceHandler(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const user = req.user!;
    if (user.rol !== 'admin' && user.rol !== 'gerente') { res.status(403).json({ error: 'Requiere admin/gerente' }); return; }
    sweepExportTokens();
    const token = String(req.query.token ?? '');
    const hit = token ? exportTokens.get(token) : undefined;
    if (!hit) { res.status(404).json({ error: 'Export vencido o inexistente: volvé a correr el cruce.' }); return; }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${hit.fileName}"`);
    res.send(hit.buf);
  } catch (err: any) {
    console.error('exportCruceHandler error:', err);
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}
