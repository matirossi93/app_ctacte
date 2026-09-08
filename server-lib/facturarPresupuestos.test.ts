import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ETAPA 2: facturar los presupuestos aprobados. Es lo ÚNICO irreversible del panel — consume
 * numeración fiscal, toca la cuenta corriente y el remito descuenta stock.
 *
 * Lo que se prueba acá es que NUNCA emita dos veces lo mismo, que no facture nada sin aprobar,
 * y que sepa decir de antemano qué va a salir. El payload que se le manda a IM se prueba en
 * `facturarIM.test.ts`.
 */

vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });

const m = vi.hoisted(() => ({
  sbMock: vi.fn(),
  vistaDeRango: vi.fn(),
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
  cabeceraComprobante: m.cabeceraComprobante,
  desconfirmarPresupuesto: m.desconfirmarPresupuesto,
  fechaArgentina: () => '2026-09-08',
}));
// `letraDeFactura` va de VERDAD: es la regla fiscal.
vi.mock('./facturarIM.js', async (original) => ({
  ...(await original<any>()),
  emitirFactura: m.emitirFactura,
  emitirRemito: m.emitirRemito,
  proximoNumeroFactura: m.proximoNumeroFactura,
}));
vi.mock('./pedidos.js', () => ({ usuarioIM: vi.fn(async () => 'jorgelina') }));
vi.mock('./vistaPresupuestos.js', () => ({ vistaDeRango: m.vistaDeRango, invalidarVista: vi.fn() }));
vi.mock('./supabase.js', () => ({ sb: m.sbMock, TENANT_ID: 'test-tenant', hasSupabase: () => true }));

const { facturarSeleccion, previsualizarFacturacion, tableroFacturacion } = await import('./facturarPresupuestos.js');

let tablas: Record<string, any> = {};
let escrituras: Array<{ tabla: string; op: string; valor: any }> = [];

function fakeSb() {
  m.sbMock.mockImplementation(() => ({
    from: (t: string) => {
      const res = tablas[t] ?? { data: null, error: null };
      const q: any = {
        then: (r: any, j: any) => Promise.resolve(res).then(r, j),
        maybeSingle: () => Promise.resolve(res),
        upsert: (v: any) => { escrituras.push({ tabla: t, op: 'upsert', valor: v }); return q; },
        update: (v: any) => { escrituras.push({ tabla: t, op: 'update', valor: v }); return q; },
        delete: () => { escrituras.push({ tabla: t, op: 'delete', valor: null }); return q; },
      };
      for (const k of ['select', 'eq', 'in', 'order', 'limit', 'is']) q[k] = () => q;
      return q;
    },
  }));
}

function llamar(fn: any, { rol = 'administrativo', body = {}, query = {}, method = 'POST' } = {}) {
  let status = 200; let out: any;
  const req: any = { user: { rol, sub: 'u1' }, params: {}, body, query, method };
  const res: any = { status: (s: number) => { status = s; return res; }, json: (b: any) => { out = b; } };
  return fn(req, res).then(() => ({ status, body: out }));
}

/** Un presupuesto como lo devuelve la vista, ya aprobado en la etapa 1. */
function presu(over: Record<string, any> = {}) {
  return {
    im_comprobante_id: '10', im_numero: 58050, cod_cliente: 1093, cliente_nombre: 'ARON, Jorge',
    fecha: '2026-09-08', total: 29771.58, bultos: 12, kg: 480,
    revision: { estado: 'aprobado', observacion: null, revisado_at: 'x' },
    ...over,
  };
}
const VISTA_BASE = { asignados: [], con_avisos: 0, pierde_margen: 0, cobra_de_mas: 0, sin_zona: 0, de_otros_dias: 0, sin_revisar: 0, aprobados: 1, observados: 0, sin_stock: 0, con_cantidad_rara: 0 };
const RENGLON = { id_comprobante: '10', cod_articulo: 661, cantidad: 1, precio: 29771.58, iva_por: 0, cod_vendedor: 2, cod_lista_precios: 13 };

beforeEach(() => {
  tablas = {}; escrituras = [];
  vi.clearAllMocks();
  fakeSb();
  m.vistaDeRango.mockResolvedValue({ ...VISTA_BASE, pendientes: [presu()] });
  m.fetchClientesIMCached.mockResolvedValue([
    { cod_cliente: 1093, categoria_iva: 'CF' },
    { cod_cliente: 500, categoria_iva: 'RI' },
    { cod_cliente: 777, categoria_iva: null },
  ]);
  m.cabeceraComprobante.mockResolvedValue({ fecha: '2026-09-08', anulada: false, existe: true });
  m.fetchVentasItems.mockResolvedValue([RENGLON]);
  m.proximoNumeroFactura.mockResolvedValue(50360);
  m.emitirFactura.mockResolvedValue({ ok: true, id: 'f1', numero: 50360, tipo: 'FA B' });
  m.emitirRemito.mockResolvedValue({ ok: true, id: 'r1', numero: 77291, tipo: 'RE' });
  m.desconfirmarPresupuesto.mockResolvedValue({ ok: true });
  tablas['presupuestos_facturados'] = { data: [], error: null };
});

describe('sólo se factura lo aprobado', () => {
  it('🔴 un presupuesto SIN aprobar frena toda la emisión', async () => {
    // Facturar sin revisar es justo lo que este panel vino a evitar.
    m.vistaDeRango.mockResolvedValue({ ...VISTA_BASE, pendientes: [presu({ revision: null })] });
    const r = await llamar(facturarSeleccion, { body: { ids: ['10'] } });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/no están aprobados|58050/);
    expect(m.emitirFactura).not.toHaveBeenCalled();
  });

  it('🔴 uno observado tampoco pasa', async () => {
    m.vistaDeRango.mockResolvedValue({ ...VISTA_BASE, pendientes: [presu({ revision: { estado: 'observado', observacion: 'falta stock' } })] });
    const r = await llamar(facturarSeleccion, { body: { ids: ['10'] } });
    expect(r.status).toBe(409);
    expect(m.emitirFactura).not.toHaveBeenCalled();
  });

  it('aprobado sí: sale factura y remito', async () => {
    const r = await llamar(facturarSeleccion, { body: { ids: ['10'] } });
    expect(r.status).toBe(200);
    expect(m.emitirFactura).toHaveBeenCalledTimes(1);
    expect(m.emitirRemito).toHaveBeenCalledTimes(1);
    expect(r.body.hechos[0]).toMatchObject({ factura: 50360, remito: 77291 });
  });
});

describe('previsualizar', () => {
  it('🔴 dice qué sale y con qué letra, sin emitir ni escribir nada', async () => {
    m.vistaDeRango.mockResolvedValue({
      ...VISTA_BASE,
      pendientes: [presu(), presu({ im_comprobante_id: '20', im_numero: 58051, cod_cliente: 500, total: 100000 })],
    });
    m.fetchVentasItems.mockResolvedValue([RENGLON, { ...RENGLON, id_comprobante: '20' }]);

    const r = await llamar(previsualizarFacturacion, { method: 'GET', query: { ids: '10,20' } });

    expect(r.body.a_emitir).toMatchObject({ facturas: 2, remitos: 2, letras: { A: 1, B: 1 } });
    expect(r.body.a_emitir.total).toBeCloseTo(129771.58, 2);
    expect(m.emitirFactura).not.toHaveBeenCalled();
    expect(escrituras).toHaveLength(0);
  });

  it('🔴 el cliente sin condición de IVA sale como no facturable, con el motivo', async () => {
    m.vistaDeRango.mockResolvedValue({ ...VISTA_BASE, pendientes: [presu({ cod_cliente: 777 })] });
    const r = await llamar(previsualizarFacturacion, { method: 'GET', query: { ids: '10' } });
    expect(r.body.pedidos[0].estado).toBe('no_se_puede');
    expect(r.body.pedidos[0].motivo).toMatch(/IVA|letra/i);
    expect(r.body.a_emitir.facturas).toBe(0);
  });

  it('🔴 un presupuesto anulado en IM no se factura', async () => {
    m.cabeceraComprobante.mockResolvedValue({ fecha: '2026-09-08', anulada: true, existe: true });
    const r = await llamar(previsualizarFacturacion, { method: 'GET', query: { ids: '10' } });
    expect(r.body.pedidos[0].estado).toBe('no_se_puede');
    expect(r.body.pedidos[0].motivo).toMatch(/anulad/i);
  });

  it('sin ids elegidos contesta 400, no un 500', async () => {
    expect((await llamar(previsualizarFacturacion, { method: 'GET', query: {} })).status).toBe(400);
  });
});

describe('no emitir dos veces lo mismo', () => {
  it('🔴 con la factura ya emitida hace SÓLO el remito', async () => {
    // El caso real: la factura salió y el remito falló. Reintentar emitiendo las dos le factura
    // dos veces al cliente y consume otro número fiscal.
    tablas['presupuestos_facturados'] = {
      data: [{ im_comprobante_id: '10', im_factura_id: 'f1', im_factura_numero: 50360, facturado_at: null }],
      error: null,
    };
    const r = await llamar(facturarSeleccion, { body: { ids: ['10'] } });
    expect(m.emitirFactura).not.toHaveBeenCalled();
    expect(m.emitirRemito).toHaveBeenCalledTimes(1);
    expect(r.body.facturados).toBe(1);
  });

  it('🔴 lo ya facturado del todo no se vuelve a tocar', async () => {
    tablas['presupuestos_facturados'] = {
      data: [{ im_comprobante_id: '10', im_factura_id: 'f1', im_factura_numero: 50360, im_remito_id: 'r1', facturado_at: '2026-09-08T12:00:00Z' }],
      error: null,
    };
    const r = await llamar(facturarSeleccion, { body: { ids: ['10'] } });
    expect(r.status).toBe(409);
    expect(m.emitirFactura).not.toHaveBeenCalled();
    expect(m.emitirRemito).not.toHaveBeenCalled();
  });

  it('🔴 la factura se guarda apenas se emite, antes de intentar el remito', async () => {
    m.emitirRemito.mockResolvedValue({ ok: false, error: 'IM rechazó el remito' });
    const r = await llamar(facturarSeleccion, { body: { ids: ['10'] } });
    const guardadas = escrituras.filter(e => e.tabla === 'presupuestos_facturados');
    expect(guardadas[0].valor).toMatchObject({ im_factura_id: 'f1', im_factura_numero: 50360 });
    expect(guardadas.some(g => g.valor.facturado_at)).toBe(false);   // sin remito no está facturado
    expect(r.body.fallados[0]).toMatch(/remito/i);
  });

  it('🔴 si IM no contesta, se frena el resto de la tanda', async () => {
    m.vistaDeRango.mockResolvedValue({
      ...VISTA_BASE,
      pendientes: [presu(), presu({ im_comprobante_id: '20', cod_cliente: 500 })],
    });
    m.fetchVentasItems.mockResolvedValue([RENGLON, { ...RENGLON, id_comprobante: '20' }]);
    m.emitirFactura.mockResolvedValueOnce({ ok: false, error: 'timeout', sinRespuesta: true });

    const r = await llamar(facturarSeleccion, { body: { ids: ['10', '20'] } });

    expect(m.emitirFactura).toHaveBeenCalledTimes(1);
    expect(r.body.cortado).toMatch(/no contestó/i);
    expect(r.body.ok).toBe(false);
  });

  it('🔴 el pedido de OTRO DÍA se factura igual: los renglones van por su fecha real', async () => {
    m.cabeceraComprobante.mockResolvedValue({ fecha: '2026-09-04', anulada: false, existe: true });
    m.fetchVentasItems.mockImplementation(async (d: string) => (d === '2026-09-04' ? [RENGLON] : []));
    const r = await llamar(facturarSeleccion, { body: { ids: ['10'], desde: '2026-09-01', hasta: '2026-09-08' } });
    expect(r.body.fallados).toHaveLength(0);
    expect(m.fetchVentasItems).toHaveBeenCalledWith('2026-09-04', '2026-09-04');
  });
});

describe('el tablero de la etapa 2', () => {
  it('🔴 muestra sólo lo aprobado, y avisa cuántos quedan sin aprobar', async () => {
    m.vistaDeRango.mockResolvedValue({
      ...VISTA_BASE,
      pendientes: [presu(), presu({ im_comprobante_id: '20', revision: null })],
    });
    const r = await llamar(tableroFacturacion, { method: 'GET', query: {} });
    expect(r.body.pendientes).toHaveLength(1);
    expect(r.body.sin_aprobar).toBe(1);
  });

  it('🔴 separa lo que sólo espera el remito', async () => {
    tablas['presupuestos_facturados'] = {
      data: [{ im_comprobante_id: '10', im_factura_id: 'f1', im_factura_numero: 50360, facturado_at: null }],
      error: null,
    };
    const r = await llamar(tableroFacturacion, { method: 'GET', query: {} });
    expect(r.body.pendientes[0].falta_remito).toBe(true);
    expect(r.body.totales.falta_remito).toBe(1);
  });

  it('🔴 un vendedor no entra', async () => {
    expect((await llamar(tableroFacturacion, { rol: 'vendedor', method: 'GET' })).status).toBe(403);
  });
});
