import { describe, it, expect } from 'vitest';
import { fechaDeCorte, ultimoDiaDelMes, fechaLegible } from './fechaCorte';

/**
 * De este número depende QUÉ saldo de cuenta corriente se muestra. Si el corte sale corrido
 * un día, el total de la cartera es el de otro día y nadie lo nota: los dos son números
 * plausibles. Por eso se testea acá y no se confía en mirarlo en pantalla.
 */

const HOY = '2026-08-31';

describe('fechaDeCorte', () => {
    it('el mes en curso sin día elegido es HOY, no fin de mes', () => {
        expect(fechaDeCorte({ year: 2026, month: 8, asOfDay: null }, HOY)).toEqual({ tipo: 'hoy' });
    });

    // La convención ya está documentada en ViewPeriod: "último día del mes en histórico".
    it('un mes pasado sin día elegido es el ÚLTIMO día de ese mes', () => {
        expect(fechaDeCorte({ year: 2026, month: 7, asOfDay: null }, HOY)).toEqual({ tipo: 'fecha', fecha: '2026-07-31' });
        expect(fechaDeCorte({ year: 2026, month: 6, asOfDay: null }, HOY)).toEqual({ tipo: 'fecha', fecha: '2026-06-30' });
        expect(fechaDeCorte({ year: 2026, month: 2, asOfDay: null }, HOY)).toEqual({ tipo: 'fecha', fecha: '2026-02-28' });
    });

    it('con un día elegido, ese día', () => {
        expect(fechaDeCorte({ year: 2026, month: 7, asOfDay: 15 }, HOY)).toEqual({ tipo: 'fecha', fecha: '2026-07-15' });
    });

    it('el día de hoy elegido a mano también es "hoy"', () => {
        expect(fechaDeCorte({ year: 2026, month: 8, asOfDay: 31 }, HOY)).toEqual({ tipo: 'hoy' });
    });

    // 🪤 Elegir "agosto, día 31" un 15 de agosto pide un saldo que todavía no existe.
    it('un día del mes en curso que todavía no llegó es futuro', () => {
        expect(fechaDeCorte({ year: 2026, month: 8, asOfDay: 31 }, '2026-08-15')).toEqual({ tipo: 'futuro' });
    });

    it('un mes que viene es futuro', () => {
        expect(fechaDeCorte({ year: 2026, month: 9, asOfDay: null }, HOY)).toEqual({ tipo: 'futuro' });
        expect(fechaDeCorte({ year: 2027, month: 1, asOfDay: 5 }, HOY)).toEqual({ tipo: 'futuro' });
    });

    // El mes en curso "completo" termina el 31, que es posterior a hoy si estamos a mitad de
    // mes: eso NO es futuro, es "hasta hoy".
    it('a mitad de mes, el mes en curso completo sigue siendo hoy', () => {
        expect(fechaDeCorte({ year: 2026, month: 8, asOfDay: null }, '2026-08-15')).toEqual({ tipo: 'hoy' });
    });

    it('el borde de año anda', () => {
        expect(fechaDeCorte({ year: 2025, month: 12, asOfDay: null }, HOY)).toEqual({ tipo: 'fecha', fecha: '2025-12-31' });
    });
});

describe('ultimoDiaDelMes', () => {
    it('los meses de 30 y 31', () => {
        expect(ultimoDiaDelMes(2026, 1)).toBe(31);
        expect(ultimoDiaDelMes(2026, 4)).toBe(30);
        expect(ultimoDiaDelMes(2026, 12)).toBe(31);
    });
    it('febrero, con bisiesto y sin', () => {
        expect(ultimoDiaDelMes(2026, 2)).toBe(28);
        expect(ultimoDiaDelMes(2028, 2)).toBe(29);
        expect(ultimoDiaDelMes(2000, 2)).toBe(29);   // divisible por 400: sí es bisiesto
        expect(ultimoDiaDelMes(1900, 2)).toBe(28);   // divisible por 100 y no por 400: no
    });
});

describe('fechaLegible', () => {
    it('da vuelta la fecha para mostrarla', () => {
        expect(fechaLegible('2026-07-31')).toBe('31/07/2026');
    });
});
