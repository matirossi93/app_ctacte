import { fetchVentas, fetchVentasItems, type VentaRaw, type VentaItem } from './infomanager.js';

/**
 * Cache RAM del dataset CRUDO de ventas por mes calendario completo.
 *
 * Por qué crudo (y no agregado): el endpoint /api/goals/snapshot necesita
 * recortar a una fecha arbitraria del mes (asOfDate). Si cacheáramos el
 * agregado, una sola vista (corte = último día del mes) sería suficiente,
 * pero los cortes intermedios (Mié 02, Mié 09, Mié 16…) necesitarían refetch.
 * Cacheando el dataset crudo, cualquier corte se calcula como filtro O(n)
 * sobre el array sin tocar InfoManager.
 *
 * Para reuniones de equipo donde un usuario puede cambiar la fecha de corte
 * 4-5 veces seguidas en pocos minutos, esto es la diferencia entre 3-5s por
 * vista y <100ms por vista.
 *
 * Key incluye codEmpresa para soportar futuro multi-empresa (Casa Central
 * vs BRS San Martín).
 *
 * ── Stale-while-revalidate ─────────────────────────────────────────────────
 * Cuando una entrada vence (excede su TTL), en vez de hacer fetch sincrónico
 * (que puede tardar 30-60s para meses pesados) devolvemos el dato stale y
 * disparamos un refresh en background. La próxima request recibe el dato
 * fresco. Esto elimina los picos de latencia de 30-60s que ocurrían cada
 * vez que un mes histórico expiraba.
 *
 * El primer fetch absoluto (entrada nunca poblada) sí espera sincrónico
 * — no hay nada que servir mientras tanto.
 */

interface CachedDataset {
    ventas: VentaRaw[];
    fetchedAt: number;
    isHistoric: boolean;
}

// Mes actual: TTL corto. Cambia continuamente (nuevas ventas, NCs).
// Mes pasado: TTL largo. Sólo cambia ante NCs tardías que el cron 0 4 * * *
//   regenera al re-syncear los últimos 6 meses; para el rango entre crons,
//   el dataset es estable.
const TTL_CURRENT_MS = 5 * 60 * 1000;        // 5 min mes actual
const TTL_HISTORIC_MS = 24 * 60 * 60 * 1000; // 24h meses pasados
const cache = new Map<string, CachedDataset>();
// Marcamos las keys con refresh en vuelo para no disparar N refreshes
// concurrentes del mismo mes desde N requests simultáneas.
const inflightVentas = new Set<string>();
const inflightItems = new Set<string>();

function makeKey(year: number, month: number, codEmpresa?: number): string {
    return `${year}-${String(month).padStart(2, '0')}-emp${codEmpresa ?? 'all'}`;
}

function ymdMonthEnd(year: number, month: number): string {
    const lastDay = new Date(year, month, 0).getDate();
    return `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

/**
 * Devuelve las ventas crudas del mes (1..últimoDía).
 * - Cache fresco: devuelve cached, no toca IM.
 * - Cache vencido: devuelve stale + refresh background (no espera).
 * - Cache vacío: fetch sincrónico (única espera larga posible).
 * Si force=true bypaseamos el cache. Si nocache=true tampoco se escribe.
 */
export async function getMonthlyVentasRaw(
    year: number,
    month: number,
    opts?: { codEmpresa?: number; force?: boolean; nocache?: boolean }
): Promise<{ ventas: VentaRaw[]; cached: boolean; cacheAge: number }> {
    const key = makeKey(year, month, opts?.codEmpresa);
    const now = Date.now();
    const nowD = new Date();
    const isCurrent = year === nowD.getUTCFullYear() && month === (nowD.getUTCMonth() + 1);
    const ttl = isCurrent ? TTL_CURRENT_MS : TTL_HISTORIC_MS;
    const existing = cache.get(key);
    const age = existing ? now - existing.fetchedAt : Infinity;
    const fresh = !!existing && age < ttl;

    if (!opts?.force && fresh) {
        return { ventas: existing!.ventas, cached: true, cacheAge: age };
    }

    if (!opts?.force && existing && !fresh) {
        // Stale-while-revalidate: devolvemos lo viejo y refrescamos en background.
        if (!inflightVentas.has(key)) {
            inflightVentas.add(key);
            void refreshVentasBackground(year, month, opts).finally(() => inflightVentas.delete(key));
        }
        return { ventas: existing.ventas, cached: true, cacheAge: age };
    }

    // Sin entrada previa: fetch sincrónico.
    const desde = `${year}-${String(month).padStart(2, '0')}-01`;
    const hasta = ymdMonthEnd(year, month);
    const ventas = await fetchVentas(desde, hasta, { codEmpresa: opts?.codEmpresa });
    if (!opts?.nocache) {
        cache.set(key, { ventas, fetchedAt: now, isHistoric: !isCurrent });
    }
    return { ventas, cached: false, cacheAge: 0 };
}

async function refreshVentasBackground(
    year: number,
    month: number,
    opts?: { codEmpresa?: number },
): Promise<void> {
    try {
        const desde = `${year}-${String(month).padStart(2, '0')}-01`;
        const hasta = ymdMonthEnd(year, month);
        const t0 = Date.now();
        const ventas = await fetchVentas(desde, hasta, { codEmpresa: opts?.codEmpresa });
        const isCurrent = (() => {
            const d = new Date();
            return year === d.getUTCFullYear() && month === (d.getUTCMonth() + 1);
        })();
        cache.set(makeKey(year, month, opts?.codEmpresa), {
            ventas,
            fetchedAt: Date.now(),
            isHistoric: !isCurrent,
        });
        console.log(`[snapshot SWR] refreshed ventas ${year}-${String(month).padStart(2, '0')} (${ventas.length} en ${Date.now() - t0}ms)`);
    } catch (e: any) {
        console.warn(`[snapshot SWR] fallo refresh ventas ${year}-${String(month).padStart(2, '0')}: ${e?.message ?? e}`);
    }
}

/** Invalida explícitamente la entrada de cache (ej. tras un sync forzado). */
export function invalidateMonth(year: number, month: number, codEmpresa?: number): void {
    cache.delete(makeKey(year, month, codEmpresa));
}

/**
 * Lectura no-bloqueante del cache de ventas. Devuelve la entrada (fresh o
 * stale) si existe; null si nunca se pobló. NO dispara fetch. Útil para
 * handlers que prefieren responder rápido con datos parciales antes que
 * esperar 30-60s un cold fetch sincrónico.
 *
 * Si la entrada está stale, dispara un refresh en background para que la
 * próxima request la encuentre fresca.
 */
export function peekMonthlyVentas(
    year: number,
    month: number,
    codEmpresa?: number,
): VentaRaw[] | null {
    const key = makeKey(year, month, codEmpresa);
    const existing = cache.get(key);
    if (!existing) {
        // Disparar warm en background — la próxima request lo encuentra.
        if (!inflightVentas.has(key)) {
            inflightVentas.add(key);
            void refreshVentasBackground(year, month, { codEmpresa }).finally(() => inflightVentas.delete(key));
        }
        return null;
    }
    const now = Date.now();
    const nowD = new Date();
    const isCurrent = year === nowD.getUTCFullYear() && month === (nowD.getUTCMonth() + 1);
    const ttl = isCurrent ? TTL_CURRENT_MS : TTL_HISTORIC_MS;
    if (now - existing.fetchedAt >= ttl && !inflightVentas.has(key)) {
        inflightVentas.add(key);
        void refreshVentasBackground(year, month, { codEmpresa }).finally(() => inflightVentas.delete(key));
    }
    return existing.ventas;
}

export function snapshotCacheStats() {
    const now = Date.now();
    return Array.from(cache.entries()).map(([k, v]) => ({
        key: k,
        items: v.ventas.length,
        age_seconds: Math.round((now - v.fetchedAt) / 1000),
    }));
}

// ══════════════════════════════════════════════════════════════════════════
// Items (líneas) de ventas — cache paralelo.
// Usado por /api/comisiones para calcular comisión por artículo/rubro.
// Mismo TTL diferenciado que ventas crudas. Key separada con prefijo "items-".
// ══════════════════════════════════════════════════════════════════════════

interface CachedItemsDataset { items: VentaItem[]; fetchedAt: number; isHistoric: boolean }
const itemsCache = new Map<string, CachedItemsDataset>();

function makeItemsKey(year: number, month: number, codEmpresa?: number): string {
    return `items-${year}-${String(month).padStart(2, '0')}-emp${codEmpresa ?? 'all'}`;
}

export async function getMonthlyItemsRaw(
    year: number,
    month: number,
    opts?: { codEmpresa?: number; force?: boolean; nocache?: boolean }
): Promise<{ items: VentaItem[]; cached: boolean; cacheAge: number }> {
    const key = makeItemsKey(year, month, opts?.codEmpresa);
    const now = Date.now();
    const nowD = new Date();
    const isCurrent = year === nowD.getUTCFullYear() && month === (nowD.getUTCMonth() + 1);
    const ttl = isCurrent ? TTL_CURRENT_MS : TTL_HISTORIC_MS;
    const existing = itemsCache.get(key);
    const age = existing ? now - existing.fetchedAt : Infinity;
    const fresh = !!existing && age < ttl;

    if (!opts?.force && fresh) {
        return { items: existing!.items, cached: true, cacheAge: age };
    }

    if (!opts?.force && existing && !fresh) {
        if (!inflightItems.has(key)) {
            inflightItems.add(key);
            void refreshItemsBackground(year, month, opts).finally(() => inflightItems.delete(key));
        }
        return { items: existing.items, cached: true, cacheAge: age };
    }

    const desde = `${year}-${String(month).padStart(2, '0')}-01`;
    const hasta = ymdMonthEnd(year, month);
    const items = await fetchVentasItems(desde, hasta, { codEmpresa: opts?.codEmpresa });
    if (!opts?.nocache) {
        itemsCache.set(key, { items, fetchedAt: now, isHistoric: !isCurrent });
    }
    return { items, cached: false, cacheAge: 0 };
}

async function refreshItemsBackground(
    year: number,
    month: number,
    opts?: { codEmpresa?: number },
): Promise<void> {
    try {
        const desde = `${year}-${String(month).padStart(2, '0')}-01`;
        const hasta = ymdMonthEnd(year, month);
        const t0 = Date.now();
        const items = await fetchVentasItems(desde, hasta, { codEmpresa: opts?.codEmpresa });
        const isCurrent = (() => {
            const d = new Date();
            return year === d.getUTCFullYear() && month === (d.getUTCMonth() + 1);
        })();
        itemsCache.set(makeItemsKey(year, month, opts?.codEmpresa), {
            items,
            fetchedAt: Date.now(),
            isHistoric: !isCurrent,
        });
        console.log(`[snapshot SWR] refreshed items ${year}-${String(month).padStart(2, '0')} (${items.length} en ${Date.now() - t0}ms)`);
    } catch (e: any) {
        console.warn(`[snapshot SWR] fallo refresh items ${year}-${String(month).padStart(2, '0')}: ${e?.message ?? e}`);
    }
}

export function invalidateItemsMonth(year: number, month: number, codEmpresa?: number): void {
    itemsCache.delete(makeItemsKey(year, month, codEmpresa));
}

/** Versión items de peekMonthlyVentas — ver doc allá. */
export function peekMonthlyItems(
    year: number,
    month: number,
    codEmpresa?: number,
): VentaItem[] | null {
    const key = makeItemsKey(year, month, codEmpresa);
    const existing = itemsCache.get(key);
    if (!existing) {
        if (!inflightItems.has(key)) {
            inflightItems.add(key);
            void refreshItemsBackground(year, month, { codEmpresa }).finally(() => inflightItems.delete(key));
        }
        return null;
    }
    const now = Date.now();
    const nowD = new Date();
    const isCurrent = year === nowD.getUTCFullYear() && month === (nowD.getUTCMonth() + 1);
    const ttl = isCurrent ? TTL_CURRENT_MS : TTL_HISTORIC_MS;
    if (now - existing.fetchedAt >= ttl && !inflightItems.has(key)) {
        inflightItems.add(key);
        void refreshItemsBackground(year, month, { codEmpresa }).finally(() => inflightItems.delete(key));
    }
    return existing.items;
}
