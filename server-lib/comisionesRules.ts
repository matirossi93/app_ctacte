/**
 * Reglas de comisión por artículo / rubro.
 *
 * Fuente: COMISIONES.xlsx (Mati, 05/2026). Confirmado verbal:
 *   - Excepción 1%: línea BELCAN, ZIMPI, GRAN CAMPEON, PIEDRAS SAN., CONEJO,
 *     FULL CAT (codes individuales).
 *   - Excepción 5.5%: línea EXACT completa (PREMIUM + CRIADORES).
 *   - Rubro 11 "Accesorios y Venenos" → 4%.
 *   - Resto de artículos → 3.5%.
 *
 * Si Mati cambia las reglas, editar acá y redeployar. Migración a tabla
 * Supabase queda para Fase 2 (ver plan).
 */

export const COMISION_1PCT_CODES = new Set<number>([
  // BELCAN
  134, 135, 136,
  // ZIMPI (incluye gato)
  150, 151, 185,
  // GRAN CAMPEON
  130, 138, 140, 131, 137,
  // Piedras sanitarias
  995, 1009,
  // CONEJO (varios proveedores)
  5, 6, 7, 24, 25,
  // FULL CAT
  281,
]);

export const COMISION_55PCT_CODES = new Set<number>([
  // EXACT PREMIUM
  232, 231, 233,
  // EXACT CRIADORES
  234, 235, 236,
]);

export const RUBRO_ACCESORIOS_VENENOS = 11;

export const COMISION_RESTO = 0.035;
export const COMISION_ACCESORIOS = 0.04;
export const COMISION_EXACT = 0.055;
export const COMISION_LISTA_1PCT = 0.01;

/**
 * Devuelve el % aplicable a una línea según prioridad:
 *  1. Código en lista EXACT (5.5%)
 *  2. Código en lista 1%
 *  3. Rubro = Accesorios y Venenos (4%)
 *  4. Resto (3.5%)
 */
export function pctParaArticulo(codArticulo: number, codRubro: number | null | undefined): number {
  if (COMISION_55PCT_CODES.has(codArticulo)) return COMISION_EXACT;
  if (COMISION_1PCT_CODES.has(codArticulo)) return COMISION_LISTA_1PCT;
  if (codRubro === RUBRO_ACCESORIOS_VENENOS) return COMISION_ACCESORIOS;
  return COMISION_RESTO;
}

export type CategoriaComision = '5.5%' | '4%' | '3.5%' | '1%';

export function categoriaParaPct(pct: number): CategoriaComision {
  if (pct === COMISION_EXACT) return '5.5%';
  if (pct === COMISION_ACCESORIOS) return '4%';
  if (pct === COMISION_LISTA_1PCT) return '1%';
  return '3.5%';
}

export const CATEGORIA_LABELS: Record<CategoriaComision, string> = {
  '5.5%': 'EXACT (5.5%)',
  '4%': 'Accesorios y Venenos (4%)',
  '3.5%': 'Resto (3.5%)',
  '1%': 'BELCAN/ZIMPI/GC/Piedras/Conejo (1%)',
};
