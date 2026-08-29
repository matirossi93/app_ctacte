/**
 * Orden de VISTA del carrito: el último producto cargado va arriba.
 *
 * Pedido de Mati (29/08/2026): "cuando vayan cargando los productos, el último que carguen que
 * quede arriba, para que puedan modificar las cantidades y las listas; si no, cuando el
 * presupuesto es largo el artículo queda muy abajo y tienen que andar deslizando".
 *
 * 🪤 Invierte la VISTA, no los datos. El array `cart` sigue en orden de carga porque ese orden
 * es el que viaja a InfoManager, al PDF y al validador de listas — y los avisos del validador
 * vuelven emparejados POR POSICIÓN con él. Por eso cada renglón se devuelve con su índice
 * original: es el que hay que pasarle a `avisoDe(idx)`. Usar el índice de la vista haría que
 * cada renglón muestre el cartel de otro.
 */
export function ultimoArriba<T>(items: T[]): Array<{ item: T; idx: number }> {
    return items.map((item, idx) => ({ item, idx })).reverse();
}
