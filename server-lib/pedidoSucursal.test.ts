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
  crearPresupuesto: im.crearPresupuesto,
  fetchClientesIMCached: im.fetchClientesIMCached,
  fetchArticulosDeDeposito: im.fetchArticulosDeDeposito,
  fetchArticulosCatalogo: im.fetchArticulosCatalogo,
  getPrecioLista: im.getPrecioLista,
  fetchVendedores: im.fetchVendedores,
  anularComprobante: vi.fn(), getDisponibleCliente: vi.fn(), getItemsComprobante: vi.fn(),
  presupuestoFacturado: vi.fn(), actualizarPresupuestoCantidades: vi.fn(),
  cabeceraComprobante: vi.fn(), fechaComprobante: vi.fn(),
  fechaArgentina: () => '2026-08-28', fetchPreciosDeLista: vi.fn(),
}));
vi.mock('./supabase.js', () => ({ sb: im.sbMock, TENANT_ID: 't', hasSupabase: () => true }));

const { crearPedido, catalogoPedido } = await import('./pedidos.js');
// Vive en su propio módulo porque la config del usuario la necesitan pedidos Y clientes.
const { sucursalDelUsuario } = await import('./perfilUsuario.js');

/**
 * Cada unidad presupuesta con SUS códigos de InfoManager. Un número mal acá crea el
 * presupuesto en la empresa equivocada, o en un punto de venta que no puede emitirlo, y no se
 * nota hasta que lo va a facturar otra persona.
 *
 * 🔑 La unidad sale del USUARIO, no del body: el vendedor de una sucursal no elige en qué
 * empresa factura.
 */

/** Fila de `usuarios` que devuelve el fake de Supabase. */
let filaUsuario: any = { im_usuario: null, cod_empresa: null };
/** Lo insertado en pedidos_vendedor. */
let insertado: any = null;

function fakeSb() {
  im.sbMock.mockImplementation(() => ({
    from: (t: string) => {
      const q: any = {
        then: (r: any, j: any) => Promise.resolve({ data: t === 'usuarios' ? filaUsuario : [], error: null }).then(r, j),
        maybeSingle: () => Promise.resolve({ data: t === 'usuarios' ? filaUsuario : null, error: null }),
        insert: (v: any) => { if (t === 'pedidos_vendedor') insertado = Array.isArray(v) ? v[0] : v; return q; },
        update: () => q, delete: () => q,
      };
      for (const m of ['select', 'eq', 'order', 'limit', 'in']) q[m] = () => q;
      q.select = () => q;
      return q;
    },
  }));
}

const USER = { sub: 'u1', rol: 'vendedor', cod_vendedor: 2, nombre: 'Sebastián' } as any;

beforeEach(() => {
  filaUsuario = { im_usuario: 'sebastian', cod_empresa: null };
  insertado = null;
  for (const f of Object.values(im)) (f as any).mockReset?.();
  fakeSb();
  im.fetchClientesIMCached.mockResolvedValue([{ cod_cliente: 500, razon_social: 'CLIENTE X', lista_precio: 12, cod_vendedor: 2 }]);
  im.fetchArticulosCatalogo.mockResolvedValue(new Map([[400, { descripcion: 'ALPISTE', unidad_de_medida: 'Kilos', equivalencia_um: 1 }]]));
  im.getPrecioLista.mockResolvedValue({ precio_vta: 1000, iva: 0, descripcion: 'ALPISTE' });
  im.fetchVendedores.mockResolvedValue([]);
  im.crearPresupuesto.mockResolvedValue({ ok: true, id: '999', numero: 1234, raw: {} });
  im.fetchArticulosDeDeposito.mockResolvedValue(new Set([400]));
});

/** POST /api/pedidos y devuelve lo que se le mandó a crearPresupuesto. */
async function crear() {
  const req: any = { body: { cod_cliente: 500, items: [{ cod_articulo: 400, cantidad: 2, cod_lista: 12 }] }, user: USER, on: () => {} };
  const res: any = { status: () => res, json: () => {} };
  await crearPedido(req, res);
  return im.crearPresupuesto.mock.calls[0]?.[0];
}

describe('la unidad del usuario decide con qué códigos se presupuesta', () => {
  it('sin unidad cargada sigue siendo casa central (empresa 1, punto de venta 1)', async () => {
    // Los usuarios que ya existen tienen cod_empresa NULL: no se les puede mover el piso.
    const payload = await crear();
    expect(payload.cod_empresa).toBe(1);
    expect(payload.punto_de_venta).toBe(1);
  });

  it('🔴 un usuario de BRS presupuesta en la empresa 2 y por el punto de venta 14', async () => {
    filaUsuario = { im_usuario: 'sebastian', cod_empresa: 2 };
    const payload = await crear();
    expect(payload.cod_empresa).toBe(2);
    expect(payload.punto_de_venta).toBe(14);
    // Y queda guardado para poder anularlo después: el anular manda el punto de venta.
    expect(insertado?.im_punto_de_venta).toBe(14);
  });

  it('🔴 Jujuy va por la empresa 4 y el 888, que es su único punto de venta que presupuesta', async () => {
    filaUsuario = { im_usuario: 'brian', cod_empresa: 4 };
    const payload = await crear();
    expect(payload.cod_empresa).toBe(4);
    expect(payload.punto_de_venta).toBe(888);
  });

  it('🪤 una empresa inventada no crea el pedido en el aire: cae en casa central', async () => {
    // El 6 es el DEPÓSITO de Jujuy, no una empresa. La lista blanca vieja lo dejaba pasar.
    filaUsuario = { im_usuario: 'x', cod_empresa: 6 };
    const payload = await crear();
    expect(payload.cod_empresa).toBe(1);
  });

  it('el body NO puede elegir la empresa: la pone quien carga', async () => {
    filaUsuario = { im_usuario: 'sebastian', cod_empresa: 2 };
    const req: any = { body: { cod_cliente: 500, cod_empresa: 1, items: [{ cod_articulo: 400, cantidad: 2, cod_lista: 12 }] }, user: USER, on: () => {} };
    const res: any = { status: () => res, json: () => {} };
    await crearPedido(req, res);
    expect(im.crearPresupuesto.mock.calls[0][0].cod_empresa).toBe(2);
  });
});

describe('el buscador se acota al depósito de la unidad', () => {
  it('🔴 BRS busca en el depósito 2, no en el 1 de casa central', async () => {
    filaUsuario = { im_usuario: 'sebastian', cod_empresa: 2 };
    const req: any = { query: { q: 'alp' }, user: USER };
    const res: any = { status: () => res, json: () => {} };
    await catalogoPedido(req, res);
    expect(im.fetchArticulosDeDeposito).toHaveBeenCalledWith(2);
  });

  it('🔴 Jujuy busca en el 6: la empresa y el depósito NO son el mismo número', async () => {
    filaUsuario = { im_usuario: 'brian', cod_empresa: 4 };
    const req: any = { query: { q: 'alp' }, user: USER };
    const res: any = { status: () => res, json: () => {} };
    await catalogoPedido(req, res);
    expect(im.fetchArticulosDeDeposito).toHaveBeenCalledWith(6);
  });
});

describe('sucursalDelUsuario', () => {
  it('devuelve los códigos completos de la unidad', async () => {
    filaUsuario = { im_usuario: null, cod_empresa: 3 };
    expect(await sucursalDelUsuario({ sub: 'u1' })).toEqual({
      cod_empresa: 3, nombre: 'San Juan', cod_deposito: 3, punto_de_venta: 14,
    });
  });
});
