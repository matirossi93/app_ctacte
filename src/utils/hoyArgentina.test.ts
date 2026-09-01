import { describe, it, expect, vi, afterEach } from 'vitest';
import { hoyArgentina, mesEnCursoArgentina, hoyArgentinaPartes } from './hoyArgentina';

/**
 * 🔴 01/09/2026 — `ObjetivosApp` tomaba el mes con `getUTCFullYear()`/`getUTCMonth()`.
 * Argentina es UTC-3, así que desde las 21:00 del último día del mes el navegador ya está
 * en el mes siguiente en UTC: el 31/08 a las 21:30 la pantalla mostraba SEPTIEMBRE y le
 * pedía al server los objetivos de un mes que todavía no empezó (vacío).
 *
 * Es la misma familia del bug de `invoicesIM.ts` del 31/08 (ver runbook de pedidos): el VPS
 * corre en UTC, así que un test que no fije la hora pasa igual y no lo caza.
 */

afterEach(() => { vi.useRealTimers(); });

function congelar(iso: string) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(iso));
}

describe('hoyArgentina — la franja de 21:00 a 23:59 es la que rompía', () => {
    it('el 31/08 a las 21:30 de Tucumán todavía es AGOSTO (en UTC ya es septiembre)', () => {
        congelar('2026-09-01T00:30:00.000Z');   // 31/08 21:30 en Argentina
        expect(hoyArgentina()).toBe('2026-08-31');
        expect(mesEnCursoArgentina()).toEqual({ year: 2026, month: 8 });
    });

    it('a las 00:30 de Argentina ya es el día (y el mes) nuevo', () => {
        congelar('2026-09-01T03:30:00.000Z');   // 01/09 00:30 en Argentina
        expect(hoyArgentina()).toBe('2026-09-01');
        expect(mesEnCursoArgentina()).toEqual({ year: 2026, month: 9 });
    });

    it('el mediodía no se mueve', () => {
        congelar('2026-09-01T15:00:00.000Z');
        expect(hoyArgentina()).toBe('2026-09-01');
    });

    /**
     * El calendario de feriados de VendorShell marca "hoy" con `getUTCDate()`: después de las
     * 21:00 pintaba el día siguiente. En el último día del mes ni siquiera existe en la grilla.
     */
    it('el día también sale en hora argentina, no en UTC', () => {
        congelar('2026-09-01T00:30:00.000Z');   // 31/08 21:30 en Argentina
        expect(hoyArgentinaPartes()).toEqual({ year: 2026, month: 8, day: 31 });
    });

    // El caso que además cambia el AÑO: 31/12 a la noche.
    it('el 31/12 a las 22:00 sigue siendo diciembre del año que termina', () => {
        congelar('2027-01-01T01:00:00.000Z');   // 31/12/2026 22:00 en Argentina
        expect(hoyArgentina()).toBe('2026-12-31');
        expect(mesEnCursoArgentina()).toEqual({ year: 2026, month: 12 });
    });
});
