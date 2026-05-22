// Resuelve cod_cuenta de InfoManager por búsqueda de nombre.
// Evita hardcodear env vars para cuentas contables — los IDs se descubren
// al arrancar consultando /planes.

import { fetchPlanCuentas, type PlanCuenta } from './infomanager.js';

const { env } = process;

function normalize(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // quita tildes
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Patrones de búsqueda por medio_pago. `match` recibe nombre normalizado.
// Orden: primero el más específico; si devuelve true, usa esa cuenta.
const PATRONES: Record<string, (n: string) => boolean> = {
  mercadopago: (n) =>
    (n.includes('mercadopago') || n.includes('mercado pago'))
    && !n.includes('recaudadora'),
  recaudadora_1: (n) =>
    n.includes('recaudadora')
    && /\b(1|01|uno)\b/.test(n),
  recaudadora_2: (n) =>
    n.includes('recaudadora')
    && /\b(2|02|dos)\b/.test(n),
  banco_nacion: (n) =>
    n.includes('banco') && n.includes('nacion'),
  efectivo: (n) => n.includes('caja casa central') || n.includes('caja central'),
  // Los cheques recibidos se imputan a "Valores a Depositar" (cuenta puente
  // contable), NO a una cuenta bancaria. Antes este patrón apuntaba a "Banco
  // Santander Río" — bug reportado por Matías el 22/05/2026.
  cheque: (n) =>
    n.includes('valores a depositar')
    || (n.includes('valores') && n.includes('deposit'))
    || (n.includes('cheque') && n.includes('deposit')),
};

// Fallback a env var si la búsqueda no resuelve (compat con el setup actual).
const ENV_FALLBACK: Record<string, string> = {
  mercadopago: 'IM_CUENTA_MERCADOPAGO',
  recaudadora_1: 'IM_CUENTA_RECAUDADORA_1',
  recaudadora_2: 'IM_CUENTA_RECAUDADORA_2',
  banco_nacion: 'IM_CUENTA_BANCO_NACION',
  efectivo: 'IM_CUENTA_EFECTIVO',
  cheque: 'IM_CUENTA_CHEQUE',
};

// Último recurso: cod_cuenta conocidos del plan InfoManager Semillero.
// Confirmados con Matías el 23/04/2026 directamente del sistema.
const HARDCODED_FALLBACK: Record<string, string> = {
  recaudadora_1: '1120005',
  recaudadora_2: '1120006',
  // MercadoPago, Efectivo, Cheque ya están en env vars desde el MVP 20/04 — no hardcode.
};

interface ResolvedCuenta {
  cod_cuenta: string;
  nombre: string;
  source: 'api' | 'env' | 'hardcoded' | 'none';
}

let cache: Record<string, ResolvedCuenta> | null = null;
let cacheExpiresAt = 0;
const TTL_MS = 6 * 60 * 60 * 1000; // 6h

async function buildCache(): Promise<Record<string, ResolvedCuenta>> {
  const result: Record<string, ResolvedCuenta> = {};
  let cuentas: PlanCuenta[] = [];
  try {
    cuentas = await fetchPlanCuentas();
  } catch (e: any) {
    console.warn('[cuentasResolver] /planes fallo:', e?.message);
  }

  for (const medio of Object.keys(PATRONES)) {
    const pred = PATRONES[medio];
    const hit = cuentas.find(c => pred(normalize(c.nombre)));
    if (hit && hit.cod_cuenta) {
      result[medio] = { cod_cuenta: hit.cod_cuenta, nombre: hit.nombre, source: 'api' };
      continue;
    }
    const envVal = env[ENV_FALLBACK[medio]];
    if (envVal) {
      result[medio] = { cod_cuenta: envVal, nombre: `(env ${ENV_FALLBACK[medio]})`, source: 'env' };
      continue;
    }
    const hardcoded = HARDCODED_FALLBACK[medio];
    if (hardcoded) {
      result[medio] = { cod_cuenta: hardcoded, nombre: '(hardcoded fallback)', source: 'hardcoded' };
      continue;
    }
    result[medio] = { cod_cuenta: '', nombre: '(sin resolver)', source: 'none' };
  }
  return result;
}

async function getCache(): Promise<Record<string, ResolvedCuenta>> {
  if (cache && Date.now() < cacheExpiresAt) return cache;
  cache = await buildCache();
  cacheExpiresAt = Date.now() + TTL_MS;
  return cache;
}

/** Devuelve el cod_cuenta resuelto para un medio; '' si no se pudo. */
export async function resolveCuentaCod(medio: string): Promise<string> {
  const c = await getCache();
  return c[medio]?.cod_cuenta || '';
}

/** Para el endpoint /api/cuentas/debug — muestra qué resolvió y de dónde. */
export async function debugCuentasResolver(): Promise<Record<string, ResolvedCuenta>> {
  return getCache();
}

/** Fuerza refresh (endpoint admin). */
export function invalidateCuentasCache(): void {
  cache = null;
  cacheExpiresAt = 0;
}

/** Pre-warm al arrancar — opcional, reduce latencia en la primera aprobación. */
export async function prewarmCuentasCache(): Promise<void> {
  try {
    await getCache();
    const c = cache!;
    const ok = Object.values(c).filter(r => r.source !== 'none').length;
    const total = Object.keys(c).length;
    console.log(`[cuentasResolver] resolved ${ok}/${total} cuentas (${Object.entries(c).map(([k, v]) => `${k}=${v.cod_cuenta || '∅'}(${v.source})`).join(', ')})`);
  } catch (e: any) {
    console.warn('[cuentasResolver] prewarm fallo:', e?.message);
  }
}
