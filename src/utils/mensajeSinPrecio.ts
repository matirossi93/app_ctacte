/**
 * El mensaje de "este artículo no tiene precio", con el NOMBRE del producto.
 *
 * 🔑 Por qué vive acá y no en el backend: el backend arma el texto con
 * `it.descripcion || "artículo N"`, y esa descripción sale de `getPrecioLista`, que devuelve
 * **null** justo cuando el artículo no tiene precio (`parsePrecioLista`: `precio <= 0 →
 * null`). O sea que en el único caso donde ese texto se usa, la descripción SIEMPRE está
 * vacía: el fallback al código es el único camino posible y el `it.descripcion ||` es código
 * muerto. Por eso Brian leyó "artículo 653, artículo 656" el 01/09/2026.
 *
 * El nombre sí existe de este lado: es el que el vendedor está viendo en el carrito.
 */

const NOMBRE_LISTA: Record<number, string> = { 12: 'L1', 13: 'L2', 14: 'L3', 15: 'L4' };

export interface SinPrecio { cod_articulo: number; cod_lista: number }

/**
 * @param sinPrecio  lo que devolvió el backend en el 422
 * @param cart       el carrito en pantalla, que es donde están los nombres
 * @param fallback   el mensaje del server, para cuando no se puede armar nada mejor
 */
export function mensajeSinPrecio(
    sinPrecio: SinPrecio[] | undefined | null,
    cart: Array<{ cod_articulo: number; descripcion: string }>,
    fallback: string,
): string {
    if (!Array.isArray(sinPrecio) || sinPrecio.length === 0) return fallback;

    const vistos = new Set<number>();
    const partes: string[] = [];
    for (const s of sinPrecio) {
        if (vistos.has(s.cod_articulo)) continue;
        vistos.add(s.cod_articulo);
        const enCarrito = cart.find(i => i.cod_articulo === s.cod_articulo);
        const nombre = enCarrito?.descripcion || `artículo ${s.cod_articulo}`;
        const lista = NOMBRE_LISTA[s.cod_lista] ?? `lista ${s.cod_lista}`;
        partes.push(`${nombre} (${lista})`);
    }

    const plural = partes.length > 1;
    return `${partes.join(' y ')}: no ${plural ? 'tienen' : 'tiene'} precio en esa lista. `
        + `Cambiá${plural ? 'les' : 'le'} la lista al renglón o avisá a la oficina.`;
}
