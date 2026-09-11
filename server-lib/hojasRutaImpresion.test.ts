import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Qué sale impreso en la cabecera de la hoja de ruta.
 *
 * 🔑 Mati (08/09/2026): *"es el mismo dato: chofer y transportista"*. Desde que la hoja tiene un
 * chofer asignado —que es a quien se le liquida—, ese nombre es el que tiene que salir impreso.
 * El campo viejo `transporte` era texto libre y sigue existiendo para las hojas cargadas antes y
 * para un flete de una sola vez que no está en la lista.
 */

vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });

const m = vi.hoisted(() => ({ sbMock: vi.fn(), fetchVentasItems: vi.fn(async () => []) }));

vi.mock('./infomanager.js', () => ({
  // El cache de /ventas se limpia junto con las vistas (10/09/2026).
  invalidarCacheVentas: vi.fn(),
  invalidarCacheItems: vi.fn(),
  fetchVentas: vi.fn(async () => []),
  fetchVentasItems: m.fetchVentasItems,
  fetchArticulosCatalogo: vi.fn(async () => new Map()),
  fetchClientesIMCached: vi.fn(async () => new Map()),
  getDisponibleCliente: vi.fn(async () => ({ saldo: 0 })),
  cabeceraComprobante: vi.fn(),
  desconfirmarPresupuesto: vi.fn(),
  fechaArgentina: () => '2026-09-08',
}));
vi.mock('./pedidos.js', () => ({ usuarioIM: vi.fn(async () => 'jorgelina') }));
vi.mock('./supabase.js', () => ({ sb: m.sbMock, TENANT_ID: 'test-tenant', hasSupabase: () => true }));

const { impresionHoja } = await import('./hojasRuta.js');

let hojaDevuelta: any = null;
/** Lo que devuelve `presupuestos_facturados`: el cruce vivo que hace la impresión. */
let facturadosDevueltos: any[] = [];

function fakeSb() {
  m.sbMock.mockImplementation(() => ({
    // Cada tabla devuelve lo suyo: `presupuestos_facturados` es una LISTA, y devolverle el objeto
    // de la hoja hacía que el cruce vivo del impreso reventara al recorrerlo.
    from: (tabla: string) => {
      const res = tabla === 'hojas_ruta'
        ? { data: hojaDevuelta, error: null }
        : { data: tabla === 'presupuestos_facturados' ? facturadosDevueltos : [], error: null };
      const q: any = { then: (r: any, j: any) => Promise.resolve(res).then(r, j), maybeSingle: () => Promise.resolve(res) };
      for (const k of ['range','order','select', 'eq', 'in', 'order', 'limit', 'not', 'is', 'or']) q[k] = () => q;
      return q;
    },
  }));
}

function llamar() {
  let status = 200; let out: any;
  const req: any = { user: { rol: 'administrativo', sub: 'u1' }, params: { id: 'h1' }, body: {}, query: {} };
  const res: any = { status: (s: number) => { status = s; return res; }, json: (b: any) => { out = b; } };
  return impresionHoja(req, res).then(() => ({ status, body: out }));
}

function hoja(over: Record<string, any> = {}) {
  return {
    id: 'h1', numero: 3395, fecha: '2026-09-08', estado: 'abierta',
    turno: 'Mañana', transporte: null, chofer_id: null, choferes: null,
    hojas_ruta_camiones: { nombre: 'Camión 1', capacidad_kg: 5000 },
    hojas_ruta_pedidos: [{
      im_comprobante_id: '58700637', im_numero: 58050, cod_cliente: 1093,
      cliente_nombre: 'ARON, Jorge', total: 29771.58, bultos: 2, kg: 60, orden: 0,
      saldo_anterior: 0, im_remito_numero: 7001, facturado_at: '2026-09-08T10:00:00Z',
    }],
    ...over,
  };
}

beforeEach(() => { hojaDevuelta = null; facturadosDevueltos = []; vi.clearAllMocks(); fakeSb(); });

describe('cabecera impresa de la hoja', () => {
  it('🔴 imprime el CHOFER asignado como transporte: es el mismo dato', async () => {
    hojaDevuelta = hoja({ chofer_id: 'c-nino', choferes: { nombre: 'NIÑO' } });
    const r = await llamar();
    expect(r.body.hoja.transporte).toBe('NIÑO');
    expect(r.body.hoja.chofer).toBe('NIÑO');
  });

  it('🔴 el chofer le gana al texto viejo: si no, saldría impreso otro nombre que el que cobra', async () => {
    hojaDevuelta = hoja({ chofer_id: 'c-nino', choferes: { nombre: 'NIÑO' }, transporte: 'FLETE PEPE' });
    const r = await llamar();
    expect(r.body.hoja.transporte).toBe('NIÑO');
  });

  it('sin chofer asignado sigue saliendo el transporte cargado a mano (hojas viejas)', async () => {
    hojaDevuelta = hoja({ transporte: 'FLETE PEPE' });
    const r = await llamar();
    expect(r.body.hoja.transporte).toBe('FLETE PEPE');
    expect(r.body.hoja.chofer).toBeNull();
  });

  it('🔴 el remito sale del cruce VIVO: una hoja armada antes de facturar no puede imprimir el presupuesto', async () => {
    // Se armó la hoja con el presupuesto y se facturó después: el snapshot quedó sin remito.
    hojaDevuelta = hoja({
      hojas_ruta_pedidos: [{
        im_comprobante_id: '58700637', im_numero: 58050, cod_cliente: 1093, cliente_nombre: 'ARON',
        total: 1000, bultos: 1, kg: 30, orden: 0, saldo_anterior: 0,
        im_remito_numero: null, facturado_at: null,
      }],
    });
    facturadosDevueltos = [{
      im_comprobante_id: '58700637', cod_cliente:1093, im_remito_id: '58800100', im_remito_numero: 77289,
      im_factura_numero: 50358, facturado_at: '2026-09-08T12:00:00Z',
    }];
    const r = await llamar();
    expect(r.body.clientes[0].comprobantes[0]).toMatchObject({ im_remito_numero: 77289, facturado: true });
  });

  it('sin chofer ni transporte va en blanco, no rompe', async () => {
    hojaDevuelta = hoja();
    const r = await llamar();
    expect(r.status).toBe(200);
    expect(r.body.hoja.transporte).toBeNull();
  });
});
