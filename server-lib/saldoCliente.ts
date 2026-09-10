/**
 * EL SALDO QUE LE DEBE UN CLIENTE, PARA LA HOJA DE RUTA.
 *
 * Mati (10/09/2026): *"siguen mal los saldos de las facturas adeudadas anteriores de los
 * clientes: tiene que ir únicamente el saldo anterior a la factura que está yendo en esa hoja
 * de ruta"*.
 *
 * 🔴 EL ENDPOINT QUE USÁBAMOS NO ERA EL DE LA DEUDA. `/reportes/disponible_por_cliente` devuelve
 * el crédito disponible, no la cuenta corriente, y no incluye los comprobantes más nuevos.
 * Medido contra IM el 10/09/2026:
 *
 *   | cliente          | disponible_por_cliente | deuda real  |
 *   |------------------|------------------------|-------------|
 *   | BUSTOS, Rafael   | 1.560.303,87           | 2.788.891,38| ← le faltaba la FA 50408 entera
 *   | PASTERIS, Luis   | 1.009.031,72           |   971.095,41|
 *   | BACA, Pablo      | 0                      |   −47.436   | ← no veía la nota de crédito
 *
 * 🔑 La fuente correcta es `/reportes/comprob_pendientes_clientes`: la lista de comprobantes
 * impagos, cada uno con lo que le falta pagar. Verificado que cierra al centavo contra
 * `/reportes/saldos_clientes` en los cuatro clientes probados — dos fuentes independientes.
 *
 * Y como cada pendiente viene con su `id`, el "saldo anterior" sale EXACTO: es la suma de los que
 * no son de esta entrega. No hay que restar a ojo lo que va en el camión.
 */

/** Un comprobante impago, como lo devuelve `comprob_pendientes_clientes`. */
export interface ComprobantePendiente {
  /** El id del comprobante en InfoManager. Es lo que permite excluir los de esta hoja. */
  id: string;
  tipo_comprobante: string;
  /** Lo que falta pagar de ESTE comprobante. Las notas de crédito vienen en negativo. */
  saldo: number;
  numero: string | null;
  punto_de_venta: string | null;
  fecha: string | null;
}

const centavos = (n: number) => Math.round(n * 100) / 100;

/**
 * LO QUE EL CLIENTE DEBÍA ANTES DE ESTA ENTREGA.
 *
 * Todo lo que le queda impago, menos los comprobantes que van en esta hoja: su factura y las
 * notas que la corrigen. Ésas no son deuda vieja — son justamente lo que el repartidor lleva.
 *
 * 🪤 Las notas de crédito ya vienen en negativo en el listado de IM, así que una NC de un
 * pedido ANTERIOR baja el saldo sola, sin ningún caso especial.
 */
export function saldoAnteriorDeLaHoja(
  pendientes: ComprobantePendiente[],
  idsDeEstaHoja: Iterable<string>,
): number {
  const fuera = new Set([...idsDeEstaHoja].map(String));
  return centavos(pendientes
    .filter(p => !fuera.has(String(p.id)))
    .reduce((s, p) => s + Number(p.saldo ?? 0), 0));
}

/**
 * CUÁNTO CAMBIA EL TOTAL A COBRAR POR LAS NOTAS DE ESTA ENTREGA.
 *
 * Mati (10/09/2026): *"si se le hizo la NC a Baca Pablo tiene que impactar en la hoja de ruta,
 * si no al enviar le sigue apareciendo el importe original sin descontar la NC"*.
 *
 * Negativo si se le devolvió plata (NC) y positivo si se le cobró de más (ND). Se suma al total
 * del cliente en la hoja.
 */
export function ajusteDeNotas(
  notas: Array<{ tipo: string; total: number }>,
): number {
  return centavos(notas.reduce((s, n) =>
    s + (/^NC/i.test(String(n.tipo)) ? -1 : 1) * Math.abs(Number(n.total ?? 0)), 0));
}
