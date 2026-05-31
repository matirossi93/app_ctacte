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
// Coalescing: si un fetch está en vuelo para una key, las requests
// concurrentes esperan a ese mismo Promise en vez de disparar N fetches
// paralelos. Cubre tanto refreshes (SWR) como cold fetches sincrónicos
// que llegan mientras el prewarm está corriendo.
const inflightVentas = new Map<string, Promise<VentaRaw[]>>();
const inflightItems = new Map<string, Promise<VentaItem[]>>();

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
        // El catch evita unhandled rejection: el caller no awaitea, así que
        // si IM falla solo queremos logear y dejar el cache stale.
        if (!inflightVentas.has(key)) {
            const p = refreshVentas(year, month, opts).catch(e => {
                console.warn(`[snapshot SWR] fallo refresh ventas ${year}-${String(month).padStart(2, '0')}: ${e?.message ?? e}`);
                return existing.ventas; // mantiene stale para callers que pudieran estar awaiteando vía inflight
            });
            inflightVentas.set(key, p);
            void p.finally(() => inflightVentas.delete(key));
        }
        return { ventas: existing.ventas, cached: true, cacheAge: age };
    }

    // Sin entrada previa: si hay un fetch en vuelo (típicamente disparado
    // por el prewarm), esperamos a ese mismo Promise en vez de disparar
    // otro paralelo. Si no hay nada en vuelo, disparamos uno y otros que
    // lleguen también lo van a esperar.
    let p = inflightVentas.get(key);
    if (!p) {
        p = refreshVentas(year, month, opts);
        inflightVentas.set(key, p);
        void p.finally(() => inflightVentas.delete(key));
    }
    const ventas = await p;
    return { ventas, cached: false, cacheAge: 0 };
}

async function refreshVentas(
    year: number,
    month: number,
    opts?: { codEmpresa?: number; nocache?: boolean },
): Promise<VentaRaw[]> {
    const desde = `${year}-${String(month).padStart(2, '0')}-01`;
    const hasta = ymdMonthEnd(year, month);
    const t0 = Date.now();
    const ventas = await fetchVentas(desde, hasta, { codEmpresa: opts?.codEmpresa });
    const isCurrent = (() => {
        const d = new Date();
        return year === d.getUTCFullYear() && month === (d.getUTCMonth() + 1);
    })();
    if (!opts?.nocache) {
        cache.set(makeKey(year, month, opts?.codEmpresa), {
            ventas,
            fetchedAt: Date.now(),
            isHistoric: !isCurrent,
        });
    }
    console.log(`[snapshot] fetched ventas ${year}-${String(month).padStart(2, '0')} (${ventas.length} en ${Date.now() - t0}ms)`);
    return ventas;
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
    function ensureInflight() {
        if (!inflightVentas.has(key)) {
            const p = refreshVentas(year, month, { codEmpresa }).catch(e => {
                console.warn(`[snapshot peek] fallo warm ventas ${year}-${String(month).padStart(2, '0')}: ${e?.message ?? e}`);
                return [] as VentaRaw[];
            });
            inflightVentas.set(key, p);
            void p.finally(() => inflightVentas.delete(key));
        }
    }
    if (!existing) {
        ensureInflight();
        return null;
    }
    const now = Date.now();
    const nowD = new Date();
    const isCurrent = year === nowD.getUTCFullYear() && month === (nowD.getUTCMonth() + 1);
    const ttl = isCurrent ? TTL_CURRENT_MS : TTL_HISTORIC_MS;
    if (now - existing.fetchedAt >= ttl) ensureInflight();
    return existing.ventas;
}

export function snapshotCacheStats() {
    const now = Date.now();
    const ventas = Array.from(cache.entries()).map(([k, v]) => ({
        key: k,
        rows: v.ventas.length,
        age_seconds: Math.round((now - v.fetchedAt) / 1000),
    }));
    const items = Array.from(itemsCache.entries()).map(([k, v]) => ({
        key: k,
        rows: v.items.length,
        age_seconds: Math.round((now - v.fetchedAt) / 1000),
    }));
    return {
        ventas,
        items,
        inflight: { ventas: inflightVentas.size, items: inflightItems.size },
    };
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
            const p = refreshItems(year, month, opts).catch(e => {
                console.warn(`[snapshot SWR] fallo refresh items ${year}-${String(month).padStart(2, '0')}: ${e?.message ?? e}`);
                return existing.items;
            });
            inflightItems.set(key, p);
            void p.finally(() => inflightItems.delete(key));
        }
        return { items: existing.items, cached: true, cacheAge: age };
    }

    // Coalesce con el fetch en vuelo (prewarm o request previa).
    let p = inflightItems.get(key);
    if (!p) {
        p = refreshItems(year, month, opts);
        inflightItems.set(key, p);
        void p.finally(() => inflightItems.delete(key));
    }
    const items = await p;
    return { items, cached: false, cacheAge: 0 };
}

async function refreshItems(
    year: number,
    month: number,
    opts?: { codEmpresa?: number; nocache?: boolean },
): Promise<VentaItem[]> {
    const desde = `${year}-${String(month).padStart(2, '0')}-01`;
    const hasta = ymdMonthEnd(year, month);
    const t0 = Date.now();
    const items = await fetchVentasItems(desde, hasta, { codEmpresa: opts?.codEmpresa });
    const isCurrent = (() => {
        const d = new Date();
        return year === d.getUTCFullYear() && month === (d.getUTCMonth() + 1);
    })();
    if (!opts?.nocache) {
        itemsCache.set(makeItemsKey(year, month, opts?.codEmpresa), {
            items,
            fetchedAt: Date.now(),
            isHistoric: !isCurrent,
        });
    }
    console.log(`[snapshot] fetched items ${year}-${String(month).padStart(2, '0')} (${items.length} en ${Date.now() - t0}ms)`);
    return items;
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
    function ensureInflight() {
        if (!inflightItems.has(key)) {
            const p = refreshItems(year, month, { codEmpresa }).catch(e => {
                console.warn(`[snapshot peek] fallo warm items ${year}-${String(month).padStart(2, '0')}: ${e?.message ?? e}`);
                return [] as VentaItem[];
            });
            inflightItems.set(key, p);
            void p.finally(() => inflightItems.delete(key));
        }
    }
    if (!existing) {
        ensureInflight();
        return null;
    }
    const now = Date.now();
    const nowD = new Date();
    const isCurrent = year === nowD.getUTCFullYear() && month === (nowD.getUTCMonth() + 1);
    const ttl = isCurrent ? TTL_CURRENT_MS : TTL_HISTORIC_MS;
    if (now - existing.fetchedAt >= ttl) ensureInflight();
    return existing.items;
}
