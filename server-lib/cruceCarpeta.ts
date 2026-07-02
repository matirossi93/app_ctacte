import * as XLSX from 'xlsx';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { sb, TENANT_ID } from './supabase.js';
import { fetchClientesIMCached } from './infomanager.js';
import { COD_CLIENTES_INTERNOS } from './comisionesShared.js';
import {
  clasificarRecibos, fetchPendientesCached, hoyISOArgentina,
  getSnapshotConciliacion, guardarSnapshotConciliacion,
  ESTADOS_NO_TERMINALES,
  type PendienteIM, type ClienteMaestro, type ReciboTransito,
  type MaestroSnapshot, type SnapshotConciliacion,
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
// reales: DANTE/DONET, MONTERO cross-vendedor, SARACHO fecha typo,
// SUPER EMANUEL saldo ~$0 en IM con $730k en carpeta).
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

/** Grupo sintético para clientes del sistema sin pestaña de carpeta. */
export const PESTANA_OTROS = 'OTROS (sin pestaña)';
const COD_VENDEDOR_OTROS = -1;

/** Score mínimo para considerar match dentro del vendedor. */
export const UMBRAL_MATCH = 0.66;
/** Score mínimo (más exigente) para sugerir contraparte en OTRO vendedor. */
export const UMBRAL_CROSS_VENDEDOR = 0.82;
/** Diferencia carpeta-sistema tolerada como "CUADRA" (residuos de centavos IM). */
export const TOLERANCIA_DEFAULT = 20;
/** Si el runner-up de una entrada de carpeta queda a menos de esto del elegido → ambiguo. */
const MARGEN_AMBIGUO = 0.03;

/** Ruido de centavos: umbral SOLO para emitir la lista solo_sistema (ver X6). */
const UMBRAL_RUIDO = 1;

function r2(n: number): number { return Math.round(n * 100) / 100; }
function pad2(n: number): string { return String(n).padStart(2, '0'); }

/** Fecha ART (UTC-3 fijo) de un timestamp ISO. */
function fechaART(ts: string): string {
  return new Date(new Date(ts).getTime() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

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
 * strings dd/mm/yyyy, dd/mm/yy, dd/mm y basura con typos tipo "2✱/05" con
 * asterisco (→ null → la fila va a `sin_fecha` pero SE INCLUYE en el cruce).
 *
 * dd/mm SIN año: se prueba primero el año del corte; si la fecha queda
 * POSTERIOR al corte se prueba el año anterior (diciembre anotado en un cruce
 * de enero NO es un typo). Solo si ambas quedan posteriores se devuelve la del
 * año del corte (y el llamador la excluirá como fecha > corte).
 */
export function parseFechaCarpeta(v: any, corte: string): string | null {
  const anioCorte = Number(corte.slice(0, 4));
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
      if (!(d >= 1 && d <= 31 && mo >= 1 && mo <= 12)) return null;
      const candCorte = `${anioCorte}-${pad2(mo)}-${pad2(d)}`;
      if (candCorte <= corte) return candCorte;
      const candAnterior = `${anioCorte - 1}-${pad2(mo)}-${pad2(d)}`;
      if (candAnterior <= corte) return candAnterior;
      return candCorte; // ambas posteriores: quedará excluida como fecha > corte
    }
  }
  return null;
}

/**
 * Monto de celda: number directo o string estilo AR ('$ 1.234,56', '1234.5').
 * SUPUESTO formato AR: sin coma decimal, un punto con exactamente 3 dígitos
 * detrás se lee como separador de MILES ('1.500' → 1500, no 1.5) — así se
 * anotan los saldos en la carpeta. Punto con 1-2 decimales se lee decimal.
 */
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

/**
 * Tolerancia del cruce: vacío/undefined/no-numérico → default $20 (Number('')
 * es 0 y convertía "campo vacío" en tolerancia cero: todo residuo de centavos
 * pasaba a DIFERENCIA). Solo un negativo EXPLÍCITO devuelve null (rechazar).
 */
export function parseTolerancia(raw: unknown): number | null {
  if (raw === undefined || raw === null) return TOLERANCIA_DEFAULT;
  const s = String(raw).trim();
  if (s === '') return TOLERANCIA_DEFAULT;
  const n = Number(s);
  if (!Number.isFinite(n)) return TOLERANCIA_DEFAULT;
  if (n < 0) return null;
  return n;
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
      const fecha = parseFechaCarpeta(rawFecha, corte);
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
 *  - snapshot NO vacío de esa fecha → corte EXACTO (un snapshot con 0 filas
 *    se trata como inexistente: nunca puede pasar por "exacto" con sistema
 *    vacío — todo caería en solo-carpeta);
 *  - si no → reporte vivo filtrando comprobantes con fecha_factura > corte,
 *    corte APROXIMADO con advertencia (los pagos posteriores al corte ya
 *    están aplicados; las filas SIN fecha_factura no se pueden filtrar y se
 *    conservan — se informa cuántas).
 */
export function resolverLadoSistema(
  snapshotRows: PendienteIM[] | null,
  vivoRows: PendienteIM[],
  corte: string,
): { rows: PendienteIM[]; corte_exacto: boolean; advertencia: string | null } {
  if (snapshotRows && snapshotRows.length > 0) {
    return { rows: snapshotRows, corte_exacto: true, advertencia: null };
  }
  const sinFecha = vivoRows.filter(r => !r.fecha_factura).length;
  const rows = vivoRows.filter(r => !r.fecha_factura || String(r.fecha_factura).slice(0, 10) <= corte);
  let advertencia = 'Sin snapshot para esa fecha: se usa la foto ACTUAL de IM aproximada al corte. Los comprobantes posteriores al corte se excluyen, pero los pagos posteriores YA están aplicados a los saldos.';
  if (sinFecha > 0) {
    advertencia += ` Incluye ${sinFecha} comprobante${sinFecha !== 1 ? 's' : ''} sin fecha que no se pudieron filtrar al corte.`;
  }
  return { rows, corte_exacto: false, advertencia };
}

export interface ClienteSistema {
  cod_cliente: number;
  nombre: string;
  saldo: number;
  cod_vendedor: number | null;
}

interface SistemaArmado {
  porVendedor: Map<number, ClienteSistema[]>;
  /** Clientes de vendedores SIN hoja en ESTA carpeta (grupo OTROS). */
  otros: ClienteSistema[];
  todos: ClienteSistema[];
  internas: Array<{ cod_cliente: number; nombre: string; saldo: number }>;
}

/**
 * Agrupa las filas IM por cliente (SUM saldo — misma regla que el panel),
 * asigna vendedor por MAESTRO y separa internas.
 * Prioridad de maestro: el CONGELADO en el snapshot (asignación del momento
 * del corte) > el vivo (fallback para clientes nuevos o snapshots viejos).
 * `vendedoresConCarpeta` = cods con hoja en ESTE archivo: los clientes de
 * cualquier otro vendedor (sin pestaña teórica O con pestaña pero sin hoja
 * subida) van a `otros` — si no, desaparecen del total del cruce.
 * NO se filtra por saldo acá: un cliente con saldo ~$0 en IM pero $730k en la
 * carpeta (caso real SUPER EMANUEL) DEBE matchear y gritar la DIFERENCIA —
 * el umbral de ruido se aplica recién al emitir la lista solo_sistema.
 */
function armarSistema(
  rows: PendienteIM[],
  maestro: ClienteMaestro[],
  maestroSnapshot: MaestroSnapshot | null | undefined,
  vendedoresConCarpeta: Set<number>,
): SistemaArmado {
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

  const out: SistemaArmado = { porVendedor: new Map(), otros: [], todos: [], internas: [] };
  for (const [cod, agg] of porCliente) {
    const snap = maestroSnapshot?.[String(cod)];
    const m = maestroMap.get(cod);
    const nombre = String(snap?.nombre || m?.razon_social || agg.nombre || `Cliente ${cod}`).trim();
    if (COD_CLIENTES_INTERNOS.has(cod)) {
      out.internas.push({ cod_cliente: cod, nombre, saldo: agg.saldo });
      continue;
    }
    // Vendedor: snapshot congelado primero; si el cod no está ahí, el vivo.
    const codVendRaw = snap !== undefined ? snap.cod_vendedor : (m?.cod_vendedor ?? null);
    const codVend = codVendRaw != null && Number.isFinite(Number(codVendRaw)) ? Number(codVendRaw) : null;
    const cli: ClienteSistema = { cod_cliente: cod, nombre, saldo: agg.saldo, cod_vendedor: codVend };
    out.todos.push(cli);
    if (codVend != null && vendedoresConCarpeta.has(codVend)) {
      const arr = out.porVendedor.get(codVend);
      if (arr) arr.push(cli); else out.porVendedor.set(codVend, [cli]);
    } else {
      out.otros.push(cli);
    }
  }
  out.internas.sort((a, b) => Math.abs(b.saldo) - Math.abs(a.saldo));
  out.otros.sort((a, b) => Math.abs(b.saldo) - Math.abs(a.saldo));
  return out;
}

// ─── Matching best-first ─────────────────────────────────────────────────────

export interface TransitoAlCorte {
  monto: number;
  fecha: string | null;
  status: string;
  /** Solo para status='imputado': cuándo se imputó (post-corte). */
  imputado_at?: string | null;
}

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
  /** El runner-up de esta entrada quedó a <0.03 del elegido: confirmar identidad. */
  ambiguo?: boolean;
  /** Recibos de la app que estaban EN TRÁNSITO AL corte: explican diferencias. */
  transito_al_corte?: TransitoAlCorte[];
}

export interface SoloCarpeta {
  cliente: string;
  saldo: number;
  /** Contraparte probable bajo OTRO vendedor (score ≥ 0.82) — caso MONTERO. */
  cross_vendedor?: {
    cod_cliente: number;
    nombre: string;
    saldo: number;
    vendedor: string;
    score: number;
    /** true si esa contraparte quedó sin matchear (está en el solo-sistema de ese grupo). */
    en_solo_sistema: boolean;
  };
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
 * Si el runner-up de la MISMA entrada de carpeta queda a <0.03 del elegido,
 * el match se marca `ambiguo` (típico: apellido solo que containment-matchea
 * igual contra varios clientes del sistema).
 * solo_sistema emite únicamente |saldo| ≥ $1 (residuos de centavos afuera),
 * pero TODOS los clientes participan del matching.
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

  // Para el flag de ambigüedad: todos los scores candidatos por entrada de carpeta.
  const paresPorCarpeta = new Map<number, Array<{ j: number; score: number }>>();
  for (const p of pares) {
    const arr = paresPorCarpeta.get(p.i);
    if (arr) arr.push({ j: p.j, score: p.score }); else paresPorCarpeta.set(p.i, [{ j: p.j, score: p.score }]);
  }

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
    const runnerUp = Math.max(0, ...(paresPorCarpeta.get(p.i) ?? [])
      .filter(x => x.j !== p.j)
      .map(x => x.score));
    const ambiguo = runnerUp > p.score - MARGEN_AMBIGUO;
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
      ...(ambiguo ? { ambiguo: true } : {}),
    });
  }
  matches.sort((a, b) => Math.abs(b.dif) - Math.abs(a.dif));

  const solo_carpeta: SoloCarpeta[] = carpeta
    .filter((_, i) => !usadoC.has(i))
    .map(c => ({ cliente: c.nombre, saldo: c.saldo }));
  // Umbral de ruido SOLO acá: los residuos participan del matching pero no
  // ensucian la lista de faltantes del sistema.
  const solo_sistema = sistema
    .filter((_, j) => !usadoS.has(j))
    .filter(s => Math.abs(s.saldo) >= UMBRAL_RUIDO)
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
  /** Maestro congelado del snapshot (asignación de vendedor AL corte). */
  maestroSnapshot?: MaestroSnapshot | null;
  /** Filas de comprobantes_pago: no terminales + imputados post-corte. */
  recibos: ReciboTransito[];
  corte: string;
  tolerancia: number;
  corteExacto: boolean;
  advertencia: string | null;
}

export function cruzarCarpeta(opts: OpcionesCruce): ResultadoCruce {
  const { carpeta, corte, tolerancia } = opts;
  const vendedoresConCarpeta = new Set(carpeta.vendedores.map(g => g.cod_vendedor));
  const sistema = armarSistema(opts.sistemaRows, opts.maestro, opts.maestroSnapshot, vendedoresConCarpeta);

  const recibosPorCliente = new Map<number, ReciboTransito[]>();
  for (const rec of opts.recibos) {
    const cod = Number(rec.cod_cliente);
    if (!Number.isFinite(cod)) continue;
    const arr = recibosPorCliente.get(cod);
    if (arr) arr.push(rec); else recibosPorCliente.set(cod, [rec]);
  }

  /**
   * Recibos que estaban EN TRÁNSITO AL corte para un cliente:
   *  - no terminales HOY (pendiente/error real, no anticipos ni caducados)
   *    con fecha ≤ corte → "aún en tránsito";
   *  - IMPUTADOS DESPUÉS del corte con fecha de comprobante ≤ corte → al
   *    momento del corte estaban en tránsito (el caso MÁS común del flujo
   *    real: corte 30/06 corrido el 05/07, recibo imputado el 02/07 — sin
   *    esto la diferencia quedaba "inexplicable").
   */
  const transitoAlCorte = (cod: number): TransitoAlCorte[] => {
    const recs = recibosPorCliente.get(cod);
    if (!recs?.length) return [];
    const out: TransitoAlCorte[] = [];
    const noTerminales = recs.filter(r => r.status !== 'imputado');
    for (const t of clasificarRecibos(noTerminales).transito) {
      if (t.fecha != null && t.fecha <= corte) {
        out.push({ monto: t.monto, fecha: t.fecha, status: t.status });
      }
    }
    for (const rec of recs) {
      if (rec.status !== 'imputado' || !rec.imputado_at) continue;
      const fecha = rec.fecha_comprobante
        ? String(rec.fecha_comprobante).slice(0, 10)
        : (rec.created_at ? String(rec.created_at).slice(0, 10) : null);
      const impFechaART = fechaART(String(rec.imputado_at));
      if (fecha != null && fecha <= corte && impFechaART > corte) {
        out.push({ monto: r2(Number(rec.monto) || 0), fecha, status: 'imputado', imputado_at: impFechaART });
      }
    }
    return out;
  };

  // ── FASE 1: matching por pestaña ─────────────────────────────────────────
  const vendedores: CruceVendedor[] = [];
  const totales = { carpeta: 0, sistema: 0, n_cuadra: 0, n_diferencia: 0, n_solo_carpeta: 0, n_solo_sistema: 0 };
  const codsMatcheados = new Set<number>();

  for (const grupo of carpeta.vendedores) {
    const sistemaVend = sistema.porVendedor.get(grupo.cod_vendedor) ?? [];
    const tentativo = grupo.cod_vendedor === SHEET_VENDEDOR.ANDREA;
    const r = cruzarVendedor(grupo.clientes, sistemaVend, tolerancia, tentativo);

    for (const m of r.matches) {
      codsMatcheados.add(m.cod_cliente);
      const tr = transitoAlCorte(m.cod_cliente);
      if (tr.length) m.transito_al_corte = tr;
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

  // ── Grupo OTROS: clientes del sistema sin hoja en ESTA carpeta ───────────
  // (vendedor sin pestaña teórica O con pestaña definida pero sin hoja en el
  // archivo subido). Sin esto desaparecían del cruce y el "Total sistema" no
  // cuadraba contra la cartera real. No hay carpeta contra la cual
  // matchearlos: van como solo_sistema (con umbral de ruido) y su subtotal
  // suma al total.
  if (sistema.otros.length > 0) {
    const totalOtros = r2(sistema.otros.reduce((a, c) => a + c.saldo, 0));
    const listadosOtros = sistema.otros.filter(c => Math.abs(c.saldo) >= UMBRAL_RUIDO);
    vendedores.push({
      pestana: PESTANA_OTROS,
      cod_vendedor: COD_VENDEDOR_OTROS,
      tentativo: false,
      total_carpeta: 0,
      total_sistema: totalOtros,
      n_cuadra: 0,
      n_diferencia: 0,
      matches: [],
      solo_carpeta: [],
      solo_sistema: listadosOtros,
    });
    totales.sistema = r2(totales.sistema + totalOtros);
    totales.n_solo_sistema += listadosOtros.length;
  }

  // ── FASE 2: cross-vendedor (después de TODOS los matchings) ─────────────
  // Se excluyen los cod_cliente YA matcheados en cualquier pestaña: ofrecer
  // como "posible contraparte" a un cliente que ya cuadró en su vendedor
  // invita a un doble cómputo. Si el candidato quedó en el solo-sistema de
  // otro grupo, se anota (es el caso útil: MONTERO sin matchear bajo BRIAN).
  const soloSistemaSet = new Set<number>();
  for (const v of vendedores) for (const s of v.solo_sistema) soloSistemaSet.add(s.cod_cliente);

  for (const v of vendedores) {
    if (v.cod_vendedor === COD_VENDEDOR_OTROS) continue;
    for (const sc of v.solo_carpeta) {
      let best: { cli: ClienteSistema; score: number } | null = null;
      for (const cli of sistema.todos) {
        if (cli.cod_vendedor === v.cod_vendedor) continue;
        if (codsMatcheados.has(cli.cod_cliente)) continue;
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
            : PESTANA_OTROS,
          score: Math.round(best.score * 1000) / 1000,
          en_solo_sistema: soloSistemaSet.has(best.cli.cod_cliente),
        };
      }
    }
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
    for (const t of m.transito_al_corte) {
      partes.push(t.status === 'imputado'
        ? `$${t.monto} imputado el ${t.imputado_at ?? '?'} (post-corte)`
        : `$${t.monto} aún en tránsito (${t.status})`);
    }
  }
  if (m.ambiguo) partes.push('⚠ ambiguo — confirmar identidad');
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

  // Los CUADRA también van al archivo: sin ellos el TOTAL del Resumen no se
  // puede auditar desde el detalle.
  const cuadrados: SheetDef = {
    name: 'Cuadrados (OK)',
    headers: ['vendedor', 'cliente_carpeta', 'cliente_sistema', 'cod_cliente', 'saldo_carpeta', 'saldo_sistema', 'dif', 'score', 'nota'],
    rows: r.vendedores
      .flatMap(v => v.matches.filter(m => m.estado === 'CUADRA').map(m => ({ v, m })))
      .sort((a, b) => Math.abs(b.m.saldo_carpeta) - Math.abs(a.m.saldo_carpeta))
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
        ? `${sc.cross_vendedor.en_solo_sistema ? 'coincide con el solo-sistema de' : 'existe bajo'} ${sc.cross_vendedor.vendedor}: ${sc.cross_vendedor.nombre} (#${sc.cross_vendedor.cod_cliente}) $${sc.cross_vendedor.saldo} · score ${sc.cross_vendedor.score}`
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

  return buildXlsxMulti([resumen, diferencias, cuadrados, soloCarpeta, soloSistema, excluidas, internas]);
}

// ─── Handlers HTTP ───────────────────────────────────────────────────────────

/**
 * Recibos relevantes para el cruce a una fecha de corte:
 *  - no terminales (pendiente_revision / aprobado / error) — se clasifican
 *    en la función pura;
 *  - imputados DESPUÉS del corte (imputado_at > corte): al corte estaban en
 *    tránsito. La query trae con margen (gte fecha del corte en UTC) y el
 *    filtro fino por fecha ART lo hace la función pura.
 */
async function fetchRecibosParaCruce(codEmpresa: number, corte: string): Promise<ReciboTransito[]> {
  let q = sb().from('comprobantes_pago')
    .select('id, cod_cliente, monto, fecha_comprobante, created_at, status, cod_empresa, error_msg, imputado_at')
    .eq('tenant_id', TENANT_ID)
    .or(`status.in.(${ESTADOS_NO_TERMINALES.join(',')}),and(status.eq.imputado,imputado_at.gte.${corte})`)
    .order('created_at', { ascending: false })
    .limit(4000);
  if (codEmpresa === 1) {
    q = q.or('cod_empresa.eq.1,cod_empresa.is.null');
  } else {
    q = q.eq('cod_empresa', codEmpresa);
  }
  const { data, error } = await q;
  if (error) throw new Error(`comprobantes_pago (cruce): ${error.message}`);
  const rows = (data ?? []) as ReciboTransito[];
  if (rows.length === 4000) {
    console.warn('[cruce] comprobantes_pago devolvió 4000 filas (el tope): posible truncación');
  }
  return rows;
}

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
    const tolerancia = parseTolerancia(req.body?.tolerancia);
    if (tolerancia === null) { res.status(400).json({ error: 'La tolerancia no puede ser negativa' }); return; }
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

    // ── Lado sistema ────────────────────────────────────────────────────────
    // corte < hoy con snapshot → EXACTO. corte = hoy → SIEMPRE se refresca la
    // foto antes de cruzar (una foto de las 08:00 reusada a las 15:00 no puede
    // venderse como "exacta") y el banner dice la hora. Sin snapshot → foto
    // viva aproximada.
    const hoy = hoyISOArgentina();
    let snap: SnapshotConciliacion | null = null;
    if (corte === hoy) {
      try {
        await guardarSnapshotConciliacion(codEmpresa);
      } catch (e: any) {
        console.warn('[cruce] refresh de snapshot de hoy falló, sigo con lo que haya:', e?.message ?? e);
      }
    }
    try {
      snap = await getSnapshotConciliacion(codEmpresa, corte);
    } catch (e: any) {
      console.warn('[cruce] lectura de snapshot falló, sigo con foto viva:', e?.message ?? e);
    }

    let sistemaRows: PendienteIM[];
    let corteExacto: boolean;
    let advertencia: string | null;
    let maestroSnapshot: MaestroSnapshot | null = null;

    if (snap) {
      sistemaRows = snap.rows;
      maestroSnapshot = snap.maestro;
      if (corte === hoy) {
        // "Exacto" queda reservado a fechas cerradas (< hoy).
        corteExacto = false;
        const hora = new Date(snap.created_at).toLocaleTimeString('es-AR', {
          hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires',
        });
        advertencia = `Cruce contra la foto de HOY a las ${hora} hs (ART): el día no cerró, los saldos pueden seguir moviéndose.`;
      } else {
        corteExacto = true;
        advertencia = null;
      }
      if (!maestroSnapshot) {
        advertencia = [advertencia, 'El snapshot no guardó el maestro del corte: la asignación de vendedor es la ACTUAL y puede diferir de la del corte.']
          .filter(Boolean).join(' ');
      }
    } else {
      const vivo = await fetchPendientesCached(codEmpresa, false);
      const lado = resolverLadoSistema(null, vivo.rows, corte);
      sistemaRows = lado.rows;
      corteExacto = false;
      advertencia = lado.advertencia;
    }

    const [maestro, recibos] = await Promise.all([
      fetchClientesIMCached(),
      fetchRecibosParaCruce(codEmpresa, corte),
    ]);

    const resultado = cruzarCarpeta({
      carpeta,
      sistemaRows,
      maestro,
      maestroSnapshot,
      recibos,
      corte,
      tolerancia,
      corteExacto,
      advertencia,
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
