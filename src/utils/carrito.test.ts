import { describe, it, expect } from 'vitest';
import { ultimoArriba } from './carrito';

/**
 * El orden en que se MUESTRA el carrito no es el orden en que se GUARDA.
 *
 * En pantalla el último producto cargado va arriba (pedido de Mati, 29/08: en un presupuesto
 * largo el renglón nuevo quedaba fuera de pantalla y había que scrollear para cambiarle la
 * cantidad o la lista). Pero lo que se manda a InfoManager, al PDF y al validador sigue en
 * orden de carga — y los avisos del control de listas se emparejan POR POSICIÓN con ese orden.
 * Por eso la vista invertida tiene que arrastrar el índice original: si se usara el índice de
 * la vista, cada renglón mostraría el aviso de otro y el botón «Poner L2» le cambiaría la
 * lista al renglón equivocado.
 */
describe('ultimoArriba', () => {
    it('muestra el último cargado primero', () => {
        const r = ultimoArriba(['primero', 'segundo', 'tercero']);
        expect(r.map(x => x.item)).toEqual(['tercero', 'segundo', 'primero']);
    });

    it('conserva el índice ORIGINAL de cada renglón, no el de la vista', () => {
        const r = ultimoArriba(['primero', 'segundo', 'tercero']);
        expect(r.map(x => x.idx)).toEqual([2, 1, 0]);
    });

    it('no toca el array que recibe', () => {
        const cart = ['a', 'b', 'c'];
        ultimoArriba(cart);
        expect(cart).toEqual(['a', 'b', 'c']);
    });

    it('aguanta el carrito vacío y el de un solo renglón', () => {
        expect(ultimoArriba([])).toEqual([]);
        expect(ultimoArriba(['único'])).toEqual([{ item: 'único', idx: 0 }]);
    });
});
