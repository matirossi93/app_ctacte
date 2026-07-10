// ═══════════════════════════════════════════════════════════════════════════
// Objetivos por producto (Feature B, fase 4).
//
// Mati fija a cada vendedor cuántas UNIDADES de un producto estancado tiene
// que vender en el mes (tabla product_goals, migración 015), opcionalmente
// con una comisión ESPECIAL para ese artículo ese mes (comision_pct pisa la
// regla de comisionesRules.ts — lo consume comisiones.ts vía
// getComisionPctOverrides). El avance NO se persiste: se calcula en vivo
// desde los renglones de venta del snapshotCache, con los MISMOS filtros que
// comisiones (Casa Central, FA/NC, clientes internos afuera, overrides de
// vendedor) para que ambos paneles nunca diverjan.
// ═══════════════════════════════════════════════════════════════════════════
import type { Request, Response } from 'express';
import { sb, TENANT_ID, hasSupabase } from './supabase.js';
import { getMonthlyVentasRaw, getMonthlyItemsRaw } from './snapshotCache.js';
import { fetchArticulosCatalogo } from './infomanager.js';
import { loadVendedorOverrides, resolveCodVendedor } from './comisionOverrides.js';
import {
  clasificarCabeceraComision, COD_EMPRESA_CASA_CENTRAL, COD_CLIENTES_INTERNOS, COD_VENDEDORES_VISIBLES,
} from './comisionesShared.js';
import { pctParaArticulo } from './comisionesRules.js';
import { invalidateAll as invalidateGoalsCache } from './goalsResponseCache.js';
import type { JwtPayload } from './auth.js';

// ─── Agregado de unidades vendidas (puro, testeable) ─────────────────────────

export interface VentaPorProducto { unidades: number; neto: number }

/**
 * Suma unidades y neto por (vendedor, artículo) a partir de las cabeceras ya
 * clasificadas y los renglones crudos. Las NC restan unidades (una devolución
 * facturada baja el avance del objetivo, igual que baja la comisión).
 * `soloKeys` limita el agregado a los pares con objetivo definido.
 */
export function calcUnidadesPorVendedorArticulo(
  cabMeta: Map<number, { sign: 1 | -1; cod_vendedor: number }>,
  items: Array<{ id_comprobante: any; cod_articulo: any; cantidad: any; importe?: any }>,
  soloKeys?: Set<string>,
): Map<string, VentaPorProducto> {
  const out = new Map<string, VentaPorProducto>();
  for (const it of items) {
    const meta = cabMeta.get(Number(it.id_comprobante));
    if (!meta) continue;
    const codArt = Number(it.cod_articulo);
    if (!Number.isFinite(codArt)) continue;
    const key = `${meta.cod_vendedor}:${codArt}`;
    if (soloKeys && !soloKeys.has(key)) continue;
    const cant = Number(it.cantidad ?? 0);
    const imp = Number(it.importe ?? 0);
    let acc = out.get(key);
    if (!acc) { acc = { unidades: 0, neto: 0 }; out.set(key, acc); }
    if (Number.isFinite(cant)) acc.unidades += cant * meta.sign;
    if (Number.isFinite(imp)) acc.neto += imp * meta.sign;
  }
  for (const acc of out.values()) {
    acc.unidades = Math.round(acc.unidades * 100) / 100;
    acc.neto = Math.round(acc.neto * 100) / 100;
  }
  return out;
}

// ─── Cabeceras del mes con los filtros de comisiones ─────────────────────────

async function buildCabMeta(year: number, month: number): Promise<Map<number, { sign: 1 | -1; cod_vendedor: number }>> {
  const [ventasRes, overrides] = await Promise.all([
    getMonthlyVentasRaw(year, month),
    loadVendedorOverrides(),
  ]);
  const map = new Map<number, { sign: 1 | -1; cod_vendedor: number }>();
  for (const v of ventasRes.ventas as any[]) {
    const id = Number(v.id);
    if (!Number.isFinite(id)) continue;
    const codEmp = Number(v.cod_empresa);
    if (Number.isFinite(codEmp) && codEmp !== COD_EMPRESA_CASA_CENTRAL) continue;
    const clase = clasificarCabeceraComision(v);
    if (!clase) continue;
    const codVend = resolveCodVendedor(v.cod_vendedor, id, overrides);
    if (codVend == null) continue;
    const codCli = Number(v.cod_cliente);
    if (Number.isFinite(codCli) && COD_CLIENTES_INTERNOS.has(codCli)) continue;
    map.set(id, { sign: clase === 'NC' ? -1 : 1, cod_vendedor: codVend });
  }
  return map;
}

// ─── Overrides de % para comisiones.ts ───────────────────────────────────────

/**
 * Map `${cod_vendedor}:${cod_articulo}` → comision_pct de los objetivos por
 * producto del mes que definen comisión especial. Error de query → mapa vacío
 * con log (la línea comisiona con su regla normal, comportamiento pre-feature).
 */
export async function getComisionPctOverrides(year: number, month: number): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!hasSupabase()) return out;
  const { data, error } = await sb().from('product_goals')
    .select('cod_vendedor, cod_articulo, comision_pct')
    .eq('tenant_id', TENANT_ID).eq('year', year).eq('month', month)
    .not('comision_pct', 'is', null);
  if (error) {
    console.error('[productGoals] getComisionPctOverrides:', error.message);
    return out;
  }
  for (const r of data ?? []) {
    const pct = Number(r.comision_pct);
    if (Number.isFinite(pct) && pct > 0) out.set(`${r.cod_vendedor}:${r.cod_articulo}`, pct);
  }
  return out;
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

/**
 * GET /api/product-goals?year&month[&cod_vendedor]
 * Objetivos por producto + avance en vivo. Vendedor ve solo los suyos.
 */
export async function listProductGoals(req: Request & { user?: JwtPayload }, res: Response): Promise<void> {
  if (!hasSupabase()) { res.status(500).json({ error: 'Supabase no configurado' }); return; }
  const user = req.user!;
  const nowART = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const year = Number(req.query.year) || nowART.getUTCFullYear();
  const month = Number(req.query.month) || nowART.getUTCMonth() + 1;
  const isAdmin = user.rol === 'admin' || user.rol === 'gerente';

  let q = sb().from('product_goals').select('*')
    .eq('tenant_id', TENANT_ID).eq('year', year).eq('month', month);
  if (!isAdmin) q = q.eq('cod_vendedor', user.cod_vendedor ?? -1);
  else if (req.query.cod_vendedor) q = q.eq('cod_vendedor', Number(req.query.cod_vendedor));
  const { data: goals, error } = await q.order('cod_vendedor').order('cod_articulo');
  if (error) { res.status(500).json({ error: error.message }); return; }
  if (!goals?.length) { res.json({ ok: true, year, month, items: [] }); return; }

  // Avance en vivo, solo para los pares con objetivo.
  const soloKeys = new Set(goals.map((g: any) => `${g.cod_vendedor}:${g.cod_articulo}`));
  let ventas = new Map<string, VentaPorProducto>();
  let catalogo: Awaited<ReturnType<typeof fetchArticulosCatalogo>> | null = null;
  let avanceError: string | undefined;
  try {
    const [cabMeta, itemsRes, cat] = await Promise.all([
      buildCabMeta(year, month),
      getMonthlyItemsRaw(year, month),
      fetchArticulosCatalogo().catch(() => null),
    ]);
    catalogo = cat;
    ventas = calcUnidadesPorVendedorArticulo(cabMeta, itemsRes.items, soloKeys);
  } catch (e: any) {
    // IM caído: devolvemos los objetivos sin avance, con aviso.
    avanceError = e?.message ?? String(e);
  }

  const items = goals.map((g: any) => {
    const v = ventas.get(`${g.cod_vendedor}:${g.cod_articulo}`) ?? { unidades: 0, neto: 0 };
    const target = Number(g.target_unidades);
    return {
      cod_vendedor: g.cod_vendedor,
      cod_articulo: g.cod_articulo,
      descripcion: g.descripcion ?? catalogo?.get(g.cod_articulo)?.descripcion ?? `Artículo ${g.cod_articulo}`,
      target_unidades: target,
      comision_pct: g.comision_pct != null ? Number(g.comision_pct) : null,
      unidades_vendidas: v.unidades,
      neto_vendido: v.neto,
      pct_cumplimiento: target > 0 ? Math.round((v.unidades / target) * 1000) / 1000 : null,
      restante: Math.max(0, Math.round((target - v.unidades) * 100) / 100),
    };
  });

  res.json({ ok: true, year, month, items, avance_error: avanceError });
}

/**
 * POST /api/product-goals (admin)
 * Body: { year, month, cod_vendedor, cod_articulo, target_unidades, comision_pct? }
 * comision_pct en fracción (0.05 = 5%); null/ausente = rige la regla normal.
 */
export async function upsertProductGoal(req: Request & { user?: JwtPayload }, res: Response): Promise<void> {
  if (!hasSupabase()) { res.status(500).json({ error: 'Supabase no configurado' }); return; }
  const b = req.body ?? {};
  const year = Number(b.year), month = Number(b.month);
  const codVendedor = Number(b.cod_vendedor), codArticulo = Number(b.cod_articulo);
  const target = Number(b.target_unidades);
  const pctRaw = b.comision_pct;
  const pct = pctRaw == null || pctRaw === '' ? null : Number(pctRaw);

  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    res.status(400).json({ error: 'year/month inválidos' }); return;
  }
  if (!COD_VENDEDORES_VISIBLES.has(codVendedor)) {
    res.status(400).json({ error: `cod_vendedor ${b.cod_vendedor} no es un vendedor visible` }); return;
  }
  if (!Number.isFinite(target) || target <= 0) {
    res.status(400).json({ error: 'target_unidades debe ser > 0' }); return;
  }
  if (pct != null && (!Number.isFinite(pct) || pct <= 0 || pct > 0.2)) {
    res.status(400).json({ error: 'comision_pct debe ser una fracción entre 0 y 0.2 (0.05 = 5%)' }); return;
  }

  // Validar contra el catálogo IM: corta typos de código antes de que un
  // objetivo apunte a un artículo inexistente. Si IM está caído, no bloqueamos.
  let descripcion: string | null = null;
  try {
    const cat = await fetchArticulosCatalogo();
    const art = cat.get(Math.trunc(codArticulo));
    if (!art) { res.status(400).json({ error: `El artículo ${codArticulo} no existe en el catálogo de InfoManager` }); return; }
    descripcion = art.descripcion ?? null;
  } catch { /* IM caído: seguimos sin validar */ }

  const { error } = await sb().from('product_goals').upsert({
    tenant_id: TENANT_ID, year, month,
    cod_vendedor: codVendedor, cod_articulo: Math.trunc(codArticulo),
    target_unidades: target, comision_pct: pct, descripcion,
    set_by: req.user?.sub ?? null, updated_at: new Date().toISOString(),
  }, { onConflict: 'tenant_id,year,month,cod_vendedor,cod_articulo' });
  if (error) { res.status(500).json({ error: error.message }); return; }
  invalidateGoalsCache(); // la comisión especial impacta /api/comisiones cacheado
  res.json({ ok: true });
}

/** DELETE /api/product-goals?year&month&cod_vendedor&cod_articulo (admin) */
export async function deleteProductGoal(req: Request & { user?: JwtPayload }, res: Response): Promise<void> {
  if (!hasSupabase()) { res.status(500).json({ error: 'Supabase no configurado' }); return; }
  const year = Number(req.query.year), month = Number(req.query.month);
  const codVendedor = Number(req.query.cod_vendedor), codArticulo = Number(req.query.cod_articulo);
  if (![year, month, codVendedor, codArticulo].every(Number.isFinite)) {
    res.status(400).json({ error: 'year, month, cod_vendedor y cod_articulo son requeridos' }); return;
  }
  const { error } = await sb().from('product_goals').delete()
    .eq('tenant_id', TENANT_ID).eq('year', year).eq('month', month)
    .eq('cod_vendedor', codVendedor).eq('cod_articulo', codArticulo);
  if (error) { res.status(500).json({ error: error.message }); return; }
  invalidateGoalsCache();
  res.json({ ok: true });
}

/**
 * GET /api/product-goals/articulos?q= (admin) — buscador para el alta:
 * matchea por código exacto o descripción (case/acentos-insensitive), top 20.
 */
export async function searchArticulos(req: Request & { user?: JwtPayload }, res: Response): Promise<void> {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) { res.json({ ok: true, items: [] }); return; }
  let cat: Awaited<ReturnType<typeof fetchArticulosCatalogo>>;
  try {
    cat = await fetchArticulosCatalogo();
  } catch (e: any) {
    res.status(502).json({ error: `Catálogo IM no disponible: ${e?.message ?? e}` }); return;
  }
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  const qn = norm(q);
  const qNum = Number(q);
  const items: any[] = [];
  for (const [cod, a] of cat.entries()) {
    const desc = String(a.descripcion ?? '');
    if (cod === qNum || norm(desc).includes(qn)) {
      items.push({
        cod_articulo: cod,
        descripcion: desc,
        cod_rubro: a.cod_rubro ?? null,
        precio_venta: a.precio_venta ?? null,
        pct_normal: pctParaArticulo(cod, a.cod_rubro ?? null, desc),
      });
      if (items.length >= 20) break;
    }
  }
  res.json({ ok: true, items });
}
