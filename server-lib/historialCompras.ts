/**
 * Historial de compras por cliente — endpoint + helpers de agregación.
 *
 * Reusa el cache RAM mensual de snapshotCache.ts (mismas ventas+items que
 * usa /api/comisiones). Filtra por cod_cliente y agrega top productos +
 * lista de últimas facturas.
 *
 * Spec: docs/superpowers/specs/2026-05-25-historial-compras-cliente-design.md
 */

const PATRONES_LINEA_TECNICA = ['flete', 'descuento', 'bonif', 'ajuste', 'redondeo', 'percepcion'];

/** True si el detalle del artículo corresponde a un concepto técnico (no producto real). */
export function esLineaTecnica(detalle: string | null | undefined): boolean {
  if (!detalle) return false;
  const lower = String(detalle).toLowerCase();
  return PATRONES_LINEA_TECNICA.some(p => lower.includes(p));
}
