// ═══════════════════════════════════════════════════════════════════════════
// Objetivos por producto (Feature B).
//
// Un objetivo es una FAMILIA: un nombre + N artículos que suman a la misma meta
// en UNIDADES (migración 016). Ej: "Barras Monkey" = 20 cajas que se cumplen
// vendiendo cualquiera de las 5 variedades. Un producto suelto es simplemente
// una familia de 1 artículo. Opcionalmente la familia lleva una comisión
// ESPECIAL ese mes (comision_pct) que pisa la regla de comisionesRules.ts para
// TODOS sus artículos y ese vendedor — lo consume comisiones.ts vía
// getComisionPctOverrides. El avance NO se persiste: se calcula en vivo desde
// los renglones de venta del snapshotCache, con los MISMOS filtros que
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

// ─── Agregado por familia/grupo (puro, testeable) ────────────────────────────

export interface GrupoArticulos { id: string; cod_vendedor: number; articulos: number[] }
export interface AvanceGrupo { unidades: number; neto: number }

/**
 * Suma el avance de cada familia a partir del avance por (vendedor, artículo):
 * las unidades de todos los artículos de la familia van a la misma meta. Un
 * artículo sin ventas simplemente no suma. Devuelve Map grupo_id → avance.
 */
export function calcAvancePorGrupo(
  grupos: GrupoArticulos[],
  ventasPorArt: Map<string, VentaPorProducto>,
): Map<string, AvanceGrupo> {
  const out = new Map<string, AvanceGrupo>();
  for (const g of grupos) {
    let unidades = 0, neto = 0;
    for (const codArt of g.articulos) {
      const v = ventasPorArt.get(`${g.cod_vendedor}:${codArt}`);
      if (v) { unidades += v.unidades; neto += v.neto; }
    }
    out.set(g.id, {
      unidades: Math.round(unidades * 100) / 100,
      neto: Math.round(neto * 100) / 100,
    });
  }
  return out;
}

// ─── Validación del alta/edición (pura, testeable) ───────────────────────────

export interface UpsertGrupoInput {
  year: number; month: number;
  cod_vendedor: number;
  nombre?: string | null;
  target_unidades: number;
  comision_pct?: number | string | null;
  cod_articulos: number[];
}
export interface UpsertGrupoNormalizado {
  year: number; month: number;
  cod_vendedor: number;
  nombre: string | null;   // null = derivar del catálogo (familia de 1)
  target: number;
  pct: number | null;
  codArticulos: number[];  // enteros, deduplicados, orden de entrada
}

/**
 * Valida y normaliza el body de un alta/edición de familia SIN tocar IO (ni IM
 * ni Supabase). Devuelve `{ ok, error }` para responder 400 con mensaje claro,
 * o `{ ok, value }` con los datos ya saneados. El nombre queda null cuando hay
 * un solo artículo y no se dio nombre: el caller lo completa con el catálogo.
 */
export function validarUpsertGrupo(body: Partial<UpsertGrupoInput>): { ok: false; error: string } | { ok: true; value: UpsertGrupoNormalizado } {
  const year = Number(body.year), month = Number(body.month);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return { ok: false, error: 'year/month inválidos' };
  }
  const codVendedor = Number(body.cod_vendedor);
  if (!COD_VENDEDORES_VISIBLES.has(codVendedor)) {
    return { ok: false, error: `cod_vendedor ${body.cod_vendedor} no es un vendedor visible` };
  }
  const target = Number(body.target_unidades);
  if (!Number.isFinite(target) || target <= 0) {
    return { ok: false, error: 'target_unidades debe ser > 0' };
  }
  const pctRaw = body.comision_pct;
  const pct = pctRaw == null || pctRaw === '' ? null : Number(pctRaw);
  if (pct != null && (!Number.isFinite(pct) || pct <= 0 || pct > 0.2)) {
    return { ok: false, error: 'comision_pct debe ser una fracción entre 0 y 0.2 (0.05 = 5%)' };
  }
  // Artículos: al menos 1, enteros, deduplicados conservando el orden.
  const raw = Array.isArray(body.cod_articulos) ? body.cod_articulos : [];
  const codArticulos: number[] = [];
  const vistos = new Set<number>();
  for (const c of raw) {
    const n = Math.trunc(Number(c));
    if (!Number.isFinite(n) || n <= 0) return { ok: false, error: `Código de artículo inválido: ${c}` };
    if (!vistos.has(n)) { vistos.add(n); codArticulos.push(n); }
  }
  if (codArticulos.length === 0) {
    return { ok: false, error: 'La familia necesita al menos un artículo' };
  }
  const nombreRaw = (body.nombre ?? '').toString().trim();
  if (nombreRaw === '' && codArticulos.length > 1) {
    return { ok: false, error: 'Ponele un nombre a la familia (ej: "Barras Monkey")' };
  }
  return {
    ok: true,
    value: { year, month, cod_vendedor: codVendedor, nombre: nombreRaw || null, target, pct, codArticulos },
  };
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

// ─── Lectura de familias desde Supabase (grupos + artículos) ─────────────────

interface GrupoDb {
  id: string;
  cod_vendedor: number;
  nombre: string;
  target_unidades: number;
  comision_pct: number | null;
  articulos: Array<{ cod_articulo: number; descripcion: string | null }>;
}

/** Trae las familias del mes (opcionalmente de un vendedor) con sus artículos. */
async function fetchGruposDelMes(year: number, month: number, codVendedor?: number): Promise<GrupoDb[]> {
  let q = sb().from('product_goal_grupos')
    .select('id, cod_vendedor, nombre, target_unidades, comision_pct, product_goal_articulos(cod_articulo, descripcion)')
    .eq('tenant_id', TENANT_ID).eq('year', year).eq('month', month);
  if (codVendedor != null) q = q.eq('cod_vendedor', codVendedor);
  const { data, error } = await q.order('cod_vendedor').order('nombre');
  if (error) throw new Error(error.message);
  return (data ?? []).map((g: any) => ({
    id: String(g.id),
    cod_vendedor: Number(g.cod_vendedor),
    nombre: String(g.nombre),
    target_unidades: Number(g.target_unidades),
    comision_pct: g.comision_pct != null ? Number(g.comision_pct) : null,
    articulos: (g.product_goal_articulos ?? [])
      .map((a: any) => ({ cod_articulo: Number(a.cod_articulo), descripcion: a.descripcion ?? null }))
      .sort((a: any, b: any) => a.cod_articulo - b.cod_articulo),
  }));
}

// ─── Overrides de % para comisiones.ts ───────────────────────────────────────

/**
 * Expande las familias con comisión especial a un Map `${vendedor}:${artículo}`
 * → pct: cada artículo de la familia hereda el % (la comisión especial rige
 * para toda la familia). Puro y testeable, sin IO. Ignora filas sin pct válido.
 */
export function expandirComisionOverrides(
  grupos: Array<{ cod_vendedor: any; comision_pct: any; product_goal_articulos?: Array<{ cod_articulo: any }> | null }>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const g of grupos) {
    const pct = Number(g.comision_pct);
    if (!Number.isFinite(pct) || pct <= 0) continue;
    const codVend = Number(g.cod_vendedor);
    for (const a of g.product_goal_articulos ?? []) {
      const codArt = Number(a.cod_articulo);
      if (Number.isFinite(codArt)) out.set(`${codVend}:${codArt}`, pct);
    }
  }
  return out;
}

/**
 * Map `${cod_vendedor}:${cod_articulo}` → comision_pct de las familias del mes
 * que definen comisión especial, expandida a todos sus artículos. Error de
 * query → mapa vacío con log (la línea comisiona con su regla normal,
 * comportamiento pre-feature).
 */
export async function getComisionPctOverrides(year: number, month: number): Promise<Map<string, number>> {
  if (!hasSupabase()) return new Map<string, number>();
  // Orden estable por si (carrera improbable de dos altas concurrentes) un
  // artículo quedara en dos familias con pct distinto: gana la más reciente,
  // no el orden arbitrario de filas de Postgres (last-wins en expandir...).
  const { data, error } = await sb().from('product_goal_grupos')
    .select('cod_vendedor, comision_pct, updated_at, product_goal_articulos(cod_articulo)')
    .eq('tenant_id', TENANT_ID).eq('year', year).eq('month', month)
    .not('comision_pct', 'is', null)
    .order('updated_at', { ascending: true });
  if (error) {
    console.error('[productGoals] getComisionPctOverrides:', error.message);
    return new Map<string, number>();
  }
  return expandirComisionOverrides(data ?? []);
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

/**
 * GET /api/product-goals?year&month[&cod_vendedor]
 * Familias con objetivo + avance en vivo. Vendedor ve solo las suyas.
 */
export async function listProductGoals(req: Request & { user?: JwtPayload }, res: Response): Promise<void> {
  if (!hasSupabase()) { res.status(500).json({ error: 'Supabase no configurado' }); return; }
  const user = req.user!;
  const nowART = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const year = Number(req.query.year) || nowART.getUTCFullYear();
  const month = Number(req.query.month) || nowART.getUTCMonth() + 1;
  const isAdmin = user.rol === 'admin' || user.rol === 'gerente';

  let grupos: GrupoDb[];
  try {
    const codVendFilter = !isAdmin
      ? (user.cod_vendedor ?? -1)
      : (req.query.cod_vendedor ? Number(req.query.cod_vendedor) : undefined);
    grupos = await fetchGruposDelMes(year, month, codVendFilter);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) }); return;
  }
  if (!grupos.length) { res.json({ ok: true, year, month, items: [] }); return; }

  // Avance en vivo, solo para los pares (vendedor, artículo) con objetivo.
  const soloKeys = new Set<string>();
  for (const g of grupos) for (const a of g.articulos) soloKeys.add(`${g.cod_vendedor}:${a.cod_articulo}`);
  let ventas = new Map<string, VentaPorProducto>();
  let avancePorGrupo = new Map<string, AvanceGrupo>();
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
    avancePorGrupo = calcAvancePorGrupo(
      grupos.map(g => ({ id: g.id, cod_vendedor: g.cod_vendedor, articulos: g.articulos.map(a => a.cod_articulo) })),
      ventas,
    );
  } catch (e: any) {
    // IM caído: devolvemos los objetivos sin avance, con aviso.
    avanceError = e?.message ?? String(e);
  }

  const items = grupos.map(g => {
    const av = avancePorGrupo.get(g.id) ?? { unidades: 0, neto: 0 };
    const target = g.target_unidades;
    return {
      id: g.id,
      cod_vendedor: g.cod_vendedor,
      nombre: g.nombre,
      articulos: g.articulos.map(a => ({
        cod_articulo: a.cod_articulo,
        descripcion: a.descripcion ?? catalogo?.get(a.cod_articulo)?.descripcion ?? `Artículo ${a.cod_articulo}`,
      })),
      target_unidades: target,
      comision_pct: g.comision_pct,
      unidades_vendidas: av.unidades,
      neto_vendido: av.neto,
      pct_cumplimiento: target > 0 ? Math.round((av.unidades / target) * 1000) / 1000 : null,
      restante: Math.max(0, Math.round((target - av.unidades) * 100) / 100),
    };
  });

  res.json({ ok: true, year, month, items, avance_error: avanceError });
}

/**
 * POST /api/product-goals (admin) — crea una familia (nombre + N artículos).
 * Body: { year, month, cod_vendedor, nombre?, target_unidades, comision_pct?, cod_articulos: number[] }
 * comision_pct en fracción (0.05 = 5%); null/ausente = rige la regla normal.
 * Para cambiar una familia se borra y se crea de nuevo (la UI no edita in-place).
 */
export async function upsertProductGoal(req: Request & { user?: JwtPayload }, res: Response): Promise<void> {
  if (!hasSupabase()) { res.status(500).json({ error: 'Supabase no configurado' }); return; }
  const parsed = validarUpsertGrupo(req.body ?? {});
  if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }
  const g = parsed.value;

  // Validar cada artículo contra el catálogo IM (corta typos de código) y
  // resolver descripciones. Si IM está caído, no bloqueamos.
  const descripciones = new Map<number, string | null>();
  try {
    const cat = await fetchArticulosCatalogo();
    for (const cod of g.codArticulos) {
      const art = cat.get(cod);
      if (!art) { res.status(400).json({ error: `El artículo ${cod} no existe en el catálogo de InfoManager` }); return; }
      descripciones.set(cod, art.descripcion ?? null);
    }
  } catch { /* IM caído: seguimos sin validar */ }

  // Nombre: si es familia de 1 sin nombre, usar la descripción del catálogo.
  const nombre = g.nombre ?? descripciones.get(g.codArticulos[0]) ?? `Artículo ${g.codArticulos[0]}`;

  // Ningún artículo puede estar ya en otra familia del mismo (vendedor, mes):
  // contaría su avance dos veces.
  try {
    const { data: otros, error } = await sb().from('product_goal_grupos')
      .select('product_goal_articulos(cod_articulo)')
      .eq('tenant_id', TENANT_ID).eq('year', g.year).eq('month', g.month).eq('cod_vendedor', g.cod_vendedor);
    if (error) { res.status(500).json({ error: error.message }); return; }
    const usados = new Set<number>();
    for (const o of otros ?? []) for (const a of (o as any).product_goal_articulos ?? []) usados.add(Number(a.cod_articulo));
    const colision = g.codArticulos.find(c => usados.has(c));
    if (colision != null) {
      res.status(400).json({ error: `El artículo ${colision} ya está en otro objetivo de este vendedor este mes` });
      return;
    }
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) }); return;
  }

  // Alta de la familia (cabecera + artículos). Para cambiar una familia se borra
  // y se crea de nuevo — la UI no edita in-place, así que no hay ruta de update.
  const { data, error } = await sb().from('product_goal_grupos').insert({
    tenant_id: TENANT_ID, year: g.year, month: g.month, cod_vendedor: g.cod_vendedor,
    nombre, target_unidades: g.target, comision_pct: g.pct, set_by: req.user?.sub ?? null,
  }).select('id').single();
  if (error || !data) { res.status(500).json({ error: error?.message ?? 'no se pudo crear la familia' }); return; }
  const grupoId = String((data as any).id);

  const filas = g.codArticulos.map(cod => ({ grupo_id: grupoId, cod_articulo: cod, descripcion: descripciones.get(cod) ?? null }));
  const { error: artErr } = await sb().from('product_goal_articulos').insert(filas);
  if (artErr) {
    // La cabecera quedaría sin artículos: la borro para no dejar una familia huérfana.
    await sb().from('product_goal_grupos').delete().eq('tenant_id', TENANT_ID).eq('id', grupoId);
    res.status(500).json({ error: artErr.message }); return;
  }

  invalidateGoalsCache(); // la comisión especial impacta /api/comisiones cacheado
  res.json({ ok: true, id: grupoId });
}

/** DELETE /api/product-goals?id=<grupo_id> (admin). Cascade borra los artículos. */
export async function deleteProductGoal(req: Request & { user?: JwtPayload }, res: Response): Promise<void> {
  if (!hasSupabase()) { res.status(500).json({ error: 'Supabase no configurado' }); return; }
  const id = String(req.query.id ?? '').trim();
  if (!id) { res.status(400).json({ error: 'id (del objetivo) es requerido' }); return; }
  const { error } = await sb().from('product_goal_grupos').delete()
    .eq('tenant_id', TENANT_ID).eq('id', id);
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
