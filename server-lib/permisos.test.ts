import { describe, it, expect } from 'vitest';
import { puedeTocarPedido, puedeTocarActividadAjena, veCobranzasDeTodos } from './permisos.js';

/**
 * Los 7 roles que existen de verdad en la base (01/09/2026):
 * admin(2) · gerente(3) · socio(4) · administrativo(2) · encargado(4) · vendedor(5) · repartidor(2)
 *
 * 🔑 Cada test los recorre a TODOS. Ese es el punto de la lista blanca: cuando mañana se cree
 * un rol nuevo, el test lo obliga a aparecer acá con una decisión tomada, en vez de heredar
 * permisos en silencio — que es exactamente lo que pasó con `encargado` el 28/08.
 */
const ROLES = ['admin', 'gerente', 'socio', 'administrativo', 'encargado', 'vendedor', 'repartidor'];

describe('puedeTocarPedido — editar y ANULAR en InfoManager', () => {
    const pedidoDeSeba = { cod_vendedor: 2, created_by: 'id-seba' };

    it('admin y gerente tocan cualquier pedido: son los que corrigen', () => {
        for (const rol of ['admin', 'gerente']) {
            expect(puedeTocarPedido({ rol, sub: 'id-otro' }, pedidoDeSeba), rol).toBe(true);
        }
    });

    // 🔴 Esto es lo que estaba abierto: anulaban en IM el presupuesto de cualquier vendedor.
    it('socio, encargado y administrativo NO tocan el pedido de otro', () => {
        for (const rol of ['socio', 'encargado', 'administrativo', 'repartidor']) {
            expect(puedeTocarPedido({ rol, sub: 'id-otro' }, pedidoDeSeba), rol).toBe(false);
        }
    });

    // 🪤 Lo que NO se puede romper: los usuarios de sucursal cargan pedidos y tienen que poder
    // corregir los suyos. Si esto fuera sólo admin/gerente, el que lo cargó quedaba afuera.
    it('el que cargó el pedido lo puede tocar, sea del rol que sea', () => {
        for (const rol of ['socio', 'encargado', 'administrativo']) {
            expect(puedeTocarPedido({ rol, sub: 'id-mio' }, { cod_vendedor: 2, created_by: 'id-mio' }), rol).toBe(true);
        }
    });

    it('el vendedor sigue tocando los de SU cartera, como venía', () => {
        expect(puedeTocarPedido({ rol: 'vendedor', sub: 'x', cod_vendedor: 2 }, pedidoDeSeba)).toBe(true);
        expect(puedeTocarPedido({ rol: 'vendedor', sub: 'x', cod_vendedor: 3 }, pedidoDeSeba)).toBe(false);
    });

    // Un vendedor sin código no puede quedar matcheando contra un pedido con cod_vendedor nulo.
    it('sin cod_vendedor, un vendedor no toca nada', () => {
        expect(puedeTocarPedido({ rol: 'vendedor', sub: 'x', cod_vendedor: null }, { cod_vendedor: null, created_by: 'z' })).toBe(false);
    });

    it('sin sub no se puede probar que sea el dueño', () => {
        expect(puedeTocarPedido({ rol: 'socio' }, { cod_vendedor: 2, created_by: 'id-mio' })).toBe(false);
    });

    // Un pedido viejo sin created_by no habilita a nadie por descarte.
    it('un pedido sin created_by no queda abierto a cualquiera', () => {
        for (const rol of ROLES.filter(r => r !== 'admin' && r !== 'gerente' && r !== 'vendedor')) {
            expect(puedeTocarPedido({ rol, sub: 'id-mio' }, { cod_vendedor: 2, created_by: null }), rol).toBe(false);
        }
    });
});

describe('puedeTocarActividadAjena — borrar la promesa de pago de otro', () => {
    it('solo admin y gerente', () => {
        for (const rol of ROLES) {
            expect(puedeTocarActividadAjena(rol), rol).toBe(rol === 'admin' || rol === 'gerente');
        }
    });
});

describe('veCobranzasDeTodos — las cobranzas del equipo y la foto del comprobante', () => {
    // La lista blanca, rol por rol. Cada uno de estos está justificado en el archivo.
    it('la ven mando, backoffice y el repartidor', () => {
        for (const rol of ['admin', 'gerente', 'administrativo', 'repartidor']) {
            expect(veCobranzasDeTodos(rol), rol).toBe(true);
        }
    });

    it('el encargado de sucursal NO (pedido de Mati, 01/09)', () => {
        expect(veCobranzasDeTodos('encargado')).toBe(false);
    });

    it('el vendedor no: ve las suyas', () => {
        expect(veCobranzasDeTodos('vendedor')).toBe(false);
    });

    // El socio de UNA sucursal no; el dueño de toda la empresa sí. Misma distinción que ya se
    // aplicó a la cartera el 31/08: elvio y andrea son dueños, enzo y daniel de su sucursal.
    it('el socio depende de si es dueño de toda la empresa', () => {
        expect(veCobranzasDeTodos('socio', false)).toBe(false);
        expect(veCobranzasDeTodos('socio', true)).toBe(true);
    });

    // 🪤 El flag ausente tiene que comportarse como el caso RESTRINGIDO, nunca al revés.
    it('sin el flag, restringido', () => {
        expect(veCobranzasDeTodos('socio')).toBe(false);
        expect(veCobranzasDeTodos('encargado')).toBe(false);
    });

    it('un rol inventado no hereda nada', () => {
        expect(veCobranzasDeTodos('cadete')).toBe(false);
        expect(puedeTocarActividadAjena('cadete')).toBe(false);
        expect(puedeTocarPedido({ rol: 'cadete', sub: 'x' }, { cod_vendedor: 2, created_by: 'y' })).toBe(false);
    });
});
