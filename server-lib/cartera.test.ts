import { describe, it, expect, vi } from 'vitest';
// infomanager.ts corta el proceso al importarse si falta el secret (mismo patrón que
// fechaArgentina.test.ts y precioLista.test.ts).
vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });

import { resolverFuente, maestroFotoAClientes, recibosAlCorte, totalesCartera, parsearCods } from './cartera.js';
import { agruparConciliacion, type PendienteIM, type ReciboTransito, type ClienteMaestro } from './conciliacion.js';

/**
 * La cartera: cuánta plata hay en la calle, a una fecha y por vendedor.
 *
 * Lo que se prueba acá es la matemática del número que Mati va a mirar para tomar
 * decisiones. Su regla: **una cifra de cartera equivocada es peor que no tenerla**, así que
 * varios de estos tests son sobre cuándo NO hay que mostrar nada.
 */

const HOY = '2026-08-31';

describe('resolverFuente — de dónde sale el saldo de la fecha pedida', () => {
    it('sin fecha, o con la de hoy, es la foto viva de IM', () => {
        expect(resolverFuente(undefined, HOY)).toEqual({ tipo: 'vivo' });
        expect(resolverFuente('', HOY)).toEqual({ tipo: 'vivo' });
        expect(resolverFuente(HOY, HOY)).toEqual({ tipo: 'vivo' });
    });

    it('una fecha pasada sale de la foto guardada', () => {
        expect(resolverFuente('2026-07-31', HOY)).toEqual({ tipo: 'foto', fecha: '2026-07-31' });
    });

    // Comparar ISO como texto tiene que respetar el cambio de mes y de año.
    it('el borde de mes y de año se compara bien', () => {
        expect(resolverFuente('2026-08-30', HOY).tipo).toBe('foto');
        expect(resolverFuente('2025-12-31', HOY).tipo).toBe('foto');
        expect(resolverFuente('2026-09-01', HOY).tipo).toBe('invalida');
    });

    it('una fecha futura no se inventa', () => {
        expect(resolverFuente('2027-01-01', HOY).tipo).toBe('invalida');
    });

    it('basura y fechas que no existen dan 400, no un 500', () => {
        for (const f of ['ayer', '31/07/2026', '2026-13-01', '2026-02-31', '2026-7-1', '2026-08-31T10:00']) {
            expect(resolverFuente(f, HOY).tipo, f).toBe('invalida');
        }
    });
});

describe('maestroFotoAClientes — el vendedor sale de la foto, no del maestro de hoy', () => {
    it('convierte el maestro congelado al shape que espera agruparConciliacion', () => {
        const r = maestroFotoAClientes({ '100': { cod_vendedor: 3, nombre: 'DESPENSA X' } });
        expect(r).toEqual([{ cod_cliente: 100, razon_social: 'DESPENSA X', cod_vendedor: 3 }]);
    });

    // 🔑 Devolver [] en vez de null haría pasar por "congelado" a una foto que no lo está, y
    // entonces TODOS los clientes caerían en "Sin vendedor" sin que nadie se entere.
    it('una foto vieja sin maestro devuelve null, no un array vacío', () => {
        expect(maestroFotoAClientes(null)).toBeNull();
        expect(maestroFotoAClientes(undefined)).toBeNull();
    });

    it('ignora claves que no son códigos de cliente', () => {
        const r = maestroFotoAClientes({ 'null': { cod_vendedor: 1, nombre: 'x' }, '5': { cod_vendedor: 2, nombre: 'ok' } });
        expect(r).toEqual([{ cod_cliente: 5, razon_social: 'ok', cod_vendedor: 2 }]);
    });
});

describe('recibosAlCorte — qué plata estaba cobrada pero no imputada AL corte', () => {
    const CORTE = '2026-07-31';
    const base = { id: 'r1', cod_cliente: 100, monto: 1000, status: 'pendiente_revision' } as ReciboTransito;

    it('un recibo cargado antes del corte y todavía sin imputar cuenta', () => {
        expect(recibosAlCorte([{ ...base, fecha_comprobante: '2026-07-20' }], CORTE)).toHaveLength(1);
    });

    it('un recibo POSTERIOR al corte no cuenta: al corte no existía', () => {
        expect(recibosAlCorte([{ ...base, fecha_comprobante: '2026-08-05' }], CORTE)).toHaveLength(0);
    });

    // 🔑 El caso más común del flujo real y el motivo de toda esta función: el vendedor cobró
    // el 28/07, la oficina lo imputó el 02/08. Al 31/07 IM todavía lo mostraba como deuda.
    it('imputado DESPUÉS del corte: al corte estaba en tránsito', () => {
        const r = recibosAlCorte([{
            ...base, status: 'imputado', fecha_comprobante: '2026-07-28',
            imputado_at: '2026-08-02T14:00:00.000Z',
        }], CORTE);
        expect(r).toHaveLength(1);
        // Sale como no terminal para que clasificarRecibos lo cuente como tránsito.
        expect(r[0].status).toBe('pendiente_revision');
    });

    it('imputado ANTES del corte no cuenta: IM ya lo tenía descontado', () => {
        expect(recibosAlCorte([{
            ...base, status: 'imputado', fecha_comprobante: '2026-07-10',
            imputado_at: '2026-07-15T14:00:00.000Z',
        }], CORTE)).toHaveLength(0);
    });

    // 🪤 03:00 UTC del 1/8 son las 00:00 del 1/8 en Argentina — todavía posterior al corte.
    // Pero 02:00 UTC del 1/8 son las 23:00 del 31/07: ese SÍ se imputó el día del corte.
    it('el corte se mide en hora argentina, no en UTC', () => {
        const conImputacion = (ts: string) => recibosAlCorte([{
            ...base, status: 'imputado', fecha_comprobante: '2026-07-20', imputado_at: ts,
        }], CORTE);
        expect(conImputacion('2026-08-01T03:00:00.000Z')).toHaveLength(1);  // 1/8 00:00 ART
        expect(conImputacion('2026-08-01T02:00:00.000Z')).toHaveLength(0);  // 31/7 23:00 ART
    });

    it('un imputado sin fecha de imputación no se cuenta (no se puede saber cuándo fue)', () => {
        expect(recibosAlCorte([{ ...base, status: 'imputado', fecha_comprobante: '2026-07-20' }], CORTE)).toHaveLength(0);
    });

    it('sin ninguna fecha no se cuenta', () => {
        expect(recibosAlCorte([{ ...base, fecha_comprobante: null, created_at: null }], CORTE)).toHaveLength(0);
    });

    it('sin fecha_comprobante cae en created_at', () => {
        expect(recibosAlCorte([{ ...base, fecha_comprobante: null, created_at: '2026-07-10T12:00:00Z' }], CORTE)).toHaveLength(1);
    });
});

// ─── Totales, sobre una conciliación armada de verdad ────────────────────────

const fila = (cod: number, saldo: number, extra: Partial<PendienteIM> = {}): PendienteIM => ({
    cod_cliente: cod, saldo, tipo_comprobante: 'FA', fecha_factura: '2026-07-01',
    importe_factura: saldo, importe_pagado: 0, dias_deuda: 30, ...extra,
});
const MAESTRO: ClienteMaestro[] = [
    { cod_cliente: 100, razon_social: 'CLIENTE DE MARCELO', cod_vendedor: 3 },
    { cod_cliente: 200, razon_social: 'CLIENTE DE JULIO', cod_vendedor: 4 },
    { cod_cliente: 300, razon_social: 'CLIENTE HUERFANO', cod_vendedor: 99 },
    { cod_cliente: 1, razon_social: 'CASA CENTRAL', cod_vendedor: null },
];
const VENDEDORES = [{ cod_vendedor: 3, nombre: 'Marcelo' }, { cod_vendedor: 4, nombre: 'Julio' }];

describe('totalesCartera — cuánto hay en la calle', () => {
    const armar = (recibos: ReciboTransito[] = []) => agruparConciliacion(
        [fila(100, 1_000_000), fila(200, 400_000), fila(300, 12_000), fila(1, 50_000_000)],
        MAESTRO, recibos, VENDEDORES,
    );

    it('el total suma los clientes reales y deja las internas afuera', () => {
        const t = totalesCartera(armar(), null);
        expect(t.total.saldo_im).toBe(1_412_000);
        expect(t.internas).toEqual({ saldo_im: 50_000_000, n_cuentas: 1 });
    });

    // 🔑 Al 30/08/2026 las internas eran $144M sobre $176M de clientes: contarlas casi
    // duplica el número y deja de ser "lo que deben los clientes".
    it('las internas NO entran en el total ni aunque sean enormes', () => {
        const t = totalesCartera(armar(), null);
        expect(t.total.saldo_im).toBeLessThan(t.internas.saldo_im);
        // La interna tampoco se cuela adentro de ningún grupo de vendedor: son 3 clientes
        // reales (100, 200, 300) y la cuenta 1 queda afuera de la cuenta.
        expect(t.total.n_clientes).toBe(3);
        expect(t.por_vendedor.reduce((a, v) => a + v.n_clientes, 0)).toBe(3);
    });

    // 🪤 Un cliente con un vendedor que no existe cae en "Sin vendedor". Esa plata TIENE que
    // seguir en el total: si desapareciera, el total de la empresa daría de menos y nadie lo
    // notaría (acá son $12.000, en producción al 30/08 eran exactamente $12.000).
    it('la plata del cliente sin vendedor conocido sigue contando en el total', () => {
        const t = totalesCartera(armar(), null);
        const sinVend = t.por_vendedor.find(v => v.cod_vendedor === 0);
        expect(sinVend?.saldo_im).toBe(12_000);
        expect(t.por_vendedor.reduce((a, v) => a + v.saldo_im, 0)).toBe(t.total.saldo_im);
    });

    it('el desglose por vendedor suma exactamente el total', () => {
        const t = totalesCartera(armar(), null);
        expect(t.por_vendedor.reduce((a, v) => a + v.ajustado, 0)).toBeCloseTo(t.total.ajustado, 2);
        expect(t.por_vendedor.reduce((a, v) => a + v.n_clientes, 0)).toBe(t.total.n_clientes);
    });

    // 🔑 Lo más importante del filtro: cuánto hay en la calle NO cambia porque yo destilde
    // un vendedor. Si el total se moviera, dos personas verían números distintos de lo mismo.
    it('filtrar por vendedor NO mueve el total de la empresa, solo el desglose', () => {
        const sinFiltro = totalesCartera(armar(), null);
        const conFiltro = totalesCartera(armar(), [3]);
        expect(conFiltro.total).toEqual(sinFiltro.total);
        expect(conFiltro.filtrado?.saldo_im).toBe(1_000_000);
        expect(conFiltro.filtrado?.n_clientes).toBe(1);
        expect(conFiltro.filtrado?.cods).toEqual([3]);
    });

    it('sin filtro no hay número filtrado (null, no cero)', () => {
        expect(totalesCartera(armar(), null).filtrado).toBeNull();
    });

    it('filtrar por un vendedor sin cartera da 0, no rompe', () => {
        const t = totalesCartera(armar(), [12]);
        expect(t.filtrado?.saldo_im).toBe(0);
        expect(t.filtrado?.n_clientes).toBe(0);
    });

    it('el tránsito resta del ajustado pero no del saldo de IM', () => {
        const t = totalesCartera(armar([{
            id: 'r1', cod_cliente: 100, monto: 250_000, status: 'pendiente_revision',
            fecha_comprobante: '2026-07-20',
        } as ReciboTransito]), null);
        expect(t.total.saldo_im).toBe(1_412_000);
        expect(t.total.en_transito).toBe(250_000);
        expect(t.total.ajustado).toBe(1_162_000);
    });

    it('un cliente con saldo a favor RESTA del total', () => {
        const r = agruparConciliacion(
            [fila(100, 1_000_000), fila(200, -300_000)], MAESTRO, [], VENDEDORES,
        );
        expect(totalesCartera(r, null).total.saldo_im).toBe(700_000);
    });
});

describe('parsearCods', () => {
    it('lee la lista del query', () => {
        expect(parsearCods('2,3,12')).toEqual([2, 3, 12]);
        expect(parsearCods(' 2 , 3 ')).toEqual([2, 3]);
    });
    it('sin filtro es null, no lista vacía', () => {
        expect(parsearCods(undefined)).toBeNull();
        expect(parsearCods('')).toBeNull();
        expect(parsearCods('abc')).toBeNull();
    });
    // El 0 es "Sin vendedor" y es un grupo real: tiene que poder filtrarse.
    it('el 0 (Sin vendedor) es un código válido', () => {
        expect(parsearCods('0,3')).toEqual([0, 3]);
    });
});
