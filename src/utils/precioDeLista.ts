/**
 * Qué le pasa al renglón cuando vuelve la cotización de la lista que el vendedor eligió.
 *
 * 🔑 La regla: **el renglón no puede mostrar un precio que en su lista no existe.** Si el
 * artículo no tiene precio en la lista nueva, dejar el de la lista anterior con la etiqueta
 * nueva es mentirle al vendedor — y ese es el número que le canta al cliente por teléfono.
 *
 * Caso real (01/09/2026): MANI SALADO CON PIEL y PRALINE sólo tienen precio en L1. Brian los
 * pasó a L2, la pantalla les dejó los $3.780 y $4.060 de L1, y el pedido rebotó recién al
 * confirmar, con todo cargado.
 */

export interface RespuestaPrecio {
    ok?: boolean;
    cod_lista?: number | string;
    precio?: { precio_vta?: number | null } | null;
}

export interface CambioPrecio {
    precio: number;
    /** El artículo no tiene precio en esta lista: el renglón va marcado y frena el envío. */
    sinPrecio: boolean;
}

/**
 * @returns qué cambiarle al renglón, o `null` si esta respuesta no se puede usar (llegó tarde,
 *   o falló la consulta). `null` = no tocar nada.
 */
export function aplicarPrecioDeLista(
    _item: { precio: number; sinPrecio?: boolean },
    d: RespuestaPrecio | null | undefined,
    codListaPedida: number,
): CambioPrecio | null {
    if (!d?.ok) return null;
    // 🪤 Respuesta de otra lista = llegó tarde. Aplicarla deja el precio de una lista con la
    // etiqueta de otra, que es exactamente el bug que este archivo existe para evitar.
    if (Number(d.cod_lista) !== codListaPedida) return null;

    const precio = Number(d.precio?.precio_vta);
    // Sin precio útil en esa lista. `precio: 0` y no el anterior: que se vea que no hay.
    if (!Number.isFinite(precio) || precio <= 0) return { precio: 0, sinPrecio: true };
    return { precio, sinPrecio: false };
}
