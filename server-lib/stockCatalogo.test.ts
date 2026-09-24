import { describe, it, expect } from 'vitest';
import { ausentesADudar, corregirConStockPuntual, MAX_CONSULTAS_PUNTUALES } from './stockCatalogo.js';

/**
 * 24/09/2026 — Mati: *"sigue sin figurar el stock de chizito y tutuca flor del norte pero ya
 * cargamos la compra"*. IM se contradice: `/articulos/stock_existencias/10710` dice 110 en el
 * Depósito General, pero el listado `/depositos/stock_por_deposito/1` no trae la fila. Medido ese
 * día: de 185 artículos con precio ausentes del listado, 3 tenían stock — los tres Flor del Norte.
 */
const art = (cod: number, hay_stock: boolean | null) => ({ cod_articulo: cod, descripcion: `A${cod}`, cod_rubro: 10, hay_stock });

describe('ausentesADudar', () => {
    it('elige los ausentes del listado que tienen precio (los que se pueden vender)', () => {
        const pagina = [art(1, true), art(10710, false), art(99, false)];
        const precios = new Map([[1, 100], [10710, 5277]]);
        expect(ausentesADudar(pagina, precios)).toEqual([10710]);
    });

    it('no pregunta por los que no se sabe (null) ni por los que ya tienen stock', () => {
        expect(ausentesADudar([art(1, null), art(2, true)], new Map([[1, 10], [2, 10]]))).toEqual([]);
    });

    it('tiene tope: una búsqueda amplia no puede disparar 80 consultas a IM', () => {
        const pagina = Array.from({ length: 50 }, (_, i) => art(i + 1, false));
        const precios = new Map(pagina.map(a => [a.cod_articulo, 100]));
        expect(ausentesADudar(pagina, precios)).toHaveLength(MAX_CONSULTAS_PUNTUALES);
    });
});

describe('corregirConStockPuntual', () => {
    it('🔴 chizito: ausente del listado pero con 110 en la consulta puntual → HAY stock', () => {
        const [a] = corregirConStockPuntual([art(10710, false)], new Map([[10710, 110]]));
        expect(a.hay_stock).toBe(true);
    });

    it('el cero confirmado sigue siendo sin stock', () => {
        const [a] = corregirConStockPuntual([art(10650, false)], new Map([[10650, 0]]));
        expect(a.hay_stock).toBe(false);
    });

    it('si la consulta puntual no contestó, queda como estaba', () => {
        const [a] = corregirConStockPuntual([art(5, false)], new Map());
        expect(a.hay_stock).toBe(false);
    });

    it('los que pasan a tener stock suben arriba, como el resto de los que hay', () => {
        const r = corregirConStockPuntual([art(1, true), art(2, false), art(10711, false)], new Map([[10711, 75]]));
        expect(r.map(a => a.cod_articulo)).toEqual([1, 10711, 2]);
    });
});
