import { describe, it, expect } from 'vitest';
import { mensajeSinPrecio } from './mensajeSinPrecio';

/**
 * 🔴 01/09/2026 — Brian, en un pedido de 6+ renglones:
 *   "artículo 653, artículo 656: no tiene precio cargado en la lista elegida."
 *
 * Los códigos no le dicen nada: en la pantalla los renglones se llaman NUEZ PELADA AMBAR,
 * CHIA, PRALINE… y con la lista scrolleada ni siquiera ve cuáles son. Tiene que adivinar a
 * cuál cambiarle la lista.
 *
 * 🔑 El backend NO puede resolverlo: arma el mensaje con `it.descripcion || "artículo N"`, y
 * la descripción sale de `getPrecioLista`, que devuelve **null** justo cuando el artículo no
 * tiene precio (`parsePrecioLista`: `if (precio <= 0) return null`). O sea que en el único
 * caso donde se usa ese texto la descripción SIEMPRE está vacía y el fallback es el único
 * camino posible. El `it.descripcion ||` es código muerto.
 *
 * El nombre sí existe, pero de este lado: está en el carrito, que es lo que el vendedor ve.
 */

const CARRITO = [
    { cod_articulo: 651, descripcion: 'NUEZ PELADA AMBAR' },
    { cod_articulo: 653, descripcion: 'PASAS CON SEMILLA' },
    { cod_articulo: 656, descripcion: 'MIX ENERGETICO S/C' },
    { cod_articulo: 660, descripcion: 'MANI SALADO CON PIEL' },
];

// 🪤 Los `cod_lista` reales son 12 (L1), 13 (L2), 14 (L3) y 15 (L4), NO 1/2/3: el número
// chico es sólo la etiqueta que se muestra. Escribí este test con 1/2/3 la primera vez y
// falló — mismo error que me hizo consultar IM con listas inexistentes y leer "la lista no
// existe" como si el artículo no tuviera precio.
describe('mensajeSinPrecio — decirle CUÁL, no el código', () => {
    it('el caso de Brian: dos artículos sin precio salen con su nombre', () => {
        const msg = mensajeSinPrecio(
            [{ cod_articulo: 653, cod_lista: 13 }, { cod_articulo: 656, cod_lista: 13 }],
            CARRITO,
            'fallback del server',
        );
        expect(msg).toContain('PASAS CON SEMILLA');
        expect(msg).toContain('MIX ENERGETICO S/C');
        expect(msg).not.toContain('artículo 653');
    });

    it('con uno solo habla en singular', () => {
        const msg = mensajeSinPrecio([{ cod_articulo: 653, cod_lista: 14 }], CARRITO, 'x');
        expect(msg).toContain('PASAS CON SEMILLA');
        expect(msg).toMatch(/no tiene precio/);
        expect(msg).not.toMatch(/no tienen precio/);
    });

    it('dice en qué lista falta, que es lo que hay que cambiar', () => {
        expect(mensajeSinPrecio([{ cod_articulo: 653, cod_lista: 14 }], CARRITO, 'x')).toContain('L3');
    });

    // 🪤 Si el artículo no está en el carrito (no debería pasar) no se puede quedar mudo ni
    // inventar: cae al código, que es peor que el nombre pero mejor que nada.
    it('un artículo que no está en el carrito cae al código', () => {
        expect(mensajeSinPrecio([{ cod_articulo: 999, cod_lista: 13 }], CARRITO, 'x')).toContain('999');
    });

    // Si el backend cambia el shape, se muestra su mensaje en vez de romper la pantalla.
    it('sin lista utilizable devuelve el mensaje del server', () => {
        expect(mensajeSinPrecio([], CARRITO, 'el del server')).toBe('el del server');
        expect(mensajeSinPrecio(undefined, CARRITO, 'el del server')).toBe('el del server');
    });

    it('no repite un artículo que vino dos veces', () => {
        const msg = mensajeSinPrecio(
            [{ cod_articulo: 653, cod_lista: 14 }, { cod_articulo: 653, cod_lista: 14 }],
            CARRITO,
            'x',
        );
        expect(msg.match(/PASAS CON SEMILLA/g)).toHaveLength(1);
    });
});
