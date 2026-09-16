import { describe, it, expect } from 'vitest';
import { estadoObjetivoCliente } from './estadoObjetivoCliente';

/**
 * 16/09/2026 — Mati, mirando la pestaña de Objetivos: *"aparece toda esta lista de clientes al
 * pedo"*. Eran decenas de clientes con objetivo $0, avance $0 y sobrante $0, todos con el
 * cartel verde **COMPLETADO**.
 *
 * La causa: `avance >= objetivo` con los dos en cero da `true`. Un objetivo de cero no es un
 * objetivo cumplido, es un objetivo que nadie cargó — y encima inflaba el contador de
 * completados que se muestra arriba.
 */
describe('estadoObjetivoCliente', () => {
    it('🔴 objetivo en CERO no es "completado": es que no tiene objetivo', () => {
        expect(estadoObjetivoCliente(0, 0)).toBe('sin_objetivo');
    });

    it('🔴 y sigue sin serlo aunque el cliente haya comprado', () => {
        // Compró sin tener objetivo asignado: el dato que falta es el objetivo, no la venta.
        expect(estadoObjetivoCliente(0, 350000)).toBe('sin_objetivo');
    });

    it('sin objetivo cargado (null) tampoco', () => {
        expect(estadoObjetivoCliente(null, 0)).toBe('sin_objetivo');
        expect(estadoObjetivoCliente(undefined as any, 12000)).toBe('sin_objetivo');
    });

    it('con objetivo de verdad, los tres estados de siempre', () => {
        expect(estadoObjetivoCliente(100000, 100000)).toBe('completado');
        expect(estadoObjetivoCliente(100000, 150000)).toBe('completado');
        expect(estadoObjetivoCliente(100000, 40000)).toBe('parcial');
        expect(estadoObjetivoCliente(100000, 0)).toBe('sin_compras');
    });

    it('🪤 un objetivo negativo tampoco habilita el "completado"', () => {
        // No debería existir, pero si alguien carga -1 en la planilla, que no lo festeje.
        expect(estadoObjetivoCliente(-1, 0)).toBe('sin_objetivo');
    });
});
