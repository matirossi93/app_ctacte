import { describe, it, expect } from 'vitest';
import { normalizarInvoices, resolverSinVendedor } from './invoicesIM.js';
import type { PendienteIM } from './conciliacion.js';

/**
 * La traducción de los comprobantes crudos de InfoManager al shape que lee la pantalla.
 *
 * 🔑 Esto ya existía adentro de `fetchIMData` en server.ts. Se sacó afuera —sin cambiarle
 * nada— porque ahora lo usan DOS caminos: la lista de hoy (que va a IM) y la lista a una
 * fecha pasada (que sale de la foto guardada). Copiarlo hubiera dejado dos versiones que se
 * separan con el primer arreglo que alguien haga en una sola.
 */

const NOMBRES = new Map<number, string>([[3, 'Marcelo'], [4, 'Julio']]);
const nombreVendedor = (cod: number) => NOMBRES.get(cod) ?? `VENDEDOR ${cod}`;

function fila(over: Partial<PendienteIM> = {}): PendienteIM {
    return {
        cod_cliente: 100, cod_vendedor: 3, nombre: 'DESPENSA LA ESQUINA',
        tipo_comprobante: 'FA', punto_de_venta: 2, numero: 1234,
        fecha_factura: '2026-07-15T00:00:00.000Z',
        importe_factura: 50000, importe_pagado: 10000, saldo: 40000, dias_deuda: 17,
        ...over,
    };
}

describe('normalizarInvoices — de InfoManager al shape de la pantalla', () => {
    it('traduce los campos que la lista de cobranzas usa', () => {
        const [inv] = normalizarInvoices([fila()], 1, nombreVendedor);
        expect(inv.COD_CLIENT).toBe('100');
        expect(inv.CLIENTES_N).toBe('DESPENSA LA ESQUINA');
        expect(inv.COD_VENDED).toBe('3');
        expect(inv.VENDEDORES).toBe('Marcelo');
        expect(inv.SALDO).toBe(40000);
        expect(inv.DIAS_EMISI).toBe(17);
        expect(inv.TIPO_COMPR).toBe('FA');
        expect(inv.COD_EMPRES).toBe('1');
    });

    it('la fecha sale en D/M/AAAA, que es como la muestra la app', () => {
        expect(normalizarInvoices([fila()], 1, nombreVendedor)[0].FECHA).toBe('15/7/2026');
    });

    it('una fila sin fecha no rompe: queda vacía', () => {
        expect(normalizarInvoices([fila({ fecha_factura: undefined })], 1, nombreVendedor)[0].FECHA).toBe('');
        expect(normalizarInvoices([fila({ fecha_factura: 'no-es-fecha' })], 1, nombreVendedor)[0].FECHA).toBe('');
    });

    // El ID es la clave con la que la app identifica un comprobante (intereses, overrides).
    it('el ID se arma con empresa, tipo, punto de venta y número', () => {
        expect(normalizarInvoices([fila()], 1, nombreVendedor)[0].ID).toBe('IM-1-FA-2-1234');
    });

    it('el vendedor 0 se rotula SIN VENDEDOR, no "VENDEDOR 0"', () => {
        expect(normalizarInvoices([fila({ cod_vendedor: 0 })], 1, nombreVendedor)[0].VENDEDORES).toBe('SIN VENDEDOR');
    });

    it('un vendedor que no está en el maestro no deja la fila anónima', () => {
        expect(normalizarInvoices([fila({ cod_vendedor: 77 })], 1, nombreVendedor)[0].VENDEDORES).toBe('VENDEDOR 77');
    });
});

describe('resolverSinVendedor — los ASD/ASH del sistema no tienen vendedor en IM', () => {
    it('un comprobante sin vendedor hereda el del mismo cliente', () => {
        const out = resolverSinVendedor(normalizarInvoices([
            fila({ cod_cliente: 100, cod_vendedor: 3, tipo_comprobante: 'FA', numero: 1 }),
            fila({ cod_cliente: 100, cod_vendedor: 0, tipo_comprobante: 'ASD', numero: 2 }),
        ], 1, nombreVendedor));

        expect(out).toHaveLength(2);
        expect(out[1].COD_VENDED).toBe('3');
        expect(out[1].VENDEDORES).toBe('Marcelo');
    });

    // 🪤 Si no se puede saber de quién es, se descarta: dejarlo con vendedor 0 lo metería en
    // el total de alguien que no lo vendió.
    it('si el cliente no tiene ningún comprobante con vendedor, la fila se descarta', () => {
        const out = resolverSinVendedor(normalizarInvoices([
            fila({ cod_cliente: 999, cod_vendedor: 0 }),
        ], 1, nombreVendedor));

        expect(out).toHaveLength(0);
    });

    it('no toca los comprobantes que ya tienen vendedor', () => {
        const entrada = normalizarInvoices([fila({ cod_vendedor: 4 })], 1, nombreVendedor);
        const out = resolverSinVendedor(entrada);
        expect(out[0].COD_VENDED).toBe('4');
        expect(out[0].VENDEDORES).toBe('Julio');
    });
});
