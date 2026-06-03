/**
 * Override manual de vendedor por comprobante.
 *
 * Cuando una factura se emite en InfoManager con el vendedor equivocado y ya no
 * se puede editar (IM bloquea facturas emitidas), este override reasigna el
 * comprobante al vendedor correcto a efectos de comisiones/avance. NO toca IM ni
 * la cuenta corriente — es una corrección interna.
 *
 * Se consume desde los tres puntos que leen el cod_vendedor de la cabecera:
 *   - comisiones.ts     (/api/comisiones)
 *   - syncVentas.ts     (cron + backfill → vendor_sales_monthly)
 *   - goals.ts          (/api/goals/snapshot)
 * Igual que comisionesShared.ts: si los tres no aplican el mismo override, los
 * paneles divergen. Por eso la resolución vive acá, centralizada.
 */
import type { Request, Response } from 'express';
import type { JwtPayload } from './auth.js';
import { sb, TENANT_ID, hasSupabase } from './supabase.js';
import { invalidateAll as invalidateGoalsCache } from './goalsResponseCache.js';

/**
 * Resuelve el cod_vendedor efectivo de un comprobante aplicando overrides.
 * - Si hay override para ese id_comprobante → gana siempre (incluso sobre
 *   mostrador), porque la corrección manual es deliberada.
 * - Sin override: devuelve el crudo. Con `mostradorEsNull`, el vendedor 0
 *   (mostrador) se trata como null (descartado) — comportamiento de
 *   syncVentas/goals. comisiones.ts NO lo usa (deja pasar el 0 y filtra luego
 *   por COD_VENDEDORES_VISIBLES).
 * Función pura → testeable sin Supabase.
 */
export function resolveCodVendedor(
  rawCodVendedor: number | null | undefined,
  idComprobante: number,
  overrides: Map<number, number>,
  opts?: { mostradorEsNull?: boolean },
): number | null {
  const ov = overrides.get(idComprobante);
  if (ov != null) return ov;
  const raw = Number(rawCodVendedor);
  if (!Number.isFinite(raw)) return null;
  if (opts?.mostradorEsNull && raw === 0) return null;
  return raw;
}

// ─── Cache RAM del map de overrides ──────────────────────────────────────────
// Cambian muy poco; TTL corto + invalidación explícita al crear/borrar uno.
const TTL_MS = 60_000;
let cache: Map<number, number> | null = null;
let cacheAt = 0;
let pending: Promise<Map<number, number>> | null = null;

export function invalidateOverridesCache(): void {
  cache = null;
  cacheAt = 0;
}

/** Devuelve Map<id_comprobante, cod_vendedor>. Nunca lanza: ante error (ej.
 *  tabla aún no migrada) devuelve cache viejo o vacío para no romper comisiones. */
export async function loadVendedorOverrides(): Promise<Map<number, number>> {
  if (!hasSupabase()) return new Map();
  const now = Date.now();
  if (cache && now - cacheAt < TTL_MS) return cache;
  if (pending) return pending;
  pending = (async () => {
    try {
      const { data, error } = await sb()
        .from('comision_vendedor_override')
        .select('id_comprobante, cod_vendedor')
        .eq('tenant_id', TENANT_ID);
      if (error) throw new Error(error.message);
      const m = new Map<number, number>();
      for (const r of data ?? []) {
        const id = Number((r as any).id_comprobante);
        const cv = Number((r as any).cod_vendedor);
        if (Number.isFinite(id) && Number.isFinite(cv)) m.set(id, cv);
      }
      cache = m;
      cacheAt = Date.now();
      return m;
    } catch (err: any) {
      console.warn('[comisionOverrides] load falló, sigo sin overrides:', err?.message ?? err);
      return cache ?? new Map<number, number>();
    } finally {
      pending = null;
    }
  })();
  return pending;
}

// ─── HTTP handlers (admin) ───────────────────────────────────────────────────

/** GET /api/comisiones/overrides — lista todos los overrides del tenant. */
export async function listOverrides(_req: Request, res: Response): Promise<void> {
  if (!hasSupabase()) { res.status(500).json({ error: 'Supabase no configurado' }); return; }
  try {
    const { data, error } = await sb()
      .from('comision_vendedor_override')
      .select('id_comprobante, cod_vendedor, cod_vendedor_original, motivo, created_by, created_at, updated_at')
      .eq('tenant_id', TENANT_ID)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    res.json({ ok: true, items: data ?? [] });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/** POST /api/comisiones/overrides — crea/actualiza un override.
 *  body: { id_comprobante, cod_vendedor, cod_vendedor_original?, motivo? } */
export async function addOverride(req: Request & { user?: JwtPayload }, res: Response): Promise<void> {
  if (!hasSupabase()) { res.status(500).json({ error: 'Supabase no configurado' }); return; }
  const idComp = Number(req.body?.id_comprobante);
  const codVend = Number(req.body?.cod_vendedor);
  if (!Number.isInteger(idComp) || idComp <= 0) {
    res.status(400).json({ error: 'id_comprobante inválido' }); return;
  }
  if (!Number.isInteger(codVend) || codVend <= 0) {
    res.status(400).json({ error: 'cod_vendedor inválido' }); return;
  }
  const codVendOrig = req.body?.cod_vendedor_original != null ? Number(req.body.cod_vendedor_original) : null;
  const motivo = req.body?.motivo != null ? String(req.body.motivo).slice(0, 500) : null;
  try {
    const { error } = await sb()
      .from('comision_vendedor_override')
      .upsert({
        tenant_id: TENANT_ID,
        id_comprobante: idComp,
        cod_vendedor: codVend,
        cod_vendedor_original: Number.isFinite(codVendOrig as number) ? codVendOrig : null,
        motivo,
        created_by: req.user?.sub ?? null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'tenant_id,id_comprobante' });
    if (error) throw new Error(error.message);
    invalidateOverridesCache();
    invalidateGoalsCache();
    res.json({ ok: true, id_comprobante: idComp, cod_vendedor: codVend, motivo });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/** DELETE /api/comisiones/overrides/:id — elimina un override por id_comprobante. */
export async function deleteOverride(req: Request, res: Response): Promise<void> {
  if (!hasSupabase()) { res.status(500).json({ error: 'Supabase no configurado' }); return; }
  const idComp = Number(req.params?.id);
  if (!Number.isInteger(idComp) || idComp <= 0) {
    res.status(400).json({ error: 'id_comprobante inválido' }); return;
  }
  try {
    const { error } = await sb()
      .from('comision_vendedor_override')
      .delete()
      .eq('tenant_id', TENANT_ID)
      .eq('id_comprobante', idComp);
    if (error) throw new Error(error.message);
    invalidateOverridesCache();
    invalidateGoalsCache();
    res.json({ ok: true, deleted: idComp });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}
