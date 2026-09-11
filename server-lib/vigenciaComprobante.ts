/**
 * ¿ESTE COMPROBANTE ESTÁ VIGENTE? Tres respuestas, no dos.
 *
 * `true` vigente · `false` anulado · `null` **no se sabe**.
 *
 * 🔴 El `null` no es un detalle: `sincronizarAnulados` BORRA el registro de una factura cuando
 * recibe `false`, y limpia el remito de un pedido ya despachado. Convertir un "no sé" en "está
 * anulado" tira el vínculo PR↔FA —el único que existe, porque la API de IM no lo guarda— y el
 * pedido vuelve a la lista de por facturar.
 *
 * 🪤 Las dos fuentes decían cosas distintas sobre el mismo caso: el listado de `/ventas` tomaba
 * la ausencia de `anulada` como vigente, y la lectura puntual la tomaba como anulada
 * (`c.anulada === false` con `anulada: null` da false). Acá sólo cuentan los valores explícitos.
 */

/** `anulada` tal como viene de IM: 'S' / 'N' en el listado, booleano ya parseado en la cabecera. */
export function vigenciaSegunAnulada(anulada: unknown): boolean | null {
  if (anulada === true) return false;                       // anulado
  if (anulada === false) return true;                       // vigente
  const t = String(anulada ?? '').trim().toUpperCase();
  if (t === 'S') return false;
  if (t === 'N') return true;
  return null;                                              // ausente o ilegible: no se sabe
}

/** La misma regla para una cabecera leída de a una: `existe` manda sobre todo lo demás. */
export function vigenciaDeCabecera(c: { existe?: boolean | null; anulada?: unknown }): boolean | null {
  if (c?.existe === false) return false;                    // ya no está: definitivo
  if (c?.existe !== true) return null;                      // no se pudo preguntar
  return vigenciaSegunAnulada(c?.anulada);
}
