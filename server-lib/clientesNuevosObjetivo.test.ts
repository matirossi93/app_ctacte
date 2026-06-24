import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock de InfoManager: el helper trae el maestro de clientes desde IM para
// enriquecer (razón social, localidad, vendedor) los clientes nuevos con ventas.
const fetchClientesIMCached = vi.fn();
vi.mock('./infomanager.js', () => ({
  fetchVendedores: vi.fn(),
  fetchVentas: vi.fn(),
  fetchClientesIMCached: (...args: any[]) => fetchClientesIMCached(...args),
}));

// Supabase no se usa en el helper, pero goals.ts lo importa a nivel módulo.
vi.mock('./supabase.js', () => ({
  sb: vi.fn(),
  TENANT_ID: 'test-tenant',
  hasSupabase: () => true,
}));

import { buildClientesNuevosConVentas } from './goals.js';

const IM_MAESTRO = [
  { cod_cliente: 100, razon_social: 'MIRANDA MERCEDES', localidad: 'alberdi', cod_vendedor: 7 },
  { cod_cliente: 200, razon_social: 'OTRO CLIENTE', localidad: 'tafi', cod_vendedor: 9 },
  { cod_cliente: 300, razon_social: 'SIN VENDEDOR', localidad: null, cod_vendedor: null },
];

describe('buildClientesNuevosConVentas', () => {
  beforeEach(() => {
    fetchClientesIMCached.mockReset();
    fetchClientesIMCached.mockResolvedValue(IM_MAESTRO);
  });

  it('agrega el cliente nuevo con ventas que NO está en client_operational', async () => {
    const sales = new Map([[100, { neto: 50000, num: 2 }]]);
    const out = await buildClientesNuevosConVentas({
      salesByCliente: sales,
      existingCods: new Set(), // ninguno está en el Excel todavía
      codVend: null,
      codsList: null,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      cod_cliente: 100,
      razon_social: 'MIRANDA MERCEDES',
      localidad: 'Alberdi',
      cod_vendedor: 7,
      objetivo_mes: null,
      avance: 50000,
      num_comprobantes: 2,
      status: 'sin_objetivo',
      es_nuevo: true,
    });
  });

  it('NO duplica clientes que ya están en client_operational', async () => {
    const sales = new Map([[100, { neto: 50000, num: 2 }]]);
    const out = await buildClientesNuevosConVentas({
      salesByCliente: sales,
      existingCods: new Set([100]), // ya estaba en el Excel
      codVend: null,
      codsList: null,
    });
    expect(out).toHaveLength(0);
  });

  it('un vendedor solo ve sus propios clientes nuevos', async () => {
    const sales = new Map([
      [100, { neto: 50000, num: 2 }], // vendedor 7
      [200, { neto: 30000, num: 1 }], // vendedor 9
    ]);
    const out = await buildClientesNuevosConVentas({
      salesByCliente: sales,
      existingCods: new Set(),
      codVend: 7, // request del vendedor 7
      codsList: null,
    });
    expect(out).toHaveLength(1);
    expect(out[0].cod_cliente).toBe(100);
  });

  it('filtro por lista de cods (admin con varios vendedores) respeta los cods', async () => {
    const sales = new Map([
      [100, { neto: 50000, num: 2 }], // vend 7
      [200, { neto: 30000, num: 1 }], // vend 9
      [300, { neto: 10000, num: 1 }], // sin vendedor
    ]);
    const out = await buildClientesNuevosConVentas({
      salesByCliente: sales,
      existingCods: new Set(),
      codVend: null,
      codsList: [9],
    });
    expect(out.map(c => c.cod_cliente)).toEqual([200]);
  });

  it('si IM no responde, devuelve [] sin romper la vista', async () => {
    fetchClientesIMCached.mockRejectedValue(new Error('IM caído'));
    const sales = new Map([[100, { neto: 50000, num: 2 }]]);
    const out = await buildClientesNuevosConVentas({
      salesByCliente: sales,
      existingCods: new Set(),
      codVend: null,
      codsList: null,
    });
    expect(out).toEqual([]);
  });

  it('cliente con ventas pero sin metadata en IM cae a "Cliente #cod"', async () => {
    const sales = new Map([[999, { neto: 12345, num: 1 }]]);
    const out = await buildClientesNuevosConVentas({
      salesByCliente: sales,
      existingCods: new Set(),
      codVend: null,
      codsList: null,
    });
    expect(out).toHaveLength(1);
    expect(out[0].razon_social).toBe('Cliente #999');
    expect(out[0].cod_vendedor).toBeNull();
  });
});
