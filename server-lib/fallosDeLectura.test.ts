import { describe, it, expect } from 'vitest';
import { LecturaNoEnviada } from './lecturasCompartidas.js';
import { fueNuestraCola } from './fallosDeLectura.js';

/**
 * 16/09/2026 — un vendedor buscó "Full" y los tres resultados le salieron con "precio no
 * disponible", aunque los artículos SÍ tienen precio en su lista. Pasó a las 12:13, un minuto
 * antes de que el contenedor terminara de arrancar: el pre-warm de boot ocupaba los cuatro
 * cupos de lectura y la consulta de la lista de precios se rechazó con "InfoManager está
 * ocupado".
 *
 * Ese rechazo NO es InfoManager caído: es nuestra propia cola. Cachearlo un minuto —que es lo
 * correcto cuando IM está en problemas— deja al vendedor sin precios por un minuto entero por
 * una decisión nuestra.
 */
describe('¿el fallo fue de InfoManager o de nuestra cola?', () => {
    it('🔴 "está ocupado" es nuestro: no hay que cachearlo como si IM fallara', () => {
        expect(fueNuestraCola(new LecturaNoEnviada('InfoManager está ocupado. No se envió esta consulta.'))).toBe(true);
    });

    it('un error de red o un 500 de IM SÍ es de IM', () => {
        expect(fueNuestraCola(new Error('timeout of 25000ms exceeded'))).toBe(false);
        expect(fueNuestraCola({ response: { status: 500 } })).toBe(false);
        expect(fueNuestraCola(null)).toBe(false);
        expect(fueNuestraCola(undefined)).toBe(false);
    });

    it('🪤 sobrevive a pasar por un catch que perdió el prototipo', () => {
        // Verificado contra la clase real: `LecturaNoEnviada` hereda `name: "Error"`, así que
        // buscar el nombre de la clase no sirve. Lo que queda es `retryable: false`.
        expect(new LecturaNoEnviada('x').name).toBe('Error');
        expect(fueNuestraCola({ retryable: false, message: 'InfoManager está ocupado.' })).toBe(true);
        // Y un error común no trae esa marca.
        expect(fueNuestraCola({ message: 'timeout' })).toBe(false);
    });
});
