/**
 * Cache RAM de respuestas JSON ya armadas de los endpoints de Objetivos.
 *
 * Por qué cachear el response final (y no solo los datos crudos): cuando un
 * admin abre Marzo 2026 y otro admin (o el mismo en otro tab) lo abre 1 minuto
 * después, ambos hacen el mismo trabajo: queries Supabase + mapeo + cálculos.
 * Cachear el JSON ya serializado nos ahorra todo eso.
 *
 * Estrategia:
 *  - Map<key, {response, fetchedAt}> con TTL 3 min (suficiente para reuniones).
 *  - Key por endpoint + parámetros que afectan el contenido (year, month,
 *    rol, vendor filter, status filter, etc).
 *  - Mutations relevantes (setGoal, setMonthConfig, sheetImport, syncVentas,
 *    backfill) llaman a invalidateAll() para garantizar consistencia tras
 *    una escritura, sin esperar al TTL.
 *
 * No cachea getGoalsSnapshot: ese endpoint ya tiene snapshotCache cubriendo
 * el dataset crudo de ventas, y los cortes intra-mes cambian con asOfDate
 * sin que cambie nada server-side, lo cual ya es <100ms con el cache existente.
 */

interface Entry {
  response: any;
  fetchedAt: number;
}

const cache = new Map<string, Entry>();
const TTL_MS = 3 * 60 * 1000;

export function getCached(key: string): any | null {
  const e = cache.get(key);
  if (!e) return null;
  if ((Date.now() - e.fetchedAt) > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return e.response;
}

export function setCached(key: string, response: any): void {
  cache.set(key, { response, fetchedAt: Date.now() });
}

export function invalidateAll(): void {
  cache.clear();
}

export function invalidateByPrefix(prefix: string): void {
  for (const k of cache.keys()) {
    if (k.startsWith(prefix)) cache.delete(k);
  }
}

export function stats() {
  const now = Date.now();
  return {
    size: cache.size,
    entries: Array.from(cache.entries()).map(([k, v]) => ({
      key: k,
      age_seconds: Math.round((now - v.fetchedAt) / 1000),
    })),
  };
}
