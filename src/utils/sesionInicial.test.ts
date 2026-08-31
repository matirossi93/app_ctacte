import { describe, it, expect } from 'vitest';
import { sesionRechazada } from './sesionInicial';

/**
 * La regla que decide si el vendedor sigue adentro o vuelve al login.
 *
 * El 31/08/2026 estaba mal: cualquier cosa que no fuera un 200 borraba la sesión, así que un
 * bache de señal al abrir la app lo deslogueaba en plena calle. Estos tests fijan la
 * distinción que faltaba: **no poder preguntar ≠ que te digan que no**.
 */
describe('sesionRechazada', () => {
    it('200 con usuario: la sesión vale', () => {
        expect(sesionRechazada(200, true)).toBe(false);
    });

    // El server contestó bien pero no reconoce a nadie: eso sí es un rechazo.
    it('200 sin usuario adentro: la sesión no vale', () => {
        expect(sesionRechazada(200, false)).toBe(true);
    });

    it('401 y 403 son el rechazo explícito de la credencial', () => {
        expect(sesionRechazada(401, false)).toBe(true);
        expect(sesionRechazada(403, false)).toBe(true);
    });

    // 🔴 El bug. Sin red no hay respuesta, y el server no dijo NADA sobre el token.
    it('sin red NO desloguea: nadie rechazó nada', () => {
        expect(sesionRechazada(null, false)).toBe(false);
        expect(sesionRechazada(null, true)).toBe(false);
    });

    // El 502/504 del proxy es el caso real del celular con mala señal, y el 500/503 es el
    // server reiniciándose. Ninguno dice nada del token.
    it('un problema del server o del proxy tampoco desloguea', () => {
        for (const s of [500, 502, 503, 504]) {
            expect(sesionRechazada(s, false), `status ${s}`).toBe(false);
        }
    });

    // Un 404 tampoco: si la ruta no existe, el problema es el deploy, no la sesión del vendedor.
    it('un 404 no es un rechazo de credencial', () => {
        expect(sesionRechazada(404, false)).toBe(false);
    });

    it('un 429 (IM o el rate limit) no le cuesta la sesión al vendedor', () => {
        expect(sesionRechazada(429, false)).toBe(false);
    });
});
