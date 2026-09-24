import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  process.env.IM_USUARIO_PEDIDOS = 'susana';
  process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret';
});

const im = vi.hoisted(() => ({
  crearPresupuesto: vi.fn(),
  fetchClientesIMCached: vi.fn(),
  fetchArticulosDeDeposito: vi.fn(),
  fetchArticulosCatalogo: vi.fn(),
  getPrecioLista: vi.fn(),
  fetchVendedores: vi.fn(),
  sbMock: vi.fn(),
}));

vi.mock('./infomanager.js', () => ({
  invalidarCacheVentas: vi.fn(),
  invalidarCacheItems: vi.fn(),
  crearPresupuesto: im.crearPresupuesto,
  fetchClientesIMCached: im.fetchClientesIMCached,
  fetchArticulosDeDeposito: im.fetchArticulosDeDeposito,
  fetchArticulosCatalogo: im.fetchArticulosCatalogo,
  getPrecioLista: im.getPrecioLista,
  fetchVendedores: im.fetchVendedores,
  anularComprobante: vi.fn(), getDisponibleCliente: vi.fn(), getItemsComprobante: vi.fn(),
  presupuestoFacturado: vi.fn(), actualizarPresupuestoCantidades: vi.fn(),
  cabeceraComprobante: vi.fn(), fechaComprobante: vi.fn(),
  fechaArgentina: () => '2026-09-24', fetchPreciosDeLista: vi.fn(),
}));
vi.mock('./supabase.js', () => ({ sb: im.sbMock, TENANT_ID: 't', hasSupabase: () => true }));

const { crearPedido } = await import('./pedidos.js');

let insertado: any = null;
function fakeSb() {
  im.sbMock.mockImplementation(() => ({
    from: (t: string) => {
      const q: any = {
        then: (r: any, j: any) => Promise.resolve({ data: t === 'usuarios' ? { im_usuario: 'sebastian', cod_empresa: null } : [], error: null }).then(r, j),
        maybeSingle: () => Promise.resolve({ data: t === 'usuarios' ? { im_usuario: 'sebastian', cod_empresa: null } : null, error: null }),
        insert: (v: any) => { if (t === 'pedidos_vendedor') insertado = Array.isArray(v) ? v[0] : v; return q; },
        update: () => q, delete: () => q,
      };
      for (const m of ['select', 'eq', 'order', 'limit', 'in']) q[m] = () => q;
      return q;
    },
  }));
}

const USER = { sub: 'u1', rol: 'vendedor', cod_vendedor: 3, nombre: 'Vendedor' } as any;

async function crear(items: any[]) {
  let status = 200; let body: any;
  const req: any = { body: { cod_cliente: 628, items }, user: USER, on: () => {} };
  const res: any = { status: (s: number) => { status = s; return res; }, json: (b: any) => { body = b; } };
  await crearPedido(req, res);
  return { status, body };
}

beforeEach(() => {
  insertado = null;
  for (const f of Object.values(im)) (f as any).mockReset?.();
  fakeSb();
  im.fetchClientesIMCached.mockResolvedValue([{ cod_cliente: 628, razon_social: 'CLIENTE', lista_precio: 14, cod_vendedor: 3 }]);
  im.fetchArticulosCatalogo.mockResolvedValue(new Map());
  im.fetchVendedores.mockResolvedValue([]);
  im.fetchArticulosDeDeposito.mockResolvedValue(new Set([995, 140]));
});

/**
 * 🔑 24/09/2026 11:34: InfoManager estaba en pausa por exceso de consultas y un vendedor quiso
 * cargar un pedido. La app le dijo "no tiene precio cargado en la lista elegida" y le marcó los
 * renglones en rojo: le hizo creer que el problema era suyo, y la salida obvia era cambiar de
 * lista. No faltaba ningún precio: InfoManager no estaba contestando.
 */
describe('cuando InfoManager no contesta el precio', () => {
  const PEDIDO = [{ cod_articulo: 995, cantidad: 6, cod_lista: 14 }, { cod_articulo: 140, cantidad: 5, cod_lista: 14 }];

  it('🔴 dice que es InfoManager, no que falta el precio, y no marca renglones', async () => {
    im.getPrecioLista.mockRejectedValue(new Error('InfoManager pidió una pausa hasta las 11:36. No se consultó de nuevo.'));
    const r = await crear(PEDIDO);
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/InfoManager/);
    expect(r.body.error).toMatch(/11:36/);
    expect(r.body.error).not.toMatch(/no tiene precio/i);
    expect(r.body.sin_precio).toBeUndefined();
    expect(r.body.bloqueado).toBeUndefined();
    expect(insertado).toBeNull();
    expect(im.crearPresupuesto).not.toHaveBeenCalled();
  });

  it('corta en el primero: no le sigue preguntando a un InfoManager que no contesta', async () => {
    im.getPrecioLista.mockRejectedValue(new Error('timeout of 25000ms exceeded'));
    await crear(PEDIDO);
    expect(im.getPrecioLista).toHaveBeenCalledTimes(1);
  });

  it('un artículo que de verdad no está en la lista sigue frenando como antes', async () => {
    im.getPrecioLista.mockResolvedValue(null);
    const r = await crear(PEDIDO);
    expect(r.status).toBe(422);
    expect(r.body.bloqueado).toBe(true);
    expect(r.body.error).toMatch(/no tiene precio cargado/);
  });
});
