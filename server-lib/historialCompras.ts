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

export interface AgregadoArticulo {
  cod_articulo: number;
  detalle: string;
  cantidad_total: number;
  importe_total: number;
  num_facturas: number;
  ultima_compra: string; // 'YYYY-MM-DD'
}

interface CabeceraSigno {
  sign: 1 | -1;
  fecha: string;
}

/**
 * Agrupa los items por `cod_articulo`, aplicando el signo de cada cabecera
 * (FA suma, NC resta). Devuelve un Map para que el caller pueda armar varios
 * rankings sin re-iterar los items.
 *
 * Items cuya cabecera no está en `signos` se descartan (cabecera inválida
 * = no Casa Central, anulada, no FA/NC, no este cliente).
 */
export function agregarPorArticulo(
  items: Array<{ id_comprobante: number; cod_articulo: number | string; cantidad: number | string; importe?: number | string; precio?: number | string; detalle?: string }>,
  signos: Map<number, CabeceraSigno>,
  articulosMap: Map<number, { descripcion: string }>
): Map<number, AgregadoArticulo> {
  const acc = new Map<number, AgregadoArticulo>();
  const facturasPorArt = new Map<number, Set<number>>();

  for (const it of items) {
    const cab = signos.get(Number(it.id_comprobante));
    if (!cab) continue;

    const codArt = Number(it.cod_articulo);
    if (!Number.isFinite(codArt)) continue;

    const cantidad = Number(it.cantidad ?? 0);
    const importe = Number(it.importe ?? 0);
    if (!Number.isFinite(cantidad) || !Number.isFinite(importe)) continue;

    const sign = cab.sign;
    const detalleArt = String(
      (it as any).detalle ?? articulosMap.get(codArt)?.descripcion ?? `#${codArt}`
    ).trim();

    let a = acc.get(codArt);
    if (!a) {
      a = {
        cod_articulo: codArt,
        detalle: detalleArt,
        cantidad_total: 0,
        importe_total: 0,
        num_facturas: 0,
        ultima_compra: cab.fecha,
      };
      acc.set(codArt, a);
      facturasPorArt.set(codArt, new Set());
    }

    a.cantidad_total += cantidad * sign;
    a.importe_total += importe * sign;
    if (cab.fecha > a.ultima_compra) a.ultima_compra = cab.fecha;

    facturasPorArt.get(codArt)!.add(Number(it.id_comprobante));
  }

  for (const [cod, set] of facturasPorArt) {
    const a = acc.get(cod);
    if (a) a.num_facturas = set.size;
  }

  return acc;
}

export function topPorImporte(agg: Map<number, AgregadoArticulo>, n: number): AgregadoArticulo[] {
  return Array.from(agg.values())
    .filter(a => a.importe_total > 0)
    .sort((a, b) => b.importe_total - a.importe_total)
    .slice(0, n);
}

export function topPorFrecuencia(agg: Map<number, AgregadoArticulo>, n: number): AgregadoArticulo[] {
  return Array.from(agg.values())
    .filter(a => a.num_facturas > 0)
    .sort((a, b) => {
      if (b.num_facturas !== a.num_facturas) return b.num_facturas - a.num_facturas;
      return b.importe_total - a.importe_total;
    })
    .slice(0, n);
}
