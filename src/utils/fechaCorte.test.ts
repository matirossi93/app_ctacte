import { describe, it, expect } from 'vitest';
import { fechaDeCorte, ultimoDiaDelMes, fechaLegible, periodoInicial, esPeriodoActual } from './fechaCorte';

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

/**
 * 🔴 01/09/2026 — Mati abrió la app y el filtro decía 31/08 sin que él tocara nada: estaba
 * mirando la cartera de AYER creyendo que era la de hoy.
 *
 * "Agosto sin día" significaba **hoy** cuando se guardó, y **31/08** al día siguiente. El
 * mismo dato guardado cambió de sentido al pasar la medianoche.
 */
describe('periodoInicial — lo guardado ayer no puede mentir hoy', () => {
    const HOY_SEP = '2026-09-01';

    it('🔴 el caso de Mati: guardado ayer como "el mes en curso" vuelve a ser HOY', () => {
        const guardado = { year: 2026, month: 8, asOfDay: null, guardadoEn: '2026-08-31' };
        expect(periodoInicial(guardado, HOY_SEP)).toEqual({ year: 2026, month: 9, asOfDay: null });
    });

    // Los valores que ya estaban en los teléfonos no tienen `guardadoEn`. Ante la duda, hoy:
    // mostrar el dato del día es el error barato; esconderle la realidad, no.
    it('un valor viejo sin fecha de guardado también vuelve a hoy', () => {
        expect(periodoInicial({ year: 2026, month: 8, asOfDay: null }, HOY_SEP))
            .toEqual({ year: 2026, month: 9, asOfDay: null });
    });

    // Lo que el usuario eligió A PROPÓSITO se respeta: no vale "arreglarlo" pisándoselo.
    it('un mes pasado elegido a propósito se conserva', () => {
        const guardado = { year: 2026, month: 7, asOfDay: null, guardadoEn: '2026-08-15' };
        expect(periodoInicial(guardado, HOY_SEP)).toEqual({ year: 2026, month: 7, asOfDay: null });
    });

    it('un día puntual se conserva siempre', () => {
        const guardado = { year: 2026, month: 8, asOfDay: 15, guardadoEn: '2026-08-31' };
        expect(periodoInicial(guardado, HOY_SEP)).toEqual({ year: 2026, month: 8, asOfDay: 15 });
    });

    it('el mes en curso se deja como está', () => {
        const guardado = { year: 2026, month: 9, asOfDay: null, guardadoEn: HOY_SEP };
        expect(periodoInicial(guardado, HOY_SEP)).toEqual({ year: 2026, month: 9, asOfDay: null });
    });

    it('sin nada guardado, o con basura, arranca en el mes en curso', () => {
        for (const g of [null, undefined, {}, 'x', { year: 'a', month: 1 }]) {
            expect(periodoInicial(g, HOY_SEP)).toEqual({ year: 2026, month: 9, asOfDay: null });
        }
    });

    // El salto de año es el mismo caso y es el que más caro sale: el 1/1 todos verían el 31/12.
    it('el 1 de enero no deja a nadie mirando el 31 de diciembre', () => {
        const guardado = { year: 2025, month: 12, asOfDay: null, guardadoEn: '2025-12-31' };
        expect(periodoInicial(guardado, '2026-01-01')).toEqual({ year: 2026, month: 1, asOfDay: null });
    });
});

describe('esPeriodoActual', () => {
    it('el mes en curso sin día es "hoy"; con día, no', () => {
        expect(esPeriodoActual({ year: 2026, month: 9, asOfDay: null }, '2026-09-01')).toBe(true);
        expect(esPeriodoActual({ year: 2026, month: 9, asOfDay: 1 }, '2026-09-01')).toBe(false);
        expect(esPeriodoActual({ year: 2026, month: 8, asOfDay: null }, '2026-09-01')).toBe(false);
    });
});
