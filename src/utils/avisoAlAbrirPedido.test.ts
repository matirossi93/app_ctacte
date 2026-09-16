import { describe, it, expect } from 'vitest';
import { avisoAlAbrirPedido, huellaCarrito } from './avisoAlAbrirPedido';

/**
 * 16/09/2026 — Mati: *"hay algún problema al editar productos dentro de los pedidos, donde
 * sale un cartel y se traba"*. Reproducido: si el vendedor está editando el pedido X y toca
 * «Editar» en ESE MISMO pedido, sale "Tenés un pedido a medio cargar (2 productos). Si abrís
 * este otro, ese se pierde" — y si elige Cancelar, que es lo prudente, no puede hacer nada.
 *
 * La regla: avisar SÓLO si de verdad se pierde algo.
 */
const item = (cod: number, cantidad = 1, cod_lista = 12, descuento = 0) => ({ cod_articulo: cod, cantidad, cod_lista, descuento });
const CARRITO = [item(491, 60, 14), item(478, 1, 13)];
const HUELLA = huellaCarrito(CARRITO);

describe('avisoAlAbrirPedido', () => {
    it('🔴 reabrir el MISMO pedido sin haberle tocado nada no avisa nada', () => {
        expect(avisoAlAbrirPedido({ cart: CARRITO, resultado: null, editando: 'X', aAbrir: 'X', huellaAlAbrir: HUELLA })).toBeNull();
    });

    it('🔴 abrir OTRO pedido sin cambios pendientes tampoco avisa', () => {
        // Entró a mirar un pedido, no tocó nada, y quiere abrir otro: no hay nada que perder.
        expect(avisoAlAbrirPedido({ cart: CARRITO, resultado: null, editando: 'X', aAbrir: 'Y', huellaAlAbrir: HUELLA })).toBeNull();
    });

    it('🔴 si le cambió algo al pedido que edita, avisa — y dice la verdad', () => {
        const conCambios = [...CARRITO, item(702, 5)];
        const msg = avisoAlAbrirPedido({ cart: conCambios, resultado: null, editando: 'X', aAbrir: 'Y', huellaAlAbrir: HUELLA });
        expect(msg).toBeTruthy();
        expect(msg).toMatch(/cambios/i);
        expect(msg).not.toMatch(/a medio cargar/i);   // no es un borrador nuevo
    });

    it('🔴 reabrir el mismo pedido CON cambios avisa que se pierden esos cambios', () => {
        const conCambios = [...CARRITO, item(702, 5)];
        const msg = avisoAlAbrirPedido({ cart: conCambios, resultado: null, editando: 'X', aAbrir: 'X', huellaAlAbrir: HUELLA });
        expect(msg).toMatch(/cambios/i);
        expect(msg).not.toMatch(/este otro/i);        // es el mismo, no "otro"
    });

    it('un borrador nuevo sin enviar sí avisa que se pierde', () => {
        const msg = avisoAlAbrirPedido({ cart: CARRITO, resultado: null, editando: null, aAbrir: 'X', huellaAlAbrir: null });
        expect(msg).toMatch(/a medio cargar/i);
        expect(msg).toMatch(/2 productos/);
    });

    it('un pedido YA ENVIADO no es trabajo pendiente (caso Brian, 31/08)', () => {
        expect(avisoAlAbrirPedido({ cart: CARRITO, resultado: { ok: true }, editando: null, aAbrir: 'X', huellaAlAbrir: null })).toBeNull();
    });

    it('con el carrito vacío no hay nada que avisar', () => {
        expect(avisoAlAbrirPedido({ cart: [], resultado: null, editando: null, aAbrir: 'X', huellaAlAbrir: null })).toBeNull();
    });
});

describe('huellaCarrito', () => {
    it('🔴 no depende del orden: mover un renglón no es un cambio', () => {
        expect(huellaCarrito([item(1), item(2)])).toBe(huellaCarrito([item(2), item(1)]));
    });

    it('cambiar cantidad, lista o descuento sí cambia la huella', () => {
        expect(huellaCarrito([item(1, 2)])).not.toBe(huellaCarrito([item(1, 3)]));
        expect(huellaCarrito([item(1, 2, 12)])).not.toBe(huellaCarrito([item(1, 2, 13)]));
        expect(huellaCarrito([item(1, 2, 12, 0)])).not.toBe(huellaCarrito([item(1, 2, 12, 5)]));
    });
});
