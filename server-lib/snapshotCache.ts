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
const TTL_CURRENT_MS = 5 * 60 * 1000;       // 5 min mes actual
const TTL_HISTORIC_MS = 60 * 60 * 1000;     // 1 hora meses pasados
const cache = new Map<string, CachedDataset>();

function makeKey(year: number, month: number, codEmpresa?: number): string {
    return `${year}-${String(month).padStart(2, '0')}-emp${codEmpresa ?? 'all'}`;
}

function ymdMonthEnd(year: number, month: number): string {
    const lastDay = new Date(year, month, 0).getDate();
    return `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

/**
 * Devuelve las ventas crudas del mes (1..últimoDía). Cachea con TTL 5min.
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
    if (!opts?.force && existing && (now - existing.fetchedAt) < ttl) {
        return { ventas: existing.ventas, cached: true, cacheAge: now - existing.fetchedAt };
    }

    const desde = `${year}-${String(month).padStart(2, '0')}-01`;
    const hasta = ymdMonthEnd(year, month);
    const ventas = await fetchVentas(desde, hasta, { codEmpresa: opts?.codEmpresa });

    if (!opts?.nocache) {
        cache.set(key, { ventas, fetchedAt: now, isHistoric: !isCurrent });
    }
    return { ventas, cached: false, cacheAge: 0 };
}

/** Invalida explícitamente la entrada de cache (ej. tras un sync forzado). */
export function invalidateMonth(year: number, month: number, codEmpresa?: number): void {
    cache.delete(makeKey(year, month, codEmpresa));
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
    if (!opts?.force && existing && (now - existing.fetchedAt) < ttl) {
        return { items: existing.items, cached: true, cacheAge: now - existing.fetchedAt };
    }

    const desde = `${year}-${String(month).padStart(2, '0')}-01`;
    const hasta = ymdMonthEnd(year, month);
    const items = await fetchVentasItems(desde, hasta, { codEmpresa: opts?.codEmpresa });

    if (!opts?.nocache) {
        itemsCache.set(key, { items, fetchedAt: now, isHistoric: !isCurrent });
    }
    return { items, cached: false, cacheAge: 0 };
}

export function invalidateItemsMonth(year: number, month: number, codEmpresa?: number): void {
    itemsCache.delete(makeItemsKey(year, month, codEmpresa));
}
