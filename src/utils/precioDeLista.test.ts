import { describe, it, expect } from 'vitest';
import { aplicarPrecioDeLista } from './precioDeLista';

/**
 * 🔴 01/09/2026 — Brian armó un pedido con MANI SALADO CON PIEL a $3.780 y PRALINE a $4.060,
 * los dos marcados L2, y al confirmar le rebotó: esos artículos SOLO tienen precio en L1.
 * Los precios que veía en pantalla eran los de L1 con la etiqueta L2.
 *
 * 🔑 Por qué: `setLista` cambiaba la etiqueta de la lista al instante y actualizaba el precio
 * SÓLO si la respuesta traía uno. Cuando el artículo no tiene precio en la lista nueva, el
 * endpoint contesta `{ok:true, cod_lista, precio:null}` y el `if` no entraba, así que el
 * renglón se quedaba con el precio de la lista ANTERIOR y la etiqueta de la nueva.
 *
 * El vendedor armaba el pedido entero confiando en un precio que en esa lista no existe, y
 * se enteraba al final. El comentario del código decía "el backend recalcula al enviar";
 * no recalcula: RECHAZA.
 */

const ITEM = { precio: 3780, cod_lista: 12, sinPrecio: false };

describe('aplicarPrecioDeLista — el renglón no puede mentir sobre su precio', () => {
    it('con precio en la lista nueva, lo toma', () => {
        const r = aplicarPrecioDeLista(ITEM, { ok: true, cod_lista: 13, precio: { precio_vta: 5200 } }, 13);
        expect(r).toEqual({ precio: 5200, sinPrecio: false });
    });

    // 🔑 El caso de Brian.
    it('sin precio en la lista nueva, NO deja el precio viejo: lo marca', () => {
        const r = aplicarPrecioDeLista(ITEM, { ok: true, cod_lista: 13, precio: null }, 13);
        expect(r).toEqual({ precio: 0, sinPrecio: true });
    });

    it('volver a una lista que sí tiene precio limpia la marca', () => {
        const marcado = { precio: 0, cod_lista: 13, sinPrecio: true };
        const r = aplicarPrecioDeLista(marcado, { ok: true, cod_lista: 12, precio: { precio_vta: 3780 } }, 12);
        expect(r).toEqual({ precio: 3780, sinPrecio: false });
    });

    /**
     * 🪤 La carrera que ya estaba contemplada y hay que conservar: si el vendedor toca L2 y
     * después L4, la respuesta de L2 puede llegar última. Una respuesta de otra lista se
     * descarta — si no, le deja el precio de L2 con la etiqueta L4, que es el número que le
     * canta al cliente por teléfono.
     */
    it('descarta una respuesta que llegó tarde, de otra lista', () => {
        expect(aplicarPrecioDeLista(ITEM, { ok: true, cod_lista: 13, precio: { precio_vta: 999 } }, 15)).toBeNull();
    });

    // Si IM no contesta no se puede afirmar que no hay precio: se deja como está y el backend
    // lo frena al enviar. Marcar el renglón acá sería inventar un problema que no se comprobó.
    it('un error de red no marca nada', () => {
        expect(aplicarPrecioDeLista(ITEM, { ok: false }, 13)).toBeNull();
        expect(aplicarPrecioDeLista(ITEM, null, 13)).toBeNull();
    });

    it('un precio 0 o negativo cuenta como sin precio', () => {
        expect(aplicarPrecioDeLista(ITEM, { ok: true, cod_lista: 13, precio: { precio_vta: 0 } }, 13))
            .toEqual({ precio: 0, sinPrecio: true });
    });
});
