import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Lo que ya se emitió no se borra de la hoja de ruta.
 *
 * La fila es el único registro de qué comprobante salió de qué presupuesto —facturar por API no
 * deja ese vínculo en InfoManager—, así que sacarla habilita una segunda factura al mismo
 * cliente. La facturación en sí se prueba en `facturarPresupuestos.test.ts`.
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

const { quitarPedido, borrarHoja } = await import('./hojasRuta.js');

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
      for (const k of ['select', 'eq', 'in', 'order', 'limit', 'not', 'is']) q[k] = () => q;
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

describe('lo emitido no se puede borrar de la hoja', () => {
  it('🔴 sacar de la hoja un pedido ya facturado se rechaza', async () => {
    // La fila es el ÚNICO registro de qué factura salió de qué presupuesto: facturar por API no
    // deja el vínculo en IM. Borrarla es perder el rastro y habilitar una segunda factura.
    tablas['hojas_ruta_pedidos'] = {
      data: { id: 'p1', im_factura_numero: 50360, facturado_at: '2026-09-08T12:00:00Z', hoja_id: 'h1' },
      error: null,
    };

    const r = await llamar(quitarPedido, { params: { comprobanteId: '58700637' } });

    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/50360/);
    expect(escrituras.some(e => e.op === 'delete')).toBe(false);
  });

  it('🔴 borrar una hoja con comprobantes emitidos se rechaza', async () => {
    tablas['hojas_ruta_pedidos'] = { data: [{ id: 'p1', im_factura_numero: 50360, facturado_at: 'x' }], error: null };

    const r = await llamar(borrarHoja, { params: { id: 'h1' } });

    expect(r.status).toBe(409);
    expect(escrituras.some(e => e.op === 'delete')).toBe(false);
  });

  it('una hoja sin facturar se borra normal', async () => {
    tablas['hojas_ruta_pedidos'] = { data: [{ id: 'p1', facturado_at: null, im_factura_numero: null }], error: null };
    const r = await llamar(borrarHoja, { params: { id: 'h1' } });
    expect(r.status).toBe(200);
  });
});
