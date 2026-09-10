/**
 * 🔴 CONTROL: ¿LA FACTURA DICE LO QUE SE LE MANDÓ?
 *
 * Mati (10/09/2026): *"el presupuesto de Urueña lo editamos y sacamos un producto que no había,
 * pero en facturación sigue figurando el importe original y en la hoja de ruta tampoco impacta"*.
 *
 * Medido contra IM ese día (cliente 430):
 *
 *   PR 58286  23 renglones  $1.111.521,00
 *   FA 50444  22 renglones  $1.073.534,08   ← le falta el artículo 1
 *   RE 77442  23 renglones  $1.111.521,00   ← lo lleva igual
 *
 * InfoManager emitió la factura **sin uno de los renglones que se le mandaron** y no lo dijo: la
 * regla de oro de esta API es que contesta 200 y el problema está adentro, y acá ni siquiera
 * estaba adentro. El remito, que se armaba con los renglones del presupuesto, salió con 2 BEBE
 * x 25 Kg de más — $37.986,92 de mercadería al cliente sin facturar.
 *
 * El arreglo de fondo es que el remito salga SIEMPRE de la factura. Esto es lo otro que hacía
 * falta: que la diferencia se vea, en vez de descubrirse tres días después cuadrando el stock.
 */

interface RenglonMinimo { cod_articulo: number | string; cantidad: number | string }

/**
 * Los artículos que se mandaron a facturar y NO quedaron en la factura (o quedaron con menos
 * cantidad). Ordenados, para que el mismo problema dé siempre el mismo mensaje.
 *
 * 🪤 Con `enLaFactura` vacío o `null` devuelve vacío: eso es "no pude leerla", y afirmar que
 * faltan todos sería peor que no decir nada.
 */
export function renglonesQueFaltan(
  mandados: RenglonMinimo[],
  enLaFactura: RenglonMinimo[] | null | undefined,
): number[] {
  if (!enLaFactura?.length) return [];
  const quedaron = new Map<number, number>();
  for (const r of enLaFactura) {
    const cod = Number(r.cod_articulo);
    quedaron.set(cod, (quedaron.get(cod) ?? 0) + (Number(r.cantidad) || 0));
  }
  const faltan = new Set<number>();
  const pedido = new Map<number, number>();
  for (const r of mandados) {
    const cod = Number(r.cod_articulo);
    pedido.set(cod, (pedido.get(cod) ?? 0) + (Number(r.cantidad) || 0));
  }
  for (const [cod, cantidad] of pedido) {
    // Medio milésimo de tolerancia: las cantidades de granel tienen 4 decimales.
    if ((quedaron.get(cod) ?? 0) < cantidad - 0.0005) faltan.add(cod);
  }
  return [...faltan].sort((a, b) => a - b);
}
