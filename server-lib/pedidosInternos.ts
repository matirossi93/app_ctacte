/**
 * LOS PEDIDOS INTERNOS ENTRE SUCURSALES.
 *
 * Mati (10/09/2026): *"deberíamos poder filtrar los pedidos internos de las sucursales, que hoy
 * nos están apareciendo en la aplicación también y no hay forma de sacarlos"*.
 *
 * No son ventas: son mercadería que Casa Central le manda a una sucursal. No van en hoja de ruta
 * ni pasan por el circuito de facturación del panel, así que en la lista sólo estorban.
 *
 * 🔑 SE RECONOCEN POR EL VENDEDOR. Medido contra IM el 10/09/2026: los del rango iban todos con
 * el vendedor 7, cargados por el usuario `susana`, con observaciones del tipo *"Pedido P-0027 ·
 * Sucursal Banda del Río Salí"*, y cada sucursal es un cliente distinto (652 San Juan, 861
 * Avenida Jujuy, 666 Banda del Río Salí). Mati confirmó que **ese vendedor se usa sólo para
 * esto**, así que es el dato exacto y no una heurística.
 *
 * 🪤 Y por eso NO se miran las observaciones: un vendedor puede escribir "dejar en la sucursal de
 * Monteros" en un pedido real, y ese pedido desaparecería de la lista sin que nadie sepa por qué.
 * Un filtro que esconde ventas es peor que la lista sucia que vino a limpiar.
 */

/** El vendedor con el que la oficina carga los pedidos de sucursal. */
export const VENDEDOR_SUCURSAL = Number(process.env.IM_VENDEDOR_SUCURSAL) || 7;

export function esPedidoInternoDeSucursal(
  /** El comprobante como lo devuelve IM. Sólo se mira el vendedor; el resto viaja para el tipado. */
  v: { cod_vendedor?: number | string | null; observaciones?: string | null } | null | undefined,
): boolean {
  if (!v) return false;
  const cod = Number(v.cod_vendedor);
  return Number.isFinite(cod) && cod === VENDEDOR_SUCURSAL;
}
