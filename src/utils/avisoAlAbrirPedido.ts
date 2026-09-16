import { hayPedidoEnCurso } from './pedidoEnCurso';

/**
 * Qué avisarle al vendedor antes de abrir un pedido para editar. `null` = abrir sin preguntar.
 *
 * 🔑 LA REGLA: avisar SÓLO si de verdad se pierde algo.
 *
 * Caso real (16/09/2026): el vendedor estaba editando un pedido y tocó «Editar» en ESE MISMO
 * pedido. Le salió "Tenés un pedido a medio cargar (2 productos). Si abrís este otro, ese se
 * pierde" — falso dos veces: no era un borrador a medio cargar sino un pedido ya guardado, y
 * no era "este otro" sino el mismo. Eligiendo Cancelar, que es lo que hace cualquiera al que
 * le avisan que va a perder algo, quedaba trabado sin poder editar nada.
 *
 * Antes alcanzaba con tener renglones en el carrito. Ahora se compara contra la huella con la
 * que el pedido se abrió: si no le tocó nada, no hay nada que perder y no se pregunta.
 */
export interface ItemHuella {
    cod_articulo: number;
    cantidad: number;
    cod_lista: number;
    descuento?: number;
}

/**
 * La huella de un carrito: qué artículos lleva, en qué cantidad, lista y descuento.
 * Ordenada, porque mover un renglón de lugar no es un cambio del pedido.
 */
export function huellaCarrito(cart: readonly ItemHuella[]): string {
    return cart
        .map(i => `${Number(i.cod_articulo)}|${Number(i.cantidad)}|${Number(i.cod_lista)}|${Number(i.descuento) || 0}`)
        .sort()
        .join('~');
}

export function avisoAlAbrirPedido(opts: {
    cart: readonly ItemHuella[];
    resultado: object | null;
    /** El pedido que ya está abierto para editar, o null si es un borrador nuevo. */
    editando: string | null;
    /** El pedido que se quiere abrir. */
    aAbrir: string;
    /** La huella con la que se cargó el pedido que se está editando. null si no se está editando. */
    huellaAlAbrir: string | null;
}): string | null {
    const { cart, resultado, editando, aAbrir, huellaAlAbrir } = opts;
    if (!cart.length) return null;

    // Editando un pedido guardado: lo único que se pierde son los cambios que todavía no mandó.
    if (editando != null && huellaAlAbrir != null) {
        if (huellaCarrito(cart) === huellaAlAbrir) return null;      // no le tocó nada
        return editando === aAbrir
            ? 'Tenés cambios sin guardar en este pedido. Si lo volvés a abrir, se pierden.\n\n¿Seguir igual?'
            : 'Tenés cambios sin guardar en el pedido que estás editando. Si abrís este otro, se pierden.\n\n¿Seguir igual?';
    }

    // Borrador nuevo: se pierde todo lo cargado.
    if (!hayPedidoEnCurso(cart, resultado)) return null;
    return `Tenés un pedido a medio cargar (${cart.length} ${cart.length === 1 ? 'producto' : 'productos'}). Si abrís este otro, ese se pierde.\n\n¿Seguir igual?`;
}
