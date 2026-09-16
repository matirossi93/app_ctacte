import { describe, it, expect } from 'vitest';
import { rangoDeRecibos, MAX_FILAS } from './rangoRecibos.js';

/**
 * 16/09/2026 — Mati: *"a veces necesitamos ver el historial de recibos de más de 1 mes; capaz
 * que podemos poner un selector de fecha para cuidar las consultas"*.
 *
 * La idea del selector es justamente esa: se pide UN mes por vez, no todo el historial. Hoy la
 * lista trae los últimos 30 días y nada más.
 */
const AHORA = new Date('2026-09-16T15:00:00Z');

describe('qué período se pide', () => {
    it('sin nada, el último mes: es lo que se venía mostrando', () => {
        const r = rangoDeRecibos({}, AHORA);
        expect(r.desde.slice(0, 10)).toBe('2026-08-17');
        expect(r.hasta).toBeNull();
    });

    it('🔴 un mes puntual trae ese mes entero y NADA más', () => {
        const r = rangoDeRecibos({ mes: '2026-07' }, AHORA);
        expect(r.desde.slice(0, 10)).toBe('2026-07-01');
        expect(r.hasta?.slice(0, 10)).toBe('2026-08-01');
    });

    it('🔴 diciembre no se pasa de año', () => {
        const r = rangoDeRecibos({ mes: '2026-12' }, AHORA);
        expect(r.desde.slice(0, 10)).toBe('2026-12-01');
        expect(r.hasta?.slice(0, 10)).toBe('2027-01-01');
    });

    it('sigue andando el ?dias= que ya existía', () => {
        expect(rangoDeRecibos({ dias: '60' }, AHORA).desde.slice(0, 10)).toBe('2026-07-18');
    });

    it('🪤 un mes con formato raro NO abre la consulta entera: cae al default', () => {
        // Sin esto, un `mes=` vacío o basura terminaría pidiendo todo el historial.
        for (const mes of ['', 'ayer', '2026', '2026-13', '2026-00', 'DROP TABLE']) {
            const r = rangoDeRecibos({ mes }, AHORA);
            expect(r.desde.slice(0, 10)).toBe('2026-08-17');
            expect(r.hasta).toBeNull();
        }
    });

    it('🪤 el tope de filas alcanza para el mes más cargado que hubo', () => {
        // Julio 2026 tuvo 536 recibos y el tope era 500: la lista se cortaba sin avisar.
        expect(MAX_FILAS).toBeGreaterThan(536);
    });
});
