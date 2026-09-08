import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Los agujeros que encontró la auditoría del 08/09/2026 sobre la etapa 3.
 *
 * Cada test de acá es un camino REAL por el que se le pagaba mal a un chofer o se cargaba en el
 * camión mercadería que el cliente venía a buscar. Todos fallaban antes del arreglo.
 */

vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });

const m = vi.hoisted(() => ({
  sbMock: vi.fn(),
  fetchVentasItems: vi.fn(async () => []),
  cabeceraComprobante: vi.fn(),
}));

vi.mock('./infomanager.js', () => ({
  fetchVentas: vi.fn(async () => []),
  fetchVentasItems: m.fetchVentasItems,
  fetchArticulosCatalogo: vi.fn(async () => new Map()),
  fetchClientesIMCached: vi.fn(async () => new Map()),
  getDisponibleCliente: vi.fn(async () => ({ saldo: 0 })),
  cabeceraComprobante: m.cabeceraComprobante,
  desconfirmarPresupuesto: vi.fn(),
  imClient: vi.fn(),
  fechaArgentina: () => '2026-09-08',
}));
vi.mock('./pedidos.js', () => ({ usuarioIM: vi.fn(async () => 'jorgelina') }));
vi.mock('./supabase.js', () => ({ sb: m.sbMock, TENANT_ID: 'test-tenant', hasSupabase: () => true }));

const { borrarAjuste } = await import('./ajustesEntrega.js');
const { editarHoja, asignarPedidos } = await import('./hojasRuta.js');
const { quitarRetiro, listarRetiros } = await import('./retirosSucursal.js');

/**
 * Un Supabase de mentira que registra qué filtros se aplicaron. Hace falta mirar los filtros
 * porque varios de estos bugs son "el DELETE nunca matchea" o "la consulta no se hace".
 */
let tablas: Record<string, any> = {};
let escrituras: Array<{ tabla: string; op: string; valor: any; filtros: string[] }> = [];
let lecturas: string[] = [];

function fakeSb() {
  m.sbMock.mockImplementation(() => ({
    from: (t: string) => {
      lecturas.push(t);
      const res = tablas[t] ?? { data: null, error: null };
      const filtros: string[] = [];
      const q: any = {
        then: (r: any, j: any) => Promise.resolve(res).then(r, j),
        maybeSingle: () => Promise.resolve(res),
        insert: (v: any) => { escrituras.push({ tabla: t, op: 'insert', valor: v, filtros }); return q; },
        upsert: (v: any) => { escrituras.push({ tabla: t, op: 'upsert', valor: v, filtros }); return q; },
        update: (v: any) => { escrituras.push({ tabla: t, op: 'update', valor: v, filtros }); return q; },
        delete: () => { escrituras.push({ tabla: t, op: 'delete', valor: null, filtros }); return q; },
      };
      for (const k of ['select', 'eq', 'in', 'gte', 'lte', 'order', 'limit', 'not']) {
        q[k] = (...a: any[]) => { filtros.push(`${k}:${a.join(',')}`); return q; };
      }
      q.is = (col: string, v: any) => { filtros.push(`is:${col},${v}`); return q; };
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

beforeEach(() => { tablas = {}; escrituras = []; lecturas = []; vi.clearAllMocks(); fakeSb(); });

// ─────────────────────────────────────────────────────────────────────────────
describe('desvincular una nota de crédito', () => {
  /**
   * 🔴 Como `vincularAjuste` escribe `emitido_at` en el mismo insert, el DELETE que filtraba
   * `emitido_at is null` no matcheaba NUNCA. Una nota vinculada por error bajaba el importe de
   * la hoja —y el pago del chofer— para siempre, y encima dejaba el pedido preso en esa hoja.
   */
  it('🔴 una nota VINCULADA se puede soltar: la nota sigue viva en InfoManager', async () => {
    tablas['hojas_ruta_ajustes'] = {
      data: { id: 'aj1', items: [], im_ajuste_numero: 30061, emitido_at: '2026-09-08T15:00:00Z' },
      error: null,
    };
    const r = await llamar(borrarAjuste, { params: { id: 'aj1' } });
    expect(r.status).toBe(200);
    expect(escrituras.find(e => e.op === 'delete')).toBeTruthy();
  });

  it('🔴 una nota EMITIDA desde el panel no se borra: es el único registro de a qué factura corresponde', async () => {
    // La emite `crearAjuste`, que exige renglones: `items` con contenido = la emitimos nosotros.
    tablas['hojas_ruta_ajustes'] = {
      data: { id: 'aj2', items: [{ cod_articulo: 1, cantidad: 2, precio: 100 }], im_ajuste_numero: 30062, emitido_at: '2026-09-08T15:00:00Z' },
      error: null,
    };
    const r = await llamar(borrarAjuste, { params: { id: 'aj2' } });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/anular/i);
    expect(escrituras.find(e => e.op === 'delete')).toBeFalsy();
  });

  it('un ajuste que no existe da 404, no un 200 mudo', async () => {
    tablas['hojas_ruta_ajustes'] = { data: null, error: null };
    const r = await llamar(borrarAjuste, { params: { id: 'nada' } });
    expect(r.status).toBe(404);
  });

  it('🔴 si no se puede leer el ajuste, NO se borra a ciegas', async () => {
    tablas['hojas_ruta_ajustes'] = { data: null, error: { message: 'timeout' } };
    const r = await llamar(borrarAjuste, { params: { id: 'aj1' } });
    expect(r.status).toBe(502);
    expect(escrituras.find(e => e.op === 'delete')).toBeFalsy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('un pedido está en UNA hoja o en retiro, nunca en las dos', () => {
  /**
   * 🔴 `marcarRetiro` ya frenaba "está en una hoja → no lo marco". Faltaba el espejo: nada
   * impedía meter en una hoja algo que el cliente pasa a buscar. El importe terminaba contado
   * dos veces (en el acumulado de retiros y en la liquidación del chofer) y el camión cargaba
   * mercadería que el cliente ya se había llevado.
   */
  it('🔴 no se puede mandar a una hoja un pedido marcado como retiro en sucursal', async () => {
    tablas['hojas_ruta'] = { data: { id: 'h1', numero: 3395, fecha: '2026-09-08', estado: 'abierta' }, error: null };
    tablas['retiros_sucursal'] = { data: [{ im_comprobante_id: '58700637', im_numero: 58050 }], error: null };
    const r = await llamar(asignarPedidos, {
      params: { id: 'h1' },
      body: { pedidos: [{ im_comprobante_id: '58700637', im_numero: 58050, cod_cliente: 1093, total: 1000 }] },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/retir/i);
    expect(escrituras.find(e => e.tabla === 'hojas_ruta_pedidos')).toBeFalsy();
  });

  it('🔴 si no se puede consultar retiros, no se asigna: fallar abierto los pondría en los dos lados', async () => {
    tablas['hojas_ruta'] = { data: { id: 'h1', numero: 3395, fecha: '2026-09-08', estado: 'abierta' }, error: null };
    tablas['retiros_sucursal'] = { data: null, error: { message: 'timeout' } };
    const r = await llamar(asignarPedidos, {
      params: { id: 'h1' },
      body: { pedidos: [{ im_comprobante_id: '58700637', im_numero: 58050, cod_cliente: 1093, total: 1000 }] },
    });
    expect(r.status).toBe(502);
    expect(escrituras.find(e => e.tabla === 'hojas_ruta_pedidos')).toBeFalsy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('una hoja cerrada no se edita', () => {
  /**
   * 🔴 Era el último guard de "cerrada" que faltaba en el server. Cambiarle el chofer a una hoja
   * ya liquidada mueve el importe ENTERO de un chofer a otro, sin dejar rastro.
   */
  it('🔴 no se le cambia el chofer a una hoja cerrada', async () => {
    tablas['hojas_ruta'] = { data: { id: 'h1', numero: 3395, estado: 'cerrada' }, error: null };
    const r = await llamar(editarHoja, { params: { id: 'h1' }, body: { chofer_id: 'ch-otro' } });
    expect(r.status).toBe(409);
    expect(escrituras.find(e => e.op === 'update')).toBeFalsy();
  });

  it('🔴 tampoco el camión, el turno ni la zona', async () => {
    tablas['hojas_ruta'] = { data: { id: 'h1', numero: 3395, estado: 'cerrada' }, error: null };
    for (const cambio of [{ camion_id: 'c9' }, { turno: 'Tarde' }, { cod_zona: 3 }, { observaciones: 'x' }]) {
      const r = await llamar(editarHoja, { params: { id: 'h1' }, body: cambio });
      expect(r.status).toBe(409);
    }
    expect(escrituras.find(e => e.op === 'update')).toBeFalsy();
  });

  it('🔑 pero SÍ se puede reabrir: si no, quedaría trabada para siempre', async () => {
    tablas['hojas_ruta'] = { data: { id: 'h1', numero: 3395, estado: 'cerrada' }, error: null };
    const r = await llamar(editarHoja, { params: { id: 'h1' }, body: { estado: 'abierta' } });
    expect(r.status).toBe(200);
    const upd = escrituras.find(e => e.op === 'update');
    expect(upd?.valor).toMatchObject({ estado: 'abierta', cerrada_at: null });
  });

  it('una hoja abierta se edita normalmente', async () => {
    tablas['hojas_ruta'] = { data: { id: 'h1', numero: 3395, estado: 'abierta' }, error: null };
    const r = await llamar(editarHoja, { params: { id: 'h1' }, body: { chofer_id: 'ch-nino' } });
    expect(r.status).toBe(200);
  });

  it('🔴 si no se puede leer el estado de la hoja, no se edita a ciegas', async () => {
    tablas['hojas_ruta'] = { data: null, error: { message: 'timeout' } };
    const r = await llamar(editarHoja, { params: { id: 'h1' }, body: { chofer_id: 'ch-nino' } });
    expect(r.status).toBe(502);
    expect(escrituras.find(e => e.op === 'update')).toBeFalsy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('retiros en sucursal', () => {
  it('🔴 si no se puede leer el retiro, no se borra: podría ser uno que el cliente ya se llevó', async () => {
    tablas['retiros_sucursal'] = { data: null, error: { message: 'timeout' } };
    const r = await llamar(quitarRetiro, { params: { comprobanteId: '58700637' } });
    expect(r.status).toBe(502);
    expect(escrituras.find(e => e.op === 'delete')).toBeFalsy();
  });

  it('🔴 la factura y el remito salen de la fuente VIVA, no del snapshot de cuando se marcó', async () => {
    // Se marca como retiro antes de facturar y se factura después: el remito tiene que aparecer.
    tablas['retiros_sucursal'] = {
      data: [{ im_comprobante_id: '58700637', cod_cliente: 1093, fecha: '2026-09-08', total: 1000, im_factura_numero: null, im_remito_numero: null }],
      error: null,
    };
    tablas['presupuestos_facturados'] = {
      data: [{ im_comprobante_id: '58700637', im_factura_numero: 50380, im_remito_numero: 77310, facturado_at: '2026-09-08T12:00:00Z' }],
      error: null,
    };
    const r = await llamar(listarRetiros, { query: { desde: '2026-09-01', hasta: '2026-09-30' } });
    expect(r.body.retiros[0]).toMatchObject({ im_factura_numero: 50380, im_remito_numero: 77310 });
  });
});
