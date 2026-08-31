import { describe, it, expect, vi } from 'vitest';
vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });

import { invoicesDesdeFoto, filtrarPorCods } from './cartera.js';
import type { PendienteIM, MaestroSnapshot } from './conciliacion.js';

/**
 * La lista de clientes a una fecha pasada: quién debía qué ESE día.
 *
 * Pedido de Mati el 31/08/2026 por audio: *"que se pueda ver el estado de todas las cuentas a
 * esa fecha"*. Hasta ahora la fecha movía sólo el total de arriba y la lista de abajo era
 * siempre la de hoy — estaba anotado como pendiente.
 *
 * Sale de la misma foto diaria que el total, así que no le cuesta ni una llamada a IM.
 */

const NOMBRES = new Map<number, string>([[3, 'Marcelo'], [4, 'Julio']]);
const nombreVendedor = (cod: number) => NOMBRES.get(cod) ?? `VENDEDOR ${cod}`;

function fila(over: Partial<PendienteIM> = {}): PendienteIM {
    return {
        cod_cliente: 100, cod_vendedor: 3, nombre: 'DESPENSA LA ESQUINA',
        tipo_comprobante: 'FA', punto_de_venta: 2, numero: 1,
        fecha_factura: '2026-07-15T00:00:00.000Z',
        importe_factura: 50000, importe_pagado: 0, saldo: 50000, dias_deuda: 16,
        ...over,
    };
}

describe('invoicesDesdeFoto — la lista de un día que ya pasó', () => {
    it('devuelve los comprobantes de la foto con el shape que la pantalla ya sabe leer', () => {
        const out = invoicesDesdeFoto([fila()], null, 1, nombreVendedor);
        expect(out).toHaveLength(1);
        expect(out[0].COD_CLIENT).toBe('100');
        expect(out[0].SALDO).toBe(50000);
        expect(out[0].FECHA).toBe('15/7/2026');
    });

    /**
     * 🔑 El vendedor sale del maestro CONGELADO en la foto, no del de hoy: si un cliente
     * cambió de vendedor en agosto, su deuda de julio le sigue perteneciendo a quien la
     * vendió. Es el mismo criterio que usa el total que se muestra arriba en esa pantalla —
     * si difirieran, el desglose por vendedor no cerraría con su propia lista.
     */
    it('el vendedor sale del maestro de la foto, no del de hoy', () => {
        const maestro: MaestroSnapshot = { '100': { cod_vendedor: 4, nombre: 'DESPENSA LA ESQUINA' } };
        const out = invoicesDesdeFoto([fila({ cod_vendedor: 3 })], maestro, 1, nombreVendedor);
        expect(out[0].COD_VENDED).toBe('4');
        expect(out[0].VENDEDORES).toBe('Julio');
    });

    // Las filas RC/NC vienen con cod_vendedor 0 desde IM: el maestro es justo quien lo sabe.
    it('un recibo con vendedor 0 se le asigna al vendedor del cliente', () => {
        const maestro: MaestroSnapshot = { '100': { cod_vendedor: 3, nombre: 'DESPENSA LA ESQUINA' } };
        const out = invoicesDesdeFoto([fila({ cod_vendedor: 0, tipo_comprobante: 'RC', saldo: -20000 })], maestro, 1, nombreVendedor);
        expect(out[0].COD_VENDED).toBe('3');
        expect(out[0].SALDO).toBe(-20000);
    });

    // Una foto vieja no trae maestro: ahí se cae a la heurística de /api/data (heredar el
    // vendedor de otro comprobante del mismo cliente), que es mejor que perder la fila.
    it('sin maestro congelado cae a la heurística de siempre', () => {
        const out = invoicesDesdeFoto([
            fila({ cod_vendedor: 3, numero: 1 }),
            fila({ cod_vendedor: 0, numero: 2, tipo_comprobante: 'RC' }),
        ], null, 1, nombreVendedor);
        expect(out).toHaveLength(2);
        expect(out[1].COD_VENDED).toBe('3');
    });

    it('un cliente que no está en el maestro no se pierde', () => {
        const maestro: MaestroSnapshot = { '999': { cod_vendedor: 4, nombre: 'OTRO' } };
        const out = invoicesDesdeFoto([fila({ cod_cliente: 100, cod_vendedor: 3 })], maestro, 1, nombreVendedor);
        expect(out).toHaveLength(1);
        expect(out[0].COD_VENDED).toBe('3');
    });
});

describe('filtrarPorCods — el mismo filtro por vendedor que /api/data', () => {
    const invoices = invoicesDesdeFoto([
        fila({ cod_cliente: 100, cod_vendedor: 3, numero: 1 }),
        fila({ cod_cliente: 200, cod_vendedor: 4, numero: 2 }),
    ], null, 1, nombreVendedor);

    it('deja sólo los vendedores elegidos', () => {
        expect(filtrarPorCods(invoices, [3]).map(i => i.COD_CLIENT)).toEqual(['100']);
    });

    it('sin selección devuelve todo', () => {
        expect(filtrarPorCods(invoices, null)).toHaveLength(2);
        expect(filtrarPorCods(invoices, [])).toHaveLength(2);
    });
});
