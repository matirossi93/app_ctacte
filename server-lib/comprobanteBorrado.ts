/**
 * 🔴 INFOMANAGER DICE "NO EXISTE" CON UN HTTP 500.
 *
 * Mati (10/09/2026): *"sigo sin poder sacar a Bianconi, sigue diciendo que le falta el remito
 * cuando no es así"*.
 *
 * Medido ese día contra IM (factura 50401 de BIANCONI, Paola — id 58779252):
 *
 *   GET /ventas/58779252        → HTTP 500
 *     {"mensaje":"Ocurrió un error al obtener información.",
 *      "detalles":"No se encontraron datos para el id: 58779252"}
 *   GET /ventas/58779252/items  → HTTP 404
 *
 * La factura había sido BORRADA en InfoManager. Pero el 500 caía en la definición de "error
 * transitorio" y se trataba como *no pude preguntar*:
 *
 *  · `imGetRetry` lo reintentaba 3 veces con backoff (1 s + 2 s) y encima renovaba el token →
 *    ~7 segundos tirados en CADA carga del tablero de facturación.
 *  · `cabeceraComprobante` devolvía `existe: null`, y `sincronizarAnulados` sólo borra con una
 *    respuesta definitiva → el pedido quedaba clavado en "falta remito" para siempre, sin forma
 *    de sacarlo desde la app.
 *
 * Que un "no existe" venga con código 500 es de IM, no nuestro (el código ya contemplaba el 404,
 * que es lo que devuelve el endpoint de items para el MISMO comprobante). Esto lo traduce.
 *
 * 🪤 El match es a propósito ESTRECHO — status 500 **y** ese texto. Un 500 genérico de IM sigue
 * siendo transitorio: darlo por "no existe" borraría el registro de una factura viva y el pedido
 * se facturaría dos veces.
 */

/** El texto con el que IM responde que el id no está. Verificado el 10/09/2026. */
const SIN_DATOS = /no se encontraron datos para el id/i;

/**
 * ¿Este error de axios es InfoManager diciendo que el comprobante ya no está?
 *
 * `true` sólo para el 500 con "No se encontraron datos para el id". Todo lo demás —incluido
 * cualquier otro 500— es `false`: sigue siendo un error transitorio.
 */
export function esComprobanteBorrado(err: any): boolean {
  if (err?.response?.status !== 500) return false;
  const d = err?.response?.data;
  const texto = typeof d === 'string' ? d : `${d?.detalles ?? ''} ${d?.mensaje ?? ''}`;
  return SIN_DATOS.test(texto);
}

/**
 * ¿IM contestó que el comprobante NO existe? Junta las dos formas: el 404 de siempre y el 500
 * con el texto de arriba.
 */
export function comprobanteNoExiste(err: any): boolean {
  return err?.response?.status === 404 || esComprobanteBorrado(err);
}
