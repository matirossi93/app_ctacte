/**
 * ¿Hay un pedido a medio cargar que se perdería si el vendedor abre otra cosa?
 *
 * 🔑 Tener renglones en el carrito NO alcanza para decir que sí. Después de enviar un pedido
 * con éxito los renglones siguen ahí, pero ya no son trabajo sin terminar: están guardados en
 * InfoManager. Preguntar igual manda al vendedor a elegir entre dos opciones donde una —la
 * prudente, Cancelar— le impide hacer lo que vino a hacer.
 *
 * Caso real (31/08/2026): Brian mandó un pedido de 4 productos y al tocar «Editar» en otro le
 * saltó "Tenés un pedido a medio cargar (4 productos)". No tenía nada a medio cargar.
 *
 * @param cart      los renglones del carrito
 * @param resultado el resultado del envío, o null si todavía no se envió (o si InfoManager no
 *                  contestó, que es cuando el carrito se conserva a propósito para reintentar)
 */
export function hayPedidoEnCurso(
    cart: readonly unknown[],
    // Sólo importa si hubo envío o no; el contenido lo dibuja la pantalla final.
    resultado: object | null,
): boolean {
    if (!cart.length) return false;
    // Ya se envió: los renglones son el recibo de lo hecho, no trabajo pendiente.
    if (resultado) return false;
    return true;
}
