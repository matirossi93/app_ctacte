/**
 * CUÁNTO DICE DE VERDAD UNA FACTURA.
 *
 * Mati (10/09/2026): *"en la parte de facturación sigue figurando el importe original y en la
 * hoja de ruta tampoco impacta"*, sobre el pedido de URUEÑA donde el presupuesto decía
 * $1.111.521,00 y la factura salió por $1.073.534,08.
 *
 * 🔑 Una vez emitida, la factura es la verdad: es el comprobante fiscal, es lo que el cliente va
 * a pagar y es lo que el repartidor tiene que cobrar. El total del presupuesto es una intención.
 */

interface RenglonConImporte {
  cantidad: number | string;
  precio: number | string;
  descuento_porc?: number | string | null;
}

/**
 * `null` si no hay renglones — y eso NO es cero: un cero diría "esta factura no vale nada" y el
 * repartidor no le cobraría al cliente.
 */
export function totalDeRenglones(rs: RenglonConImporte[] | null | undefined): number | null {
  if (!rs?.length) return null;
  const t = rs.reduce((s, r) => {
    const d = Math.max(0, Math.min(100, Number(r.descuento_porc ?? 0) || 0));
    return s + (Number(r.cantidad) || 0) * (Number(r.precio) || 0) * (1 - d / 100);
  }, 0);
  return Math.round(t * 100) / 100;
}
