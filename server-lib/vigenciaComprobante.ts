/**
 * ¿ESTE COMPROBANTE ESTÁ VIGENTE? Tres respuestas, no dos.
 *
 * `true` vigente · `false` anulado · `null` **no se sabe**.
 *
 * 🔴 El `null` no es un detalle: con un `false`, `sincronizarAnulados` marca la factura como
 * anulada —y la saca de terminada— o **limpia el remito de un pedido ya despachado**, dejándolo
 * como pendiente de remitir. Convertir un "no sé" en "está anulado" hace las dos cosas sobre
 * comprobantes que están vivos.
 *
 * 🪤 Las dos fuentes decían cosas distintas sobre el mismo caso: el listado de `/ventas` tomaba
 * la ausencia de `anulada` como vigente, y la lectura puntual la tomaba como anulada
 * (`c.anulada === false` con `anulada: null` da false). Acá sólo cuentan los valores explícitos.
 */

/**
 * `anulada` de IM a booleano, **conservando la incertidumbre**: `null` cuando no es ni 'S' ni 'N'.
 *
 * 🪤 Va en el PARSEO, no después: `String(a).toUpperCase() === 'S'` convierte 'X' o '' en
 * `false` = vigente, y a esa altura ya no hay forma de saber que el dato era ilegible.
 */
export function parsearAnulada(anulada: unknown): boolean | null {
  if (anulada === true || anulada === false) return anulada;
  // 🪤 Sólo texto. `String(["S"])` es "S" y un array pasaría como anulado: la coerción convierte
  // un dato ilegible en una respuesta definitiva, que es justo lo que esto viene a evitar.
  if (typeof anulada !== 'string') return null;
  const t = anulada.trim().toUpperCase();
  if (t === 'S') return true;
  if (t === 'N') return false;
  return null;
}

/** `anulada` tal como viene de IM: 'S' / 'N' en el listado, booleano ya parseado en la cabecera. */
export function vigenciaSegunAnulada(anulada: unknown): boolean | null {
  const a = parsearAnulada(anulada);
  return a === null ? null : !a;
}

/** La misma regla para una cabecera leída de a una: `existe` manda sobre todo lo demás. */
export function vigenciaDeCabecera(c: { existe?: boolean | null; anulada?: unknown }): boolean | null {
  if (c?.existe === false) return false;                    // ya no está: definitivo
  if (c?.existe !== true) return null;                      // no se pudo preguntar
  return vigenciaSegunAnulada(c?.anulada);
}
