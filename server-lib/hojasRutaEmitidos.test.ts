import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Qué se puede tocar de una hoja de ruta y qué no.
 *
 * 🔄 La regla cambió con el circuito nuevo (08/09/2026): lo facturado ya no vive en la hoja sino
 * en `presupuestos_facturados`, así que sacar un pedido de una hoja abierta no pierde ningún
 * rastro. Lo que no se toca es una hoja CERRADA: ésa ya volvió del reparto y es la base de la
 * liquidación del chofer. La facturación se prueba en `facturarPresupuestos.test.ts`.
 */

vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });

const m = vi.hoisted(() => ({
  sbMock: vi.fn(),
  cabeceraComprobante: vi.fn(),
  fetchVentasItems: vi.fn(),
  fetchClientesIMCached: vi.fn(),
  desconfirmarPresupuesto: vi.fn(),
  emitirFactura: vi.fn(),
  emitirRemito: vi.fn(),
  proximoNumeroFactura: vi.fn(),
}));

vi.mock('./infomanager.js', () => ({
  fetchVentas: vi.fn(async () => []),
  fetchVentasItems: m.fetchVentasItems,
  fetchArticulosCatalogo: vi.fn(async () => new Map()),
  fetchClientesIMCached: m.fetchClientesIMCached,
  getDisponibleCliente: vi.fn(async () => ({ saldo: 0 })),
  cabeceraComprobante: m.cabeceraComprobante,
  desconfirmarPresupuesto: m.desconfirmarPresupuesto,
  fechaArgentina: () => '2026-09-08',
}));
// `letraDeFactura` va de VERDAD: es la regla fiscal, mockearla sería testear el mock.
vi.mock('./facturarIM.js', async (original) => ({
  ...(await original<any>()),
  emitirFactura: m.emitirFactura,
  emitirRemito: m.emitirRemito,
  proximoNumeroFactura: m.proximoNumeroFactura,
}));
vi.mock('./pedidos.js', () => ({ usuarioIM: vi.fn(async () => 'jorgelina') }));
vi.mock('./supabase.js', () => ({ sb: m.sbMock, TENANT_ID: 'test-tenant', hasSupabase: () => true }));

const { quitarPedido, borrarHoja, asignarPedidos } = await import('./hojasRuta.js');

let tablas: Record<string, any> = {};
let escrituras: Array<{ tabla: string; op: string; valor: any }> = [];

function fakeSb() {
  m.sbMock.mockImplementation(() => ({
    from: (t: string) => {
      const res = tablas[t] ?? { data: null, error: null };
      const q: any = {
        then: (r: any, j: any) => Promise.resolve(res).then(r, j),
        maybeSingle: () => Promise.resolve(res),
        insert: (v: any) => { escrituras.push({ tabla: t, op: 'insert', valor: v }); return q; },
        upsert: (v: any) => { escrituras.push({ tabla: t, op: 'upsert', valor: v }); return q; },
        update: (v: any) => { escrituras.push({ tabla: t, op: 'update', valor: v }); return q; },
        delete: () => { escrituras.push({ tabla: t, op: 'delete', valor: null }); return q; },
      };
      for (const k of ['select', 'eq', 'in', 'order', 'limit', 'not', 'is', 'or']) q[k] = () => q;
      return q;
    },
  }));
}

function llamar(fn: any, { rol = 'administrativo', params = {}, body = {}, query = {} } = {}) {
  let status = 200; let out: any;
  const req: any = { user: { rol, sub: 'u1' }, params, body, query };
  const res: any = { status: (s: number) => { status = s; return res; }, json: (b: any) => { out = b; } };
  return fn(req, res).then(() => ({ status, body: out }));
}

/** Una fila de `hojas_ruta_pedidos` con lo mínimo que mira la facturación. */
function ped(over: Record<string, any> = {}) {
  return {
    id: 'p1', im_comprobante_id: '58700637', im_numero: 58050, cod_cliente: 1093,
    cliente_nombre: 'ARON, Jorge', total: 29771.58, orden: 0, pedido_id: null,
    im_factura_id: null, im_factura_numero: null, im_remito_id: null, im_remito_numero: null,
    facturado_at: null, ...over,
  };
}
function hojaCon(pedidos: any[], over: Record<string, any> = {}) {
  return {
    data: {
      id: 'h1', numero: 3395, fecha: '2026-09-08', cod_empresa: 1, estado: 'abierta',
      hojas_ruta_pedidos: pedidos, ...over,
    },
    error: null,
  };
}
/** Los renglones que devuelve IM para un comprobante, por día. */
function itemsDelDia(porDia: Record<string, any[]>) {
  m.fetchVentasItems.mockImplementation(async (desde: string) => porDia[desde] ?? []);
}
const RENGLON = {
  id_comprobante: '58700637', cod_articulo: 661, cantidad: 1, precio: 29771.58,
  iva_por: 0, cod_vendedor: 2, cod_lista_precios: 13,
};

beforeEach(() => {
  tablas = {}; escrituras = [];
  vi.clearAllMocks();
  fakeSb();
  m.fetchClientesIMCached.mockResolvedValue([
    { cod_cliente: 1093, categoria_iva: 'CF', nombre: 'ARON, Jorge' },
    { cod_cliente: 500, categoria_iva: 'RI', nombre: 'MORELLI SRL' },
    { cod_cliente: 777, categoria_iva: null, nombre: 'SIN CATEGORIA' },
  ]);
  m.cabeceraComprobante.mockResolvedValue({ fecha: '2026-09-08', anulada: false, existe: true });
  itemsDelDia({ '2026-09-08': [RENGLON] });
  m.proximoNumeroFactura.mockResolvedValue(50360);
  m.emitirFactura.mockResolvedValue({ ok: true, id: 'f1', numero: 50360, tipo: 'FA B' });
  m.emitirRemito.mockResolvedValue({ ok: true, id: 'r1', numero: 77291, tipo: 'RE' });
  m.desconfirmarPresupuesto.mockResolvedValue({ ok: true });
});

describe('una hoja cerrada no se toca', () => {
  it('🔴 no se saca un pedido de una hoja cerrada: ya se liquidó', async () => {
    // Cerrar la hoja es decir "esto se entregó", y de ahí sale el pago del chofer.
    tablas['hojas_ruta_pedidos'] = {
      data: { hoja_id: 'h1', im_numero: 58050, hojas_ruta: { numero: 3395, estado: 'cerrada' } },
      error: null,
    };

    const r = await llamar(quitarPedido, { params: { comprobanteId: '58700637' } });

    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/cerrada/i);
    expect(escrituras.some(e => e.op === 'delete')).toBe(false);
  });

  it('🔴 de una hoja ABIERTA sí se saca, aunque el pedido ya esté facturado', async () => {
    // 🔄 Antes esto se bloqueaba, porque la fila de la hoja era el único registro de qué
    // factura salió de qué presupuesto. Desde que eso vive en `presupuestos_facturados`, sacar
    // el pedido no pierde nada — y con el guard viejo la hoja quedaba inutilizable, porque en
    // el circuito nuevo TODO lo que entra a una hoja está facturado.
    tablas['hojas_ruta_pedidos'] = {
      data: { hoja_id: 'h1', im_numero: 58050, hojas_ruta: { numero: 3395, estado: 'abierta' } },
      error: null,
    };

    const r = await llamar(quitarPedido, { params: { comprobanteId: '58700637' } });

    expect(r.status).toBe(200);
    expect(escrituras.some(e => e.op === 'delete')).toBe(true);
  });

  it('🔴 una hoja cerrada tampoco se borra', async () => {
    tablas['hojas_ruta'] = { data: { numero: 3395, estado: 'cerrada' }, error: null };
    const r = await llamar(borrarHoja, { params: { id: 'h1' } });
    expect(r.status).toBe(409);
    expect(escrituras.some(e => e.op === 'delete')).toBe(false);
  });

  it('una hoja abierta se borra normal, y lo facturado sigue registrado aparte', async () => {
    tablas['hojas_ruta'] = { data: { numero: 3396, estado: 'abierta' }, error: null };
    const r = await llamar(borrarHoja, { params: { id: 'h1' } });
    expect(r.status).toBe(200);
    // Se borran las filas de la hoja, nunca `presupuestos_facturados`.
    expect(escrituras.filter(e => e.tabla === 'presupuestos_facturados')).toHaveLength(0);
  });

  it('una hoja que no existe da 404', async () => {
    tablas['hojas_ruta'] = { data: null, error: null };
    expect((await llamar(borrarHoja, { params: { id: 'nope' } })).status).toBe(404);
  });
});

/** Agujeros que encontró la verificación adversarial: los guards fallaban abiertos. */
describe('los guards no pueden fallar abiertos', () => {
  it('🔴 si no se puede consultar el estado de la hoja, NO se saca el pedido', async () => {
    // Antes, un error de consulta dejaba `fila` en null, la hoja parecía abierta y se borraba
    // el pedido de una hoja ya liquidada.
    tablas['hojas_ruta_pedidos'] = { data: null, error: { message: 'timeout' } };
    const r = await llamar(quitarPedido, { params: { comprobanteId: '58700637' } });
    expect(r.status).toBe(502);
    expect(escrituras.some(e => e.op === 'delete')).toBe(false);
  });

  it('🔴 mover un pedido tampoco lo saca de una hoja CERRADA', async () => {
    // `mover: true` reasigna la fila sin pasar por quitarPedido, que era donde estaba el guard.
    tablas['hojas_ruta'] = { data: { id: 'h2', numero: 3396, estado: 'abierta' }, error: null };
    tablas['hojas_ruta_pedidos'] = {
      data: [{ im_comprobante_id: '58700637', hoja_id: 'h1', im_numero: 58050, hojas_ruta: { numero: 3395, estado: 'cerrada' } }],
      error: null,
    };

    const r = await llamar(asignarPedidos, {
      params: { id: 'h2' },
      body: { pedidos: [{ im_comprobante_id: '58700637', cod_cliente: 1 }], mover: true },
    });

    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/cerrada/i);
    expect(escrituras.some(e => e.op === 'upsert')).toBe(false);
  });

  it('🔴 y si no se puede consultar dónde están, no se asigna nada', async () => {
    tablas['hojas_ruta'] = { data: { id: 'h2', numero: 3396, estado: 'abierta' }, error: null };
    tablas['hojas_ruta_pedidos'] = { data: null, error: { message: 'timeout' } };
    const r = await llamar(asignarPedidos, {
      params: { id: 'h2' }, body: { pedidos: [{ im_comprobante_id: '1', cod_cliente: 1 }] },
    });
    expect(r.status).toBe(502);
    expect(escrituras.some(e => e.op === 'upsert')).toBe(false);
  });
});

describe('las notas de crédito atan el pedido a su hoja', () => {
  it('🔴 un pedido con NC emitida no se saca de la hoja', async () => {
    // El descuento quedaría colgado de una hoja que ya no lleva ese pedido.
    tablas['hojas_ruta_pedidos'] = {
      data: { hoja_id: 'h1', im_numero: 58050, hojas_ruta: { numero: 3395, estado: 'abierta' } },
      error: null,
    };
    tablas['hojas_ruta_ajustes'] = { data: [{ im_ajuste_numero: 29800 }], error: null };

    const r = await llamar(quitarPedido, { params: { comprobanteId: '58700637' } });

    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/29800/);
    expect(escrituras.some(e => e.op === 'delete')).toBe(false);
  });

  it('🔴 ni se borra una hoja con notas de crédito emitidas: el cascade se las llevaría', async () => {
    tablas['hojas_ruta'] = { data: { numero: 3395, estado: 'abierta' }, error: null };
    tablas['hojas_ruta_ajustes'] = { data: [{ im_ajuste_numero: 29800 }], error: null };
    const r = await llamar(borrarHoja, { params: { id: 'h1' } });
    expect(r.status).toBe(409);
    expect(escrituras.some(e => e.op === 'delete')).toBe(false);
  });
});
