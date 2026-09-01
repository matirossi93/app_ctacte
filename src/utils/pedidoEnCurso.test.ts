import { describe, it, expect } from 'vitest';
import { hayPedidoEnCurso } from './pedidoEnCurso';

/**
 * 🔴 31/08/2026 — Brian quiso agregarle ítems a un pedido y le saltó:
 *   "Tenés un pedido a medio cargar (4 productos). Si abrís este otro, ese se pierde."
 * No tenía ningún pedido a medio cargar: eran los 4 productos del pedido que ACABABA de
 * enviar. Al mandarlo se borraba el borrador guardado en el teléfono pero el carrito en
 * memoria quedaba intacto, así que «Editar» creía que había trabajo sin terminar.
 *
 * Lo caro no es el susto: si le da Cancelar (que es lo prudente cuando te avisan que vas a
 * perder algo), NO puede editar el pedido — queda trabado sin entender por qué, justo en lo
 * que quería hacer.
 */

const CUATRO = [{}, {}, {}, {}];

describe('hayPedidoEnCurso — ¿hay trabajo sin terminar que se perdería?', () => {
    it('con el carrito cargado y sin enviar, sí: es lo que el aviso protege', () => {
        expect(hayPedidoEnCurso(CUATRO, null)).toBe(true);
    });

    it('sin carrito no hay nada que perder', () => {
        expect(hayPedidoEnCurso([], null)).toBe(false);
    });

    // 🔑 El caso de Brian.
    it('un pedido YA ENVIADO no es un pedido a medio cargar', () => {
        expect(hayPedidoEnCurso(CUATRO, { ok: true })).toBe(false);
    });

    it('tampoco lo es un envío con aviso: entró a InfoManager igual', () => {
        expect(hayPedidoEnCurso(CUATRO, { ok: true, warn: true })).toBe(false);
    });

    /**
     * 🪤 El único caso en que el carrito sobrevive a propósito: InfoManager no contestó
     * (202/sin_respuesta). Ahí NO hay `resultado` sino `fallo`, el carrito queda para poder
     * reintentar, y el aviso tiene que seguir saliendo — perder esos renglones sería perder
     * un pedido que quizá nunca entró.
     */
    it('si IM no contestó, el carrito sigue siendo trabajo vivo', () => {
        expect(hayPedidoEnCurso(CUATRO, null)).toBe(true);
    });
});
