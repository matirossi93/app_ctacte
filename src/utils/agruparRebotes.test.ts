import { describe, it, expect } from 'vitest';
import {
    agruparPorCliente, corteRelevante, claveCliente, mesAnterior, totalHastaDia, variacionPorc,
    type RebotePlano,
} from './agruparRebotes';

/**
 * 16/09/2026 — Mati sobre la pestaña Rebotes: *"¿hay alguna manera que sea más sencillo de ver
 * e interpretar? veo demasiadas filas"*. Un mes real del sheet son ~150 renglones (uno por
 * artículo) más la lista de recargos, que repite los mismos clientes.
 */

let n = 0;
const row = (p: Partial<RebotePlano>): RebotePlano => ({
    fila: ++n, fecha: '2026-09-10', cliente_raw: 'CLIENTE', cod_cliente: null,
    vendedor_raw: 'MARCELO', cod_vendedor: 3, articulo: 'MAIZ', cantidad: 1,
    motivo: 'devolucion', motivo_raw: 'DEVOLUCION', total: 1000, ...p,
});

describe('claveCliente', () => {
    it('usa el código cuando matcheó con IM', () => {
        expect(claveCliente(861, 'LO QUE SEA')).toBe('861');
    });

    it('🔑 sin código cae al nombre crudo — igual que el backend, o el recargo se pega al cliente equivocado', () => {
        expect(claveCliente(null, 'ROSALES ANGELES')).toBe('raw:ROSALES ANGELES');
    });
});

describe('agruparPorCliente', () => {
    it('junta los renglones del mismo cliente y suma la plata', () => {
        // Caso real del sheet: ROSALES ANGELES, 3 artículos el mismo día = 3 filas en pantalla.
        const g = agruparPorCliente([
            row({ cliente_raw: 'ROSALES ANGELES', total: 9517, motivo: 'cerrado' }),
            row({ cliente_raw: 'ROSALES ANGELES', total: 5197, motivo: 'cerrado' }),
            row({ cliente_raw: 'ROSALES ANGELES', total: 14986, motivo: 'cerrado' }),
        ]);
        expect(g).toHaveLength(1);
        expect(g[0].total).toBe(29700);
        expect(g[0].renglones).toHaveLength(3);
        expect(g[0].dias).toEqual(['2026-09-10']);
    });

    it('ordena por plata: el cliente que más costó va primero', () => {
        const g = agruparPorCliente([
            row({ cliente_raw: 'CHICO', total: 5000 }),
            row({ cliente_raw: 'GRANDE', total: 200000 }),
            row({ cliente_raw: 'MEDIANO', total: 40000 }),
        ]);
        expect(g.map(x => x.cliente)).toEqual(['GRANDE', 'MEDIANO', 'CHICO']);
    });

    it('cuenta los días distintos: eso es la reincidencia del mes', () => {
        const g = agruparPorCliente([
            row({ cliente_raw: 'REBOTON', fecha: '2026-09-02' }),
            row({ cliente_raw: 'REBOTON', fecha: '2026-09-11' }),
            row({ cliente_raw: 'REBOTON', fecha: '2026-09-11' }),
        ]);
        expect(g[0].dias).toEqual(['2026-09-11', '2026-09-02']);
        expect(g[0].ultimaFecha).toBe('2026-09-11');
    });

    it('el responsable dominante es el que explica más plata, no el que tiene más filas', () => {
        // 3 renglones chicos de culpa del cliente vs 1 grande del depósito: manda el grande.
        const g = agruparPorCliente([
            row({ cliente_raw: 'X', total: 1000, motivo: 'devolucion' }),
            row({ cliente_raw: 'X', total: 1000, motivo: 'devolucion' }),
            row({ cliente_raw: 'X', total: 1000, motivo: 'sin_dinero' }),
            row({ cliente_raw: 'X', total: 90000, motivo: 'mc_deposito' }),
        ]);
        expect(g[0].responsables[0]).toBe('empresa');
        expect(g[0].responsables).toContain('cliente');
    });

    it('pega el recargo del 3% que viene del backend (no lo recalcula)', () => {
        const g = agruparPorCliente(
            [row({ cliente_raw: 'PIRAS EXEQUIEL', total: 73310 })],
            new Map([['raw:PIRAS EXEQUIEL', 2199.3]]),
        );
        expect(g[0].recargo).toBe(2199.3);
    });

    it('sin mapa de recargos, el grupo queda en cero (no inventa un 3%)', () => {
        const g = agruparPorCliente([row({ cliente_raw: 'A', motivo: 'mc_deposito' })]);
        expect(g[0].recargo).toBe(0);
    });

    it('un cliente con dos vendedores los muestra a los dos', () => {
        const g = agruparPorCliente([
            row({ cliente_raw: 'A', vendedor_raw: 'MARCELO' }),
            row({ cliente_raw: 'A', vendedor_raw: 'BRIAN' }),
        ]);
        expect(g[0].vendedores).toEqual(['MARCELO', 'BRIAN']);
    });

    it('filas sin fecha no rompen el orden interno', () => {
        const g = agruparPorCliente([
            row({ cliente_raw: 'A', fecha: null, total: 500 }),
            row({ cliente_raw: 'A', fecha: '2026-09-05', total: 100 }),
        ]);
        expect(g[0].renglones[0].fecha).toBe('2026-09-05');
        expect(g[0].ultimaFecha).toBe('2026-09-05');
    });
});

describe('corteRelevante', () => {
    const muchos = (cantidad: number, monto: (i: number) => number) =>
        agruparPorCliente(Array.from({ length: cantidad }, (_, i) =>
            row({ cliente_raw: `C${i}`, total: monto(i) })));

    it('con pocos clientes no esconde nada', () => {
        const c = corteRelevante(muchos(6, () => 1000));
        expect(c.ocultos).toHaveLength(0);
        expect(c.visibles).toHaveLength(6);
    });

    it('🎯 con la cola larga deja arriba el 80% de la plata', () => {
        // 5 clientes de $100.000 + 40 de $1.000 = $540.000. El 80% ($432.000) se cubre
        // con los 5 grandes; los 40 chicos son el 7% del dinero y el 89% de las filas.
        const c = corteRelevante(muchos(45, i => (i < 5 ? 100000 : 1000)));
        expect(c.visibles.length).toBeLessThanOrEqual(10);
        expect(c.ocultos.length).toBeGreaterThan(30);
        expect(c.totalOculto).toBeLessThan(c.visibles.reduce((a, g) => a + g.total, 0));
    });

    it('lo oculto + lo visible siempre da el total (no se pierde un peso)', () => {
        const grupos = muchos(40, i => 100000 - i * 2000);
        const c = corteRelevante(grupos);
        const suma = c.visibles.reduce((a, g) => a + g.total, 0) + c.totalOculto;
        expect(Math.round(suma)).toBe(Math.round(grupos.reduce((a, g) => a + g.total, 0)));
    });

    it('no esconde una cola de 1 o 2 clientes: el click cuesta más que el scroll', () => {
        // 9 clientes con la plata muy repartida: el corte del 80% dejaría 2 afuera.
        const c = corteRelevante(muchos(9, () => 1000));
        expect(c.ocultos).toHaveLength(0);
    });

    it('si toda la plata está en uno solo, igual muestra 5 (una lista de 1 desorienta)', () => {
        const c = corteRelevante(muchos(30, i => (i === 0 ? 1000000 : 100)));
        expect(c.visibles).toHaveLength(5);
    });

    it('mes sin plata (todo en cero) no rompe', () => {
        const c = corteRelevante(muchos(20, () => 0));
        expect(c.visibles).toHaveLength(20);
        expect(c.ocultos).toHaveLength(0);
    });
});

describe('mesAnterior', () => {
    it('resta un mes', () => expect(mesAnterior(2026, 9)).toEqual({ year: 2026, month: 8 }));
    it('en enero cruza el año', () => expect(mesAnterior(2026, 1)).toEqual({ year: 2025, month: 12 }));
});

describe('totalHastaDia', () => {
    const rows = [
        row({ fecha: '2026-08-05', total: 100 }),
        row({ fecha: '2026-08-16', total: 200 }),
        row({ fecha: '2026-08-28', total: 400 }),
        row({ fecha: null, total: 50 }),
    ];

    it('🎯 corta el mes anterior al mismo día: 16 días contra 16 días', () => {
        expect(totalHastaDia(rows, 2026, 8, 16)).toBe(350); // 100 + 200 + los 50 sin fecha
    });

    it('sin corte suma el mes entero', () => {
        expect(totalHastaDia(rows, 2026, 8, null)).toBe(750);
    });
});

describe('variacionPorc', () => {
    it('bajó a la mitad = -50%', () => expect(variacionPorc(500, 1000)).toBe(-50));
    it('subió un tercio', () => expect(variacionPorc(400, 300)).toBe(33));
    it('🔴 mes anterior en cero → null, no Infinity', () => expect(variacionPorc(1000, 0)).toBeNull());
});
