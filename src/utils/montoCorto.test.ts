import { describe, it, expect } from 'vitest';
import { montoCorto } from './montoCorto';

/**
 * El total de la cartera abreviado, para que entre en un renglón junto al resto.
 *
 * 🔑 Es SÓLO para la línea compacta: el número exacto está siempre a un toque, en el detalle.
 * Un redondeo tiene que verse redondeado — de ahí la coma y la M. Si mostrara "$167.747.521"
 * recortado a "$167.747.5" sería un número falso con cara de exacto.
 */

describe('montoCorto — plata que entra en un renglón', () => {
    it('los millones van con un decimal y coma, como se escribe en castellano', () => {
        expect(montoCorto(167747521)).toBe('$167,7M');
        expect(montoCorto(5860870)).toBe('$5,9M');
        expect(montoCorto(1000000)).toBe('$1M');
    });

    // Un millón redondo no se escribe "$1,0M": la coma cero no aporta y ensucia.
    it('no arrastra decimales que no dicen nada', () => {
        expect(montoCorto(2000000)).toBe('$2M');
        expect(montoCorto(134000000)).toBe('$134M');
    });

    it('abajo del millón se muestra en miles', () => {
        expect(montoCorto(950000)).toBe('$950 mil');
        expect(montoCorto(12500)).toBe('$13 mil');
    });

    it('los pesos sueltos van enteros', () => {
        expect(montoCorto(0)).toBe('$0');
        expect(montoCorto(870)).toBe('$870');
    });

    // Un cliente con saldo a favor da negativo: el signo no se puede perder.
    it('el signo negativo se conserva', () => {
        expect(montoCorto(-1500000)).toBe('−$1,5M');
        expect(montoCorto(-870)).toBe('−$870');
    });

    it('sin dato no inventa un cero', () => {
        expect(montoCorto(null)).toBe('—');
        expect(montoCorto(undefined)).toBe('—');
    });
});
