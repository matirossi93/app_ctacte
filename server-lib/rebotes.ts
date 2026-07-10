// ═══════════════════════════════════════════════════════════════════════════
// Rebotes de reparto — IO: descarga del sheet, full-replace en Supabase y
// endpoints (Feature A, fase 1).
//
// La lógica pura (normalización de motivos, parser del workbook, matching de
// clientes) vive en rebotesParser.ts — separada porque infomanager.ts hace
// process.exit(1) al importarse sin env vars y eso mata los tests.
//
// Un cron baja el sheet como XLSX por el export público y hace FULL-REPLACE
// de cada mes presente: el sheet es la fuente de verdad y se auto-corrige
// (si administración arregla una fila vieja, el próximo sync la refleja).
// ═══════════════════════════════════════════════════════════════════════════
import axios from 'axios';
import XLSX from 'xlsx';
import type { Request, Response } from 'express';
import { sb, TENANT_ID, hasSupabase } from './supabase.js';
import { fetchClientesIMCached } from './infomanager.js';
import {
  parseRebotesWorkbook, matchClientesRebotes, calcDescuentosVendedor, rigenCargosRebotes,
  detectarEventosRecargo,
  MOTIVOS_DESCUENTO_VENDEDOR,
  type ClienteMaestro, type DescuentoRebotes, type FacturaCandidata, type EventoRecargo,
} from './rebotesParser.js';
import { getMonthlyVentasRaw } from './snapshotCache.js';
import { tipoComprobante, isAnulada } from '../src/utils/ventas.js';
import { COD_EMPRESA_CASA_CENTRAL, COD_CLIENTES_INTERNOS } from './comisionesShared.js';
import { invalidateAll as invalidateGoalsCache } from './goalsResponseCache.js';
import type { JwtPayload } from './auth.js';

export const REBOTES_SHEET_ID = '1kT1rXU_KC0OiSZckfTx_IrEdjAnccjU4-DA0kHDW468';

export interface SyncRebotesResult {
  ok: boolean;
  error?: string;
  year?: number;
  filas?: number;
  meses?: Array<{ month: number; hoja: string; filas: number; descartadas: number; sin_clasificar: number; sin_match_cliente: number }>;
  warnings?: string[];
  elapsedMs?: number;
}

function anioActualART(): number {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).getUTCFullYear();
}

let syncInFlight = false;

/**
 * Baja el sheet completo como XLSX (61KB, export público) y reemplaza en
 * Supabase TODOS los meses presentes. Full-replace por mes: barato (~1000
 * filas/año) y auto-corrige ediciones retroactivas del sheet.
 * Lock anti-overlap propio: lo comparten el cron y el sync-now del admin.
 */
export async function syncRebotes(opts: { buffer?: Buffer; importedBy?: string | null } = {}): Promise<SyncRebotesResult> {
  if (!hasSupabase()) return { ok: false, error: 'Supabase no configurado' };
  if (syncInFlight) return { ok: false, error: 'sync de rebotes ya en curso' };
  syncInFlight = true;
  const t0 = Date.now();
  try {
    const year = anioActualART();
    let buf = opts.buffer;
    if (!buf) {
      const url = `https://docs.google.com/spreadsheets/d/${REBOTES_SHEET_ID}/export?format=xlsx`;
      const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000, maxRedirects: 10 });
      buf = Buffer.from(resp.data);
    }
    const wb = XLSX.read(buf, { type: 'buffer' });
    const { meses, warnings } = parseRebotesWorkbook(wb, year);
    if (!meses.length) return { ok: false, error: 'El sheet no tiene pestañas mensuales reconocibles', warnings };

    // Maestro IM para matchear clientes. Si IM está caído devuelve [] →
    // este sync deja los cod_cliente en null y el próximo (con IM arriba)
    // los repone: full-replace = auto-curación.
    let maestro: ClienteMaestro[] = [];
    try {
      const clientes = await fetchClientesIMCached();
      maestro = clientes
        .filter(c => c.cod_cliente > 0 && c.razon_social)
        .map(c => ({ cod_cliente: c.cod_cliente, razon_social: String(c.razon_social) }));
    } catch { /* sin maestro: matchea nada, se repone al próximo sync */ }
    if (maestro.length) matchClientesRebotes(meses, maestro);
    else warnings.push('Maestro de clientes IM no disponible: este sync no matchea clientes (se repone en el próximo).');

    const statsMeses: NonNullable<SyncRebotesResult['meses']> = [];
    const errores: string[] = [];
    const BATCH = 200;
    for (const mes of meses) {
      const dbRows = mes.rows.map(r => ({ tenant_id: TENANT_ID, year, month: mes.month, ...r }));
      const del = await sb().from('rebotes').delete()
        .eq('tenant_id', TENANT_ID).eq('year', year).eq('month', mes.month);
      if (del.error) { errores.push(`${mes.hoja}: delete: ${del.error.message}`); continue; }
      for (let i = 0; i < dbRows.length; i += BATCH) {
        const { error } = await sb().from('rebotes').insert(dbRows.slice(i, i + BATCH));
        if (error) { errores.push(`${mes.hoja}: insert batch ${i}: ${error.message}`); break; }
      }
      statsMeses.push({
        month: mes.month, hoja: mes.hoja, filas: mes.rows.length, descartadas: mes.descartadas,
        sin_clasificar: mes.rows.filter(r => r.motivo === 'sin_clasificar').length,
        sin_match_cliente: mes.rows.filter(r => r.cod_cliente == null).length,
      });
    }

    const totalFilas = statsMeses.reduce((a, m) => a + m.filas, 0);
    try {
      await sb().from('sheet_import_log').insert({
        tenant_id: TENANT_ID,
        sheet_id: REBOTES_SHEET_ID,
        hoja: `rebotes (${statsMeses.length} meses)`,
        year,
        rows_leidas: totalFilas + statsMeses.reduce((a, m) => a + m.descartadas, 0),
        rows_importadas: totalFilas,
        rows_descartadas: statsMeses.reduce((a, m) => a + m.descartadas, 0),
        errores: errores.length ? errores : null,
        finished_at: new Date().toISOString(),
        imported_by: opts.importedBy ?? null,
      });
    } catch { /* log best-effort */ }

    // Las respuestas de /api/comisiones se cachean (goalsResponseCache): un
    // sync que cambió rebotes debe invalidarlas para que el descuento del 3%
    // se refleje al toque y no 3 minutos después.
    invalidateGoalsCache();

    return {
      ok: errores.length === 0,
      error: errores.length ? errores.join(' · ') : undefined,
      year, filas: totalFilas, meses: statsMeses, warnings,
      elapsedMs: Date.now() - t0,
    };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err), elapsedMs: Date.now() - t0 };
  } finally {
    syncInFlight = false;
  }
}

// ─── Descuento 3% para comisiones (fase 2) ───────────────────────────────────

/**
 * Descuentos por rebotes M.C. VENDEDOR del mes, agrupados por cod_vendedor.
 * Lo consume getComisionesData. Devuelve:
 *   · Map vacío si el período es anterior a la vigencia (julio 2026) o no hay Supabase
 *   · null si la query falló — el llamador debe AVISAR en vez de mostrar en
 *     silencio una comisión sin descontar.
 */
export async function getDescuentosRebotes(
  year: number, month: number, asOfDate?: string | null,
): Promise<Map<number, DescuentoRebotes> | null> {
  if (!rigenCargosRebotes(year, month) || !hasSupabase()) return new Map();
  const { data, error } = await sb().from('rebotes')
    .select('cod_vendedor, motivo, total, fecha')
    .eq('tenant_id', TENANT_ID).eq('year', year).eq('month', month)
    .in('motivo', [...MOTIVOS_DESCUENTO_VENDEDOR])
    .not('cod_vendedor', 'is', null);
  if (error) {
    console.error('[rebotes] getDescuentosRebotes:', error.message);
    return null;
  }
  return calcDescuentosVendedor(data ?? [], asOfDate ?? null);
}

// ─── Recargo 3% al cliente (fase 3) ──────────────────────────────────────────

/** Cabeceras crudas de IM → facturas candidatas para el match de recargos:
 *  solo FA válidas de Casa Central, sin clientes internos. */
function cabecerasACandidatas(ventas: any[]): FacturaCandidata[] {
  const out: FacturaCandidata[] = [];
  for (const v of ventas) {
    const id = Number(v.id);
    if (!Number.isFinite(id) || isAnulada(v)) continue;
    if (!tipoComprobante(v).startsWith('F')) continue;
    const codEmp = Number(v.cod_empresa);
    if (Number.isFinite(codEmp) && codEmp !== COD_EMPRESA_CASA_CENTRAL) continue;
    const codCli = Number(v.cod_cliente);
    if (!Number.isFinite(codCli) || COD_CLIENTES_INTERNOS.has(codCli)) continue;
    const fecha = String(v.fecha ?? v.fa_fecha ?? '').slice(0, 10);
    if (!fecha) continue;
    // No sabemos si el sheet valoriza como neto o total final → probamos todas.
    const totales = [...new Set([v.neto, v.total, v.fa_total]
      .map((t: any) => Number(t))
      .filter((t: number) => Number.isFinite(t) && t > 0))];
    if (!totales.length) continue;
    out.push({ id, cod_cliente: codCli, fecha, totales });
  }
  return out;
}

export interface RecargosResult {
  rige: boolean;
  eventos: EventoRecargo[];
  error?: string;
}

/**
 * Eventos de recargo del mes: renglones rebotados por culpa del cliente
 * (devolucion/sin_dinero/cerrado) agrupados por cliente+fecha y cruzados
 * contra las facturas IM del mes y el anterior (un rebote del 2 puede ser
 * de una factura del 30). Recargo 3% SOLO si rebotó el pedido completo.
 */
export async function getRecargosClientes(year: number, month: number): Promise<RecargosResult> {
  if (!rigenCargosRebotes(year, month)) return { rige: false, eventos: [] };
  if (!hasSupabase()) return { rige: true, eventos: [], error: 'Supabase no configurado' };

  const { data, error } = await sb().from('rebotes')
    .select('cod_cliente, cliente_raw, cod_vendedor, vendedor_raw, fecha, motivo, total')
    .eq('tenant_id', TENANT_ID).eq('year', year).eq('month', month);
  if (error) return { rige: true, eventos: [], error: error.message };
  if (!data?.length) return { rige: true, eventos: [] };

  const prev = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
  const [mesActual, mesPrevio] = await Promise.all([
    getMonthlyVentasRaw(year, month),
    getMonthlyVentasRaw(prev.year, prev.month).catch(() => ({ ventas: [] as any[] })),
  ]);
  const facturas = cabecerasACandidatas([...mesPrevio.ventas, ...mesActual.ventas]);
  return { rige: true, eventos: detectarEventosRecargo(data, facturas) };
}

/**
 * GET /api/rebotes/recargos?year&month[&cod_vendedor]
 * Vendedor: solo los eventos de sus clientes (para avisar/recordar el
 * recargo). Admin: todos (lista mensual para facturar el 3% a mano en IM).
 */
export async function listRecargos(req: Request & { user?: JwtPayload }, res: Response): Promise<void> {
  const user = req.user!;
  const nowART = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const year = Number(req.query.year) || nowART.getUTCFullYear();
  const month = Number(req.query.month) || nowART.getUTCMonth() + 1;
  const isAdmin = user.rol === 'admin' || user.rol === 'gerente';

  const r = await getRecargosClientes(year, month);
  if (r.error) { res.status(500).json({ error: r.error }); return; }

  let eventos = r.eventos;
  if (!isAdmin) eventos = eventos.filter(e => e.cod_vendedor === (user.cod_vendedor ?? -1));
  else if (req.query.cod_vendedor) eventos = eventos.filter(e => e.cod_vendedor === Number(req.query.cod_vendedor));

  const completos = eventos.filter(e => e.match.estado === 'completo');
  res.json({
    ok: true, year, month, rige: r.rige, eventos,
    resumen: {
      eventos: eventos.length,
      completos: completos.length,
      recargo_total: Math.round(completos.reduce((a, e) => a + (e.recargo ?? 0), 0) * 100) / 100,
      parciales: eventos.filter(e => e.match.estado === 'parcial').length,
      sin_factura: eventos.filter(e => e.match.estado === 'sin_factura').length,
      revisar: eventos.filter(e => e.match.estado === 'revisar').length,
    },
  });
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

/**
 * GET /api/rebotes?year&month[&cod_vendedor]
 * Vendedor: solo sus rebotes (cod_vendedor del JWT). Admin/gerente: todos,
 * con filtro opcional. Devuelve filas + resumen por motivo.
 */
export async function listRebotes(req: Request & { user?: JwtPayload }, res: Response): Promise<void> {
  if (!hasSupabase()) { res.status(500).json({ error: 'Supabase no configurado' }); return; }
  const user = req.user!;
  const nowART = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const year = Number(req.query.year) || nowART.getUTCFullYear();
  const month = Number(req.query.month) || nowART.getUTCMonth() + 1;
  const isAdmin = user.rol === 'admin' || user.rol === 'gerente';

  let q = sb().from('rebotes').select('*')
    .eq('tenant_id', TENANT_ID).eq('year', year).eq('month', month);
  if (!isAdmin) {
    // Vendedor sin cod_vendedor (no debería pasar): no ve nada, no todo.
    q = q.eq('cod_vendedor', user.cod_vendedor ?? -1);
  } else if (req.query.cod_vendedor) {
    q = q.eq('cod_vendedor', Number(req.query.cod_vendedor));
  }
  const { data, error } = await q
    .order('fecha', { ascending: false })
    .order('fila', { ascending: true });
  if (error) { res.status(500).json({ error: error.message }); return; }

  const rows = data ?? [];
  const porMotivo: Record<string, { filas: number; total: number }> = {};
  let total = 0;
  let ultimaSync: string | null = null;
  for (const r of rows) {
    const m = porMotivo[r.motivo] ?? (porMotivo[r.motivo] = { filas: 0, total: 0 });
    m.filas++;
    m.total = Math.round((m.total + (Number(r.total) || 0)) * 100) / 100;
    total = Math.round((total + (Number(r.total) || 0)) * 100) / 100;
    if (!ultimaSync || r.synced_at > ultimaSync) ultimaSync = r.synced_at;
  }
  res.json({
    ok: true, year, month, rows,
    resumen: {
      filas: rows.length,
      total,
      por_motivo: porMotivo,
      sin_clasificar: rows.filter((r: any) => r.motivo === 'sin_clasificar').length,
      clientes_sin_match: rows.filter((r: any) => r.cod_cliente == null).length,
      ultima_sync: ultimaSync,
    },
  });
}

/** POST /api/rebotes/sync-now — admin: fuerza el sync del sheet ya mismo. */
export async function syncRebotesNow(req: Request & { user?: JwtPayload }, res: Response): Promise<void> {
  const r = await syncRebotes({ importedBy: req.user?.sub ?? null });
  res.status(r.ok ? 200 : 500).json(r);
}
