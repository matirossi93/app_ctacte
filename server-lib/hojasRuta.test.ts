import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Los guardas del panel de hojas de ruta. Lo que se testea acá es lo que, si falla, manda
 * mercadería al camión equivocado o le deja el panel de la oficina a quien no corresponde.
 */

vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });

const m = vi.hoisted(() => ({
  sbMock: vi.fn(),
  getDisponibleCliente: vi.fn(),
  comprobantesPendientesCliente: vi.fn(),
}));

vi.mock('./infomanager.js', () => ({
  fetchVentas: vi.fn(), fetchVentasItems: vi.fn(), fetchArticulosCatalogo: vi.fn(),
  fetchClientesIMCached: vi.fn(), getDisponibleCliente: m.getDisponibleCliente,
  comprobantesPendientesCliente: m.comprobantesPendientesCliente,
  fechaArgentina: () => '2026-09-07',
}));
vi.mock('./supabase.js', () => ({ sb: m.sbMock, TENANT_ID: 'test-tenant', hasSupabase: () => true }));

const { crearHoja, asignarPedidos, listarCamiones } = await import('./hojasRuta.js');

let tablas: Record<string, any> = {};
let insertados: Array<[string, any]> = [];

function fakeSb() {
  m.sbMock.mockImplementation(() => ({
    from: (t: string) => {
      const res = tablas[t] ?? { data: null, error: null };
      const q: any = {
        then: (r: any, j: any) => Promise.resolve(res).then(r, j),
        maybeSingle: () => Promise.resolve(res),
        insert: (v: any) => { insertados.push([t, v]); return q; },
        upsert: (v: any) => { insertados.push([t, v]); return q; },
        delete: () => q,
      };
      for (const k of ['select', 'eq', 'in', 'order', 'limit', 'not', 'or']) q[k] = () => q;
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

beforeEach(() => {
  tablas = {}; insertados = [];
  vi.clearAllMocks();
  fakeSb();
  m.getDisponibleCliente.mockResolvedValue({ saldo: 12345.67 });
  // La deuda sale de los comprobantes impagos: 12.000 + 345,67 = 12.345,67.
  m.comprobantesPendientesCliente.mockResolvedValue([
    { id: 'fa-vieja', tipo_comprobante: 'FA', saldo: 12000, numero: '1', punto_de_venta: '777', fecha: '2026-09-01' },
    { id: 'fa-vieja-2', tipo_comprobante: 'FA', saldo: 345.67, numero: '2', punto_de_venta: '777', fecha: '2026-09-02' },
  ]);
});

describe('quién entra al panel', () => {
  it('🔴 un VENDEDOR no arma hojas de ruta', async () => {
    // Vería y podría mover los pedidos de todo el equipo.
    const r = await llamar(listarCamiones, { rol: 'vendedor' });
    expect(r.status).toBe(403);
  });

  it('🔴 administrativo SÍ: es el rol de Jorgelina, el panel se hace para ella', async () => {
    tablas['hojas_ruta_camiones'] = { data: [{ nombre: 'Camión 5.000', capacidad_kg: 5000 }], error: null };
    const r = await llamar(listarCamiones, { rol: 'administrativo' });
    expect(r.status).toBe(200);
    expect(r.body.camiones).toHaveLength(1);
  });

  it('admin y gerente también', async () => {
    tablas['hojas_ruta_camiones'] = { data: [], error: null };
    for (const rol of ['admin', 'gerente']) {
      expect((await llamar(listarCamiones, { rol })).status).toBe(200);
    }
  });
});

describe('asignar pedidos a una hoja', () => {
  const PEDIDO = { im_comprobante_id: '58700637', im_numero: 58050, cod_cliente: 1093, bultos: 10, kg: 250 };

  it('🔴 un comprobante que YA está en otra hoja se rechaza', async () => {
    // Si entrara en dos hojas, la mercadería se cargaría en dos camiones.
    tablas['hojas_ruta'] = { data: { id: 'h1', numero: 3395, estado: 'abierta' }, error: null };
    tablas['hojas_ruta_pedidos'] = { data: [{ im_comprobante_id: '58700637', hoja_id: 'OTRA', im_numero: 58050 }], error: null };

    const r = await llamar(asignarPedidos, { params: { id: 'h1' }, body: { pedidos: [PEDIDO] } });

    expect(r.status).toBe(409);
    expect(r.body.error).toContain('58050');
    expect(insertados).toHaveLength(0);   // no se tocó nada
  });

  it('🔴 guarda el SALDO del cliente como snapshot', async () => {
    // Es justo el dato que hoy escriben a mano en la hoja impresa.
    tablas['hojas_ruta'] = { data: { id: 'h1', numero: 3395, estado: 'abierta' }, error: null };
    tablas['hojas_ruta_pedidos'] = { data: [], error: null };

    const r = await llamar(asignarPedidos, { params: { id: 'h1' }, body: { pedidos: [PEDIDO] } });

    expect(r.status).toBe(200);
    const fila = insertados.find(([t]) => t === 'hojas_ruta_pedidos')![1][0];
    expect(fila.saldo_anterior).toBe(12345.67);
    expect(fila.kg).toBe(250);
    expect(fila.im_comprobante_id).toBe('58700637');
  });

  it('🔴 si no se pudo traer el saldo, se guarda vacío y se avisa — no se inventa un 0', async () => {
    // Un cero dice "no debe nada" y el repartidor no le reclama. En blanco dice "fijate".
    tablas['hojas_ruta'] = { data: { id: 'h1', numero: 3395, estado: 'abierta' }, error: null };
    tablas['hojas_ruta_pedidos'] = { data: [], error: null };
    m.comprobantesPendientesCliente.mockRejectedValue(new Error('IM caído'));

    const r = await llamar(asignarPedidos, { params: { id: 'h1' }, body: { pedidos: [PEDIDO] } });

    const fila = insertados.find(([t]) => t === 'hojas_ruta_pedidos')![1][0];
    expect(fila.saldo_anterior).toBeNull();
    expect(r.body.sin_saldo).toBe(1);
  });

  it('🔴 a una hoja CERRADA no se le agregan pedidos', async () => {
    tablas['hojas_ruta'] = { data: { id: 'h1', numero: 3395, estado: 'cerrada' }, error: null };
    const r = await llamar(asignarPedidos, { params: { id: 'h1' }, body: { pedidos: [PEDIDO] } });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/cerrada/);
  });

  it('una hoja que no existe da 404, no un 500', async () => {
    tablas['hojas_ruta'] = { data: null, error: null };
    const r = await llamar(asignarPedidos, { params: { id: 'nope' }, body: { pedidos: [PEDIDO] } });
    expect(r.status).toBe(404);
  });
});

describe('crear hoja', () => {
  it('🔴 el número sigue al último, para que se parezca al de IM', async () => {
    // La oficina habla de "la 3409". Si nuestro número no se parece, hay que traducir.
    tablas['hojas_ruta'] = { data: { numero: 3408 }, error: null };
    await llamar(crearHoja, { body: { fecha: '2026-09-08', turno: 'Mañana' } });
    const fila = insertados.find(([t]) => t === 'hojas_ruta')![1];
    expect(fila.numero).toBe(3409);
    expect(fila.turno).toBe('Mañana');
  });

  /**
   * 🔑 Mati (10/09/2026): *"al nº de hoja de ruta deberíamos subirle 2 números"*. La serie del
   * panel quedó atrás de la de IM, así que hay un piso que la empuja una sola vez. El detalle de
   * ese cálculo se prueba en `numeroHojaRuta.test.ts`; acá sólo que `crearHoja` lo respete.
   */
  it('🔴 una serie que quedó atrás salta hasta alcanzar a la de IM', async () => {
    tablas['hojas_ruta'] = { data: { numero: 3399 }, error: null };
    await llamar(crearHoja, { body: { fecha: '2026-09-11' } });
    expect(insertados.find(([t]) => t === 'hojas_ruta')![1].numero).toBe(3405);
  });

  it('🔴 la PRIMERA hoja no arranca en 1: sigue la numeración de IM', async () => {
    // Con la tabla vacía, un `0 + 1` arrancaría una numeración paralela a la de InfoManager y
    // la oficina tendría que llevar dos.
    tablas['hojas_ruta'] = { data: null, error: null };
    await llamar(crearHoja, { body: { fecha: '2026-09-08' } });
    const fila = insertados.find(([t]) => t === 'hojas_ruta')![1];
    expect(fila.numero).toBe(3405);
  });

  it('🔴 número repetido: 409 que se entiende, no un 500', async () => {
    tablas['hojas_ruta'] = { data: null, error: { code: '23505', message: 'duplicate key' } };
    const r = await llamar(crearHoja, { body: { numero: 3394 } });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('3394');
  });
});
