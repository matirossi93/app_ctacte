/**
 * El 31/08/2026 Andrea (socia, mostrador) entró a ver las ventas y le apareció el
 * objetivo de SEBASTIÁN bajo el título "Tu avance".
 *
 * Causa: la app solo distinguía "admin/gerente" vs "el resto", y al resto le daba
 * `items[0]`. El servidor recorta la lista de /api/goals SOLO cuando el rol es
 * `vendedor` (server-lib/goals.ts), así que a un `socio` le llegaban los 4
 * vendedores y la UI pintaba el primero. El primero que devuelve InfoManager entre
 * los visibles (2, 3, 4, 12) es el cod 2 = Sebastián.
 *
 * Los roles `socio`, `administrativo` y `encargado` los sumó el panel único el
 * 28/08/2026: el servidor los reconoció (commit 58f3808) y el front no.
 */
import { describe, it, expect } from 'vitest';
import { elegirObjetivo, modoObjetivo } from './vistaObjetivo';

// Los 4 vendedores visibles, en el orden REAL que devuelve InfoManager /vendedores
// (verificado el 31/08/2026 contra la API): Sebastián primero.
const ITEMS = [
    { cod_vendedor: 2, nombre: 'Sebastián' },
    { cod_vendedor: 3, nombre: 'Marcelo' },
    { cod_vendedor: 4, nombre: 'Julio' },
    { cod_vendedor: 12, nombre: 'Brian' },
];

const ANDREA = { rol: 'socio', cod_vendedor: null };
const SUSANA = { rol: 'administrativo', cod_vendedor: null };
const PABLO = { rol: 'encargado', cod_vendedor: null };
const BRIAN = { rol: 'vendedor', cod_vendedor: 12 };
const MAURO = { rol: 'vendedor', cod_vendedor: null };
const MATI = { rol: 'admin', cod_vendedor: null };
const ANTO = { rol: 'gerente', cod_vendedor: null };

describe('elegirObjetivo', () => {
    it('🐛 Andrea (socia, sin cod_vendedor) NO se lleva el objetivo de Sebastián', () => {
        // selectedVendor es null porque sale de user.cod_vendedor para los no-admin.
        expect(elegirObjetivo(ANDREA, null, ITEMS)).toEqual({ modo: 'equipo' });
    });

    it('administrativo y encargado tampoco heredan la cartera del primero de la lista', () => {
        expect(elegirObjetivo(SUSANA, null, ITEMS)).toEqual({ modo: 'equipo' });
        expect(elegirObjetivo(PABLO, null, ITEMS)).toEqual({ modo: 'equipo' });
    });

    it('el vendedor sigue viendo lo suyo (el server ya le mandó un solo item)', () => {
        expect(elegirObjetivo(BRIAN, 12, [ITEMS[3]])).toEqual({ modo: 'vendedor', item: ITEMS[3] });
    });

    it('un vendedor SIN cod_vendedor cargado no ve nada, no el de otro', () => {
        // Mauro (mostrador de San Martín) está como vendedor sin cod. Hoy el server le
        // devuelve la lista vacía, pero si eso cambiara la UI no puede caer en items[0].
        expect(elegirObjetivo(MAURO, null, ITEMS)).toEqual({ modo: 'ninguno' });
    });

    it('admin/gerente sin filtro ven el equipo', () => {
        expect(elegirObjetivo(MATI, null, ITEMS)).toEqual({ modo: 'equipo' });
        expect(elegirObjetivo(ANTO, null, ITEMS)).toEqual({ modo: 'equipo' });
    });

    it('admin con un vendedor tildado ve ese, no el primero', () => {
        expect(elegirObjetivo(MATI, 3, ITEMS)).toEqual({ modo: 'vendedor', item: ITEMS[1] });
    });

    it('si el vendedor pedido no está en la lista, item queda null (no se cae al primero)', () => {
        expect(elegirObjetivo(MATI, 99, ITEMS)).toEqual({ modo: 'vendedor', item: null });
    });

    it('sin usuario todavía cargado no se muestra nada', () => {
        expect(elegirObjetivo(null, null, ITEMS)).toEqual({ modo: 'ninguno' });
    });
});

describe('modoObjetivo', () => {
    // El rótulo de la tarjeta y el ranking se dibujan con esta misma regla: si se
    // separara de elegirObjetivo, la pantalla diría "OBJETIVO DEL MES" arriba de los
    // números del equipo (o al revés).
    it('coincide con el modo que devuelve elegirObjetivo', () => {
        for (const user of [ANDREA, SUSANA, PABLO, BRIAN, MAURO, MATI, ANTO]) {
            for (const sel of [null, 3]) {
                expect(modoObjetivo(user, sel)).toBe(elegirObjetivo(user, sel, ITEMS).modo);
            }
        }
    });

    it('el ranking del equipo se le muestra a Andrea, no a un vendedor', () => {
        expect(modoObjetivo(ANDREA, null)).toBe('equipo');
        expect(modoObjetivo(BRIAN, 12)).toBe('vendedor');
    });
});
