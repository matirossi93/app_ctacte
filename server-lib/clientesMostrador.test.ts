import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });

const m = vi.hoisted(() => ({ fetchClientesIMCached: vi.fn(), sbMock: vi.fn() }));
vi.mock('./infomanager.js', () => ({ fetchClientesIMCached: m.fetchClientesIMCached }));
vi.mock('./supabase.js', () => ({ sb: m.sbMock, TENANT_ID: 't', hasSupabase: () => true }));

const { listClientesLookup } = await import('./clientes.js');

/**
 * Un `rol = 'vendedor'` ve sólo los clientes de SU cartera. Los usuarios de sucursal atienden
 * un MOSTRADOR: les entra cualquier cliente por la puerta, así que ese filtro les esconde justo
 * al que tienen enfrente. Lo decide `usuarios.ve_todos_los_clientes` (migración 028).
 */

const CLIENTES = [
  { cod_cliente: 1, razon_social: 'CLIENTE DE SEBASTIAN', localidad: 'Centro', cod_vendedor: 2, lista_precio: 12 },
  { cod_cliente: 2, razon_social: 'CLIENTE DE MARCELO', localidad: 'Banda', cod_vendedor: 3, lista_precio: 13 },
  { cod_cliente: 3, razon_social: 'CLIENTE SIN VENDEDOR', localidad: 'Tafi', cod_vendedor: null, lista_precio: 12 },
];

let fila: any = { im_usuario: null, cod_empresa: null, ve_todos_los_clientes: false };

beforeEach(() => {
  m.fetchClientesIMCached.mockReset().mockResolvedValue(CLIENTES);
  m.sbMock.mockImplementation(() => ({
    from: () => {
      const q: any = { maybeSingle: () => Promise.resolve({ data: fila, error: null }) };
      for (const k of ['select', 'eq']) q[k] = () => q;
      return q;
    },
  }));
});

async function lookup(user: any) {
  let body: any;
  await listClientesLookup({ query: {}, user } as any, { json: (b: any) => { body = b; }, status: () => ({ json: (b: any) => { body = b; } }) } as any);
  return body;
}

describe('a quién ve cada usuario en el buscador de clientes', () => {
  it('un vendedor con cartera sigue viendo sólo los suyos', async () => {
    fila = { ve_todos_los_clientes: false };
    const r = await lookup({ sub: 'u1', rol: 'vendedor', cod_vendedor: 2 });
    expect(r.items.map((i: any) => i.cod)).toEqual(['1']);
  });

  it('🔴 el usuario de mostrador ve el maestro entero', async () => {
    fila = { ve_todos_los_clientes: true };
    const r = await lookup({ sub: 'u2', rol: 'vendedor', cod_vendedor: 7 });
    expect(r.items).toHaveLength(3);
  });

  it('🔴 el de mostrador no necesita cod_vendedor para poder elegir', async () => {
    // 🪤 Sin esto se cortaba antes de listar y le avisaba que le faltaba configurar un código
    // de vendedor que, para atender el mostrador, no le hace falta.
    fila = { ve_todos_los_clientes: true };
    const r = await lookup({ sub: 'u3', rol: 'vendedor', cod_vendedor: null });
    expect(r.sin_vendedor).toBeUndefined();
    expect(r.items).toHaveLength(3);
  });

  it('un vendedor con cartera y SIN código sigue avisando que le falta configuración', async () => {
    fila = { ve_todos_los_clientes: false };
    const r = await lookup({ sub: 'u4', rol: 'vendedor', cod_vendedor: null });
    expect(r.sin_vendedor).toBe(true);
    expect(r.items).toEqual([]);
  });

  it('admin sigue viendo todos, tenga o no el flag', async () => {
    fila = { ve_todos_los_clientes: false };
    const r = await lookup({ sub: 'u5', rol: 'admin', cod_vendedor: null });
    expect(r.items).toHaveLength(3);
  });
});
