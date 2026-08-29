import { describe, it, expect } from 'vitest';
import { esSeccionValida, agruparVistas } from './sectionViews.js';

/**
 * Lo que este contador tiene que hacer bien es UNA cosa: dar un número en el que se pueda
 * confiar para sacar una sección de la app. Si cuenta mal, se saca la sección equivocada.
 */
describe('esSeccionValida', () => {
    it('acepta las secciones que existen', () => {
        for (const s of ['hoy', 'cobranzas', 'objetivos', 'comisiones', 'rebotes', 'pedidos']) {
            expect(esSeccionValida(s)).toBe(true);
        }
    });

    it('rechaza cualquier otra cosa: el body lo manda el cliente', () => {
        // Sin esto, un cliente modificado llena la tabla de basura y el resumen deja de servir.
        for (const x of ['actividad', '', 'HOY', 'hoy ', null, undefined, 42, {}, ['hoy']]) {
            expect(esSeccionValida(x)).toBe(false);
        }
    });
});

describe('agruparVistas', () => {
    it('cuenta visitas y PERSONAS distintas por sección', () => {
        const r = agruparVistas([
            { seccion: 'cobranzas', cod_vendedor: 3 },
            { seccion: 'cobranzas', cod_vendedor: 3 },   // el mismo vendedor dos veces
            { seccion: 'cobranzas', cod_vendedor: 12 },
            { seccion: 'rebotes', cod_vendedor: 3 },
        ]);
        expect(r).toEqual([
            { seccion: 'cobranzas', visitas: 3, personas: 2 },
            { seccion: 'rebotes', visitas: 1, personas: 1 },
        ]);
    });

    it('ordena por visitas: lo más usado primero', () => {
        const r = agruparVistas([
            { seccion: 'rebotes', cod_vendedor: 1 },
            { seccion: 'hoy', cod_vendedor: 1 },
            { seccion: 'hoy', cod_vendedor: 2 },
        ]);
        expect(r.map(x => x.seccion)).toEqual(['hoy', 'rebotes']);
    });

    it('una sección que nadie abrió NO aparece — el cero es ausencia, no una fila en 0', () => {
        // Es la lectura que importa: si "comisiones" no está en la lista, nadie la abrió.
        const r = agruparVistas([{ seccion: 'hoy', cod_vendedor: 1 }]);
        expect(r.find(x => x.seccion === 'comisiones')).toBeUndefined();
    });

    it('un vendedor sin código no rompe el conteo de personas', () => {
        // Los admin no tienen cod_vendedor: entran como null y cuentan como una sola persona.
        const r = agruparVistas([
            { seccion: 'hoy', cod_vendedor: null },
            { seccion: 'hoy', cod_vendedor: null },
        ]);
        expect(r).toEqual([{ seccion: 'hoy', visitas: 2, personas: 1 }]);
    });

    it('sin datos devuelve una lista vacía, no explota', () => {
        expect(agruparVistas([])).toEqual([]);
    });
});
