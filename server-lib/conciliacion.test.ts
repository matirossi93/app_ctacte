import { describe, it, expect, vi } from 'vitest';

// conciliacion.ts importa infomanager.js a nivel módulo, y ese módulo hace
// process.exit(1) si INFOMANAGER_CLIENT_SECRET no está en el entorno (no está
// en CI/local). Acá solo testeamos la función PURA, así que mockeamos ambos
// side-effects de import (mismo patrón que clientesNuevosObjetivo.test.ts).
// recibosShared.js NO se mockea: es la fuente única real de los estados y no
// tiene side-effects de import.
vi.mock('./infomanager.js', () => ({
  fetchComprobPendientes: vi.fn(),
  fetchClientesIMCached: vi.fn(),
  fetchVendedores: vi.fn(),
}));
vi.mock('./supabase.js', () => ({
  sb: vi.fn(),
  TENANT_ID: 'test-tenant',
  hasSupabase: () => true,
}));

import {
  agruparConciliacion,
  type PendienteIM,
  type ClienteMaestro,
  type ReciboTransito,
  type VendedorIM,
} from './conciliacion.js';
import { CADUCADO_PREFIX } from './recibosShared.js';

/**
 * Tests de la función PURA de conciliación. Blindan las reglas validadas
 * contra el spike real del 01/07/2026 + los fixes del review adversarial:
 *  - saldo del cliente = suma de filas positivas Y negativas
 *  - el vendedor sale del maestro (las filas RC/NC traen cod_vendedor 0)
 *  - internas (1/652/666/861) van aparte, NO suman a totales, PERO conservan
 *    su tránsito/anticipos/caducados
 *  - recibos en tránsito (pendiente_revision + error real) restan → saldo_ajustado
 *  - anticipos 'aprobado' NO restan (doble descuento post carga manual en IM):
 *    van a bucket propio
 *  - caducados ([CADUCADO]) NO restan: contador aparte
 *  - |saldo| < $1 sin nada en la app se excluye (ruido de centavos)
 *  - vendedor desconocido → grupo "Sin vendedor"
 */

const VENDEDORES: VendedorIM[] = [
  { cod_vendedor: 2, nombre: 'Sebastián' },
  { cod_vendedor: 3, nombre: 'Marcelo' },
  { cod_vendedor: 6, nombre: 'Andrea' },
];

function fila(over: Partial<PendienteIM>): PendienteIM {
  return {
    cod_cliente: 100,
    cod_vendedor: 2,
    nombre: 'CLIENTE DEMO',
    tipo_comprobante: 'FA',
    punto_de_venta: 3,
    numero: 142847,
    fecha_factura: '2026-06-01',
    importe_factura: 1000,
    importe_pagado: 0,
    saldo: 1000,
    dias_deuda: 10,
    ...over,
  };
}

function buscarCliente(res: ReturnType<typeof agruparConciliacion>, cod: number) {
  for (const v of res.vendedores) {
    const c = v.clientes.find(c => c.cod_cliente === cod);
    if (c) return { vendedor: v, cliente: c };
  }
  return null;
}

describe('agruparConciliacion', () => {
  it('suma saldos positivos y negativos por cliente', () => {
    const pendientes = [
      fila({ cod_cliente: 100, tipo_comprobante: 'FA', saldo: 150000.5 }),
      fila({ cod_cliente: 100, tipo_comprobante: 'RC', saldo: -50000.25, cod_vendedor: 0 }),
      fila({ cod_cliente: 100, tipo_comprobante: 'NC', saldo: -10000, cod_vendedor: 0 }),
    ];
    const maestro: ClienteMaestro[] = [{ cod_cliente: 100, razon_social: 'PET SHOP UNO', cod_vendedor: 2 }];
    const res = agruparConciliacion(pendientes, maestro, [], VENDEDORES);

    const hit = buscarCliente(res, 100);
    expect(hit).not.toBeNull();
    expect(hit!.cliente.saldo_im).toBeCloseTo(90000.25, 2);
    expect(hit!.cliente.n_comprobantes).toBe(3);
    expect(hit!.cliente.nombre).toBe('PET SHOP UNO');
    expect(res.totales.saldo_im).toBeCloseTo(90000.25, 2);
  });

  it('asigna el vendedor por MAESTRO aunque las filas RC traigan cod_vendedor 0', () => {
    // Cliente cuyas ÚNICAS filas son RC con cod_vendedor 0 (caso real del spike)
    const pendientes = [
      fila({ cod_cliente: 1232, tipo_comprobante: 'RC', saldo: -5100.2, cod_vendedor: 0 }),
    ];
    const maestro: ClienteMaestro[] = [{ cod_cliente: 1232, razon_social: 'FORRAJERÍA DOS', cod_vendedor: 3 }];
    const res = agruparConciliacion(pendientes, maestro, [], VENDEDORES);

    const hit = buscarCliente(res, 1232);
    expect(hit).not.toBeNull();
    expect(hit!.vendedor.cod_vendedor).toBe(3);
    expect(hit!.vendedor.nombre).toBe('Marcelo');
    expect(hit!.cliente.saldo_im).toBeCloseTo(-5100.2, 2);
  });

  it('separa las cuentas internas (1/652/666/861) y no las suma a los totales', () => {
    const pendientes = [
      fila({ cod_cliente: 652, nombre: 'SUCURSAL SAN JUAN', saldo: 2000000 }),
      fila({ cod_cliente: 100, saldo: 5000 }),
    ];
    const maestro: ClienteMaestro[] = [
      { cod_cliente: 652, razon_social: 'SUCURSAL SAN JUAN', cod_vendedor: 2 },
      { cod_cliente: 100, razon_social: 'PET SHOP UNO', cod_vendedor: 2 },
    ];
    const res = agruparConciliacion(pendientes, maestro, [], VENDEDORES);

    expect(res.internas).toHaveLength(1);
    expect(res.internas[0].cod_cliente).toBe(652);
    expect(res.internas[0].saldo_im).toBe(2000000);
    // La interna NO aparece en ningún grupo de vendedor ni en los totales
    expect(buscarCliente(res, 652)).toBeNull();
    expect(res.totales.saldo_im).toBe(5000);
  });

  it('resta los recibos en tránsito (pendiente_revision + error real) del saldo IM', () => {
    const pendientes = [fila({ cod_cliente: 100, saldo: 100000 })];
    const maestro: ClienteMaestro[] = [{ cod_cliente: 100, razon_social: 'PET SHOP UNO', cod_vendedor: 2 }];
    const recibos: ReciboTransito[] = [
      { id: 'r1', cod_cliente: 100, monto: 30000, fecha_comprobante: '2026-06-28', status: 'pendiente_revision' },
      // error SIN [CADUCADO] = rechazo real de IM: la plata se cobró, sigue en tránsito
      { id: 'r2', cod_cliente: 100, monto: 20000, fecha_comprobante: null, created_at: '2026-06-30T12:00:00Z', status: 'error', error_msg: 'IM rechazó el recibo (saldo insuficiente)' },
    ];
    const res = agruparConciliacion(pendientes, maestro, recibos, VENDEDORES);

    const hit = buscarCliente(res, 100)!;
    expect(hit.cliente.en_transito).toBe(50000);
    expect(hit.cliente.saldo_ajustado).toBe(50000);
    expect(hit.cliente.recibos_transito).toHaveLength(2);
    // El recibo sin fecha_comprobante cae a la fecha de carga
    expect(hit.cliente.recibos_transito.find(r => r.id === 'r2')!.fecha).toBe('2026-06-30');
    expect(res.totales.en_transito).toBe(50000);
    expect(res.totales.ajustado).toBe(50000);
  });

  it('anticipos "aprobado" NO restan: van al bucket anticipos_aprobados', () => {
    // El backoffice carga el anticipo A MANO en IM y no existe transición
    // aprobado→imputado en la app: si restara, sería doble descuento perpetuo
    // una vez cargado en IM.
    const pendientes = [fila({ cod_cliente: 100, saldo: 100000 })];
    const maestro: ClienteMaestro[] = [{ cod_cliente: 100, razon_social: 'PET SHOP UNO', cod_vendedor: 2 }];
    const recibos: ReciboTransito[] = [
      { id: 'a1', cod_cliente: 100, monto: 40000, fecha_comprobante: '2026-06-25', status: 'aprobado' },
      { id: 'r1', cod_cliente: 100, monto: 10000, fecha_comprobante: '2026-06-28', status: 'pendiente_revision' },
    ];
    const res = agruparConciliacion(pendientes, maestro, recibos, VENDEDORES);

    const hit = buscarCliente(res, 100)!;
    // Solo el pendiente resta; el anticipo NO
    expect(hit.cliente.en_transito).toBe(10000);
    expect(hit.cliente.saldo_ajustado).toBe(90000);
    expect(hit.cliente.recibos_transito).toHaveLength(1);
    expect(hit.cliente.anticipos_aprobados).toEqual([{ id: 'a1', monto: 40000, fecha: '2026-06-25' }]);
    // Totales por vendedor y globales
    expect(hit.vendedor.total_anticipos).toBe(40000);
    expect(hit.vendedor.total_en_transito).toBe(10000);
    expect(res.totales.total_anticipos).toBe(40000);
    expect(res.totales.en_transito).toBe(10000);
    expect(res.totales.ajustado).toBe(90000);
  });

  it('cliente con SOLO un anticipo aprobado (sin pendientes IM) igual aparece', () => {
    const recibos: ReciboTransito[] = [
      { id: 'a9', cod_cliente: 777, monto: 25000, fecha_comprobante: '2026-06-20', status: 'aprobado' },
    ];
    const maestro: ClienteMaestro[] = [{ cod_cliente: 777, razon_social: 'ANTICIPADO SRL', cod_vendedor: 2 }];
    const res = agruparConciliacion([], maestro, recibos, VENDEDORES);

    const hit = buscarCliente(res, 777)!;
    expect(hit.cliente.saldo_im).toBe(0);
    expect(hit.cliente.saldo_ajustado).toBe(0); // no resta
    expect(hit.cliente.anticipos_aprobados).toHaveLength(1);
  });

  it('recibos caducados ([CADUCADO]) NO cuentan como tránsito: contador aparte', () => {
    const pendientes = [fila({ cod_cliente: 100, saldo: 50000 })];
    const maestro: ClienteMaestro[] = [{ cod_cliente: 100, razon_social: 'PET SHOP UNO', cod_vendedor: 2 }];
    const recibos: ReciboTransito[] = [
      { id: 'c1', cod_cliente: 100, monto: 8000, fecha_comprobante: '2026-04-01', status: 'error', error_msg: `${CADUCADO_PREFIX} Más de 30 días en pendiente_revisión sin imputar — revisar y reprocesar o descartar.` },
      { id: 'r1', cod_cliente: 100, monto: 5000, fecha_comprobante: '2026-06-29', status: 'pendiente_revision' },
    ];
    const res = agruparConciliacion(pendientes, maestro, recibos, VENDEDORES);

    const hit = buscarCliente(res, 100)!;
    expect(hit.cliente.en_transito).toBe(5000);        // el caducado NO resta
    expect(hit.cliente.saldo_ajustado).toBe(45000);
    expect(hit.cliente.caducados).toBe(1);
    expect(hit.cliente.recibos_transito.map(r => r.id)).toEqual(['r1']);
    expect(res.totales.caducados).toBe(1);
  });

  it('un cliente con tránsito pero SIN pendientes en IM igual aparece', () => {
    const recibos: ReciboTransito[] = [
      { id: 'r9', cod_cliente: 555, monto: 15000, fecha_comprobante: '2026-06-29', status: 'error', error_msg: 'IM rechazó' },
    ];
    const maestro: ClienteMaestro[] = [{ cod_cliente: 555, razon_social: 'AL DÍA SRL', cod_vendedor: 6 }];
    const res = agruparConciliacion([], maestro, recibos, VENDEDORES);

    const hit = buscarCliente(res, 555)!;
    expect(hit.vendedor.nombre).toBe('Andrea'); // mostrador entra como grupo propio
    expect(hit.cliente.saldo_im).toBe(0);
    expect(hit.cliente.saldo_ajustado).toBe(-15000);
  });

  it('una interna con recibos en tránsito los conserva (no van a totales de vendedores)', () => {
    const pendientes = [
      fila({ cod_cliente: 652, nombre: 'SUCURSAL SAN JUAN', saldo: 900000 }),
    ];
    const recibos: ReciboTransito[] = [
      { id: 'i1', cod_cliente: 652, monto: 120000, fecha_comprobante: '2026-06-27', status: 'pendiente_revision' },
      { id: 'i2', cod_cliente: 652, monto: 30000, fecha_comprobante: '2026-06-20', status: 'aprobado' },
    ];
    const res = agruparConciliacion(pendientes, [], recibos, VENDEDORES);

    expect(res.internas).toHaveLength(1);
    const interna = res.internas[0];
    expect(interna.en_transito).toBe(120000);
    expect(interna.total_anticipos).toBe(30000);
    expect(interna.caducados).toBe(0);
    // El tránsito interno NO contamina los totales de clientes reales
    expect(res.totales.en_transito).toBe(0);
    expect(res.totales.total_anticipos).toBe(0);
  });

  it('una interna con SOLO tránsito (sin filas IM) no desaparece', () => {
    const recibos: ReciboTransito[] = [
      { id: 'i9', cod_cliente: 666, monto: 50000, fecha_comprobante: '2026-06-30', status: 'pendiente_revision' },
    ];
    const res = agruparConciliacion([], [], recibos, VENDEDORES);

    expect(res.internas).toHaveLength(1);
    expect(res.internas[0].cod_cliente).toBe(666);
    expect(res.internas[0].saldo_im).toBe(0);
    expect(res.internas[0].en_transito).toBe(50000);
  });

  it('excluye clientes con |saldo| < $1 y sin nada en la app, pero NO si tienen tránsito', () => {
    const pendientes = [
      fila({ cod_cliente: 1013, saldo: 0.657 }),   // residuo de centavos → afuera
      fila({ cod_cliente: 1014, saldo: -0.5 }),    // residuo negativo → afuera
      fila({ cod_cliente: 1015, saldo: 0.8 }),     // residuo PERO con recibo en tránsito → adentro
    ];
    const maestro: ClienteMaestro[] = [
      { cod_cliente: 1013, razon_social: 'A', cod_vendedor: 2 },
      { cod_cliente: 1014, razon_social: 'B', cod_vendedor: 2 },
      { cod_cliente: 1015, razon_social: 'C', cod_vendedor: 2 },
    ];
    const recibos: ReciboTransito[] = [
      { id: 'r1', cod_cliente: 1015, monto: 9000, fecha_comprobante: '2026-06-30', status: 'pendiente_revision' },
    ];
    const res = agruparConciliacion(pendientes, maestro, recibos, VENDEDORES);

    expect(buscarCliente(res, 1013)).toBeNull();
    expect(buscarCliente(res, 1014)).toBeNull();
    expect(buscarCliente(res, 1015)).not.toBeNull();
  });

  it('clientes sin vendedor conocido caen al grupo "Sin vendedor", que va último', () => {
    const pendientes = [
      fila({ cod_cliente: 200, saldo: 999999 }),  // vendedor 2 → grupo normal, total gigante
      fila({ cod_cliente: 300, saldo: 7000 }),    // maestro con vendedor desconocido (99)
      fila({ cod_cliente: 400, saldo: 3000, nombre: 'SIN MAESTRO SA' }), // no está en el maestro
    ];
    const maestro: ClienteMaestro[] = [
      { cod_cliente: 200, razon_social: 'GRANDE SRL', cod_vendedor: 2 },
      { cod_cliente: 300, razon_social: 'HUÉRFANO SRL', cod_vendedor: 99 },
    ];
    const res = agruparConciliacion(pendientes, maestro, [], VENDEDORES);

    const sinVend = res.vendedores.find(v => v.nombre === 'Sin vendedor');
    expect(sinVend).toBeDefined();
    expect(sinVend!.cod_vendedor).toBe(0);
    expect(sinVend!.clientes.map(c => c.cod_cliente).sort()).toEqual([300, 400]);
    // El que no está en el maestro toma el nombre de la fila IM
    expect(sinVend!.clientes.find(c => c.cod_cliente === 400)!.nombre).toBe('SIN MAESTRO SA');
    // "Sin vendedor" siempre al final aunque su total sea chico
    expect(res.vendedores[res.vendedores.length - 1].nombre).toBe('Sin vendedor');
  });

  it('aging = MAX(dias_deuda) SOLO de FA/ND con saldo > 0', () => {
    const pendientes = [
      fila({ cod_cliente: 100, tipo_comprobante: 'FA', saldo: 5000, dias_deuda: 45 }),
      fila({ cod_cliente: 100, tipo_comprobante: 'ND', saldo: 100, dias_deuda: 70 }),
      fila({ cod_cliente: 100, tipo_comprobante: 'FA', saldo: 0, dias_deuda: 200 }),      // saldada: no cuenta
      fila({ cod_cliente: 100, tipo_comprobante: 'RC', saldo: -3000, dias_deuda: 999 }),  // RC: no cuenta
      fila({ cod_cliente: 100, tipo_comprobante: 'ASH', saldo: -100, dias_deuda: 1500 }), // ASH: no cuenta
    ];
    const maestro: ClienteMaestro[] = [{ cod_cliente: 100, razon_social: 'X', cod_vendedor: 2 }];
    const res = agruparConciliacion(pendientes, maestro, [], VENDEDORES);

    expect(buscarCliente(res, 100)!.cliente.aging_dias).toBe(70);
  });

  it('cliente sin facturas vivas (solo RC/NC) tiene aging null', () => {
    const pendientes = [fila({ cod_cliente: 100, tipo_comprobante: 'RC', saldo: -8000, dias_deuda: 30, cod_vendedor: 0 })];
    const maestro: ClienteMaestro[] = [{ cod_cliente: 100, razon_social: 'X', cod_vendedor: 2 }];
    const res = agruparConciliacion(pendientes, maestro, [], VENDEDORES);

    expect(buscarCliente(res, 100)!.cliente.aging_dias).toBeNull();
  });

  it('ordena clientes por |saldo ajustado| desc dentro del vendedor', () => {
    const pendientes = [
      fila({ cod_cliente: 101, saldo: 10000 }),
      fila({ cod_cliente: 102, saldo: -80000 }),
      fila({ cod_cliente: 103, saldo: 40000 }),
    ];
    const maestro: ClienteMaestro[] = [101, 102, 103].map(cod => ({ cod_cliente: cod, razon_social: `C${cod}`, cod_vendedor: 2 }));
    const res = agruparConciliacion(pendientes, maestro, [], VENDEDORES);

    const seba = res.vendedores.find(v => v.cod_vendedor === 2)!;
    expect(seba.clientes.map(c => c.cod_cliente)).toEqual([102, 103, 101]);
  });
});
