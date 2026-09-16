import { describe, it, expect } from 'vitest';
import { montoEnLetras } from './montoEnLetras';

/**
 * El importe en letras es lo que convierte un papel en un recibo: es la defensa contra que
 * alguien le agregue un dígito al número. Por eso lo lleva cualquier talonario.
 */
describe('montoEnLetras', () => {
    it('🔴 escribe los importes que se cobran de verdad', () => {
        expect(montoEnLetras(597650)).toBe('quinientos noventa y siete mil seiscientos cincuenta con 00/100');
        expect(montoEnLetras(1059)).toBe('un mil cincuenta y nueve con 00/100');
        expect(montoEnLetras(20140839.5)).toBe('veinte millones ciento cuarenta mil ochocientos treinta y nueve con 50/100');
    });

    it('🔴 los centavos van en número, como en cualquier recibo', () => {
        expect(montoEnLetras(1500.25)).toMatch(/con 25\/100$/);
        expect(montoEnLetras(1500.5)).toMatch(/con 50\/100$/);
        expect(montoEnLetras(1500)).toMatch(/con 00\/100$/);
    });

    it('🪤 los casos del castellano que se escriben distinto', () => {
        expect(montoEnLetras(1)).toBe('uno con 00/100');
        expect(montoEnLetras(21)).toBe('veintiuno con 00/100');
        expect(montoEnLetras(100)).toBe('cien con 00/100');
        expect(montoEnLetras(101)).toBe('ciento uno con 00/100');
        expect(montoEnLetras(500)).toBe('quinientos con 00/100');
        expect(montoEnLetras(700)).toBe('setecientos con 00/100');
        expect(montoEnLetras(900)).toBe('novecientos con 00/100');
        expect(montoEnLetras(1000)).toBe('un mil con 00/100');
        expect(montoEnLetras(1000000)).toBe('un millón con 00/100');
        expect(montoEnLetras(2000000)).toBe('dos millones con 00/100');
    });

    it('🪤 "veintiún mil" y no "veintiuno mil"', () => {
        expect(montoEnLetras(21000)).toBe('veintiún mil con 00/100');
        expect(montoEnLetras(31000)).toBe('treinta y un mil con 00/100');
    });

    it('el cero y los redondeos no rompen', () => {
        expect(montoEnLetras(0)).toBe('cero con 00/100');
        expect(montoEnLetras(0.99)).toBe('cero con 99/100');
        // 🪤 Sin redondear antes de partir, 1.005 da "1 con 00/100" por el float.
        expect(montoEnLetras(1.005)).toMatch(/^uno con 0[01]\/100$/);
    });
});
