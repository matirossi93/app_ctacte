import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Facturar una hoja es lo ÚNICO irreversible del panel: consume numeración fiscal, toca la
 * cuenta corriente del cliente y el remito descuenta stock. Lo que se prueba acá es que el
 * botón NUNCA emita dos veces lo mismo, que sepa decir de antemano qué va a salir, y que lo
 * ya emitido no se pueda borrar de la hoja (perder el vínculo = alguien lo vuelve a facturar).
 *
 * Complementa `facturarIM.test.ts`, que cubre el payload que se le manda a IM.
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

const { facturarHoja, previsualizarFacturacion, quitarPedido, borrarHoja } = await import('./hojasRuta.js');

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

describe('previsualizar qué se va a emitir', () => {
  it('🔴 dice comprobante por comprobante qué sale, ANTES de tocar nada', async () => {
    // Es el requisito de la pantalla: se confirma sabiendo exactamente qué se emite.
    tablas['hojas_ruta'] = hojaCon([
      ped(), ped({ id: 'p2', im_comprobante_id: '58700638', im_numero: 58051, cod_cliente: 500, total: 100000 }),
    ]);
    itemsDelDia({ '2026-09-08': [RENGLON, { ...RENGLON, id_comprobante: '58700638' }] });

    const r = await llamar(previsualizarFacturacion, { params: { id: 'h1' } });

    expect(r.status).toBe(200);
    expect(r.body.a_emitir.facturas).toBe(2);
    expect(r.body.a_emitir.remitos).toBe(2);
    expect(r.body.a_emitir.total).toBeCloseTo(129771.58, 2);
    expect(r.body.pedidos[0]).toMatchObject({ cliente_nombre: 'ARON, Jorge', letra: 'B', estado: 'listo' });
    expect(r.body.pedidos[1]).toMatchObject({ letra: 'A', estado: 'listo' });
    // Previsualizar NO emite ni escribe nada.
    expect(m.emitirFactura).not.toHaveBeenCalled();
    expect(escrituras).toHaveLength(0);
  });

  it('🔴 el cliente sin condición de IVA aparece como NO facturable, con el motivo', async () => {
    // Emitir la letra equivocada es un problema impositivo: se avisa antes, no a mitad de camino.
    tablas['hojas_ruta'] = hojaCon([ped({ cod_cliente: 777 })]);

    const r = await llamar(previsualizarFacturacion, { params: { id: 'h1' } });

    expect(r.body.pedidos[0].estado).toBe('no_se_puede');
    expect(r.body.pedidos[0].motivo).toMatch(/condición de IVA|letra/i);
    expect(r.body.a_emitir.facturas).toBe(0);
  });

  it('🔴 lo YA facturado se muestra emitido y no se vuelve a ofrecer', async () => {
    tablas['hojas_ruta'] = hojaCon([
      ped({ im_factura_numero: 50360, im_remito_numero: 77291, facturado_at: '2026-09-08T12:00:00Z' }),
    ]);

    const r = await llamar(previsualizarFacturacion, { params: { id: 'h1' } });

    expect(r.body.pedidos[0]).toMatchObject({ estado: 'facturado', im_factura_numero: 50360, im_remito_numero: 77291 });
    expect(r.body.a_emitir.facturas).toBe(0);
  });

  it('🔴 con la factura emitida y el remito no, avisa que SÓLO falta el remito', async () => {
    // Es el estado peligroso: si se lo tratara como "sin facturar", el reintento factura de nuevo.
    tablas['hojas_ruta'] = hojaCon([ped({ im_factura_id: 'f1', im_factura_numero: 50360 })]);

    const r = await llamar(previsualizarFacturacion, { params: { id: 'h1' } });

    expect(r.body.pedidos[0].estado).toBe('falta_remito');
    expect(r.body.a_emitir.facturas).toBe(0);   // la factura ya salió
    expect(r.body.a_emitir.remitos).toBe(1);
  });

  it('🔴 un presupuesto ANULADO en IM no se factura', async () => {
    m.cabeceraComprobante.mockResolvedValue({ fecha: '2026-09-08', anulada: true, existe: true });
    tablas['hojas_ruta'] = hojaCon([ped()]);

    const r = await llamar(previsualizarFacturacion, { params: { id: 'h1' } });

    expect(r.body.pedidos[0].estado).toBe('no_se_puede');
    expect(r.body.pedidos[0].motivo).toMatch(/anulad/i);
  });
});

describe('facturar', () => {
  it('🔴 NO vuelve a emitir la factura de un pedido que ya la tiene: sólo el remito', async () => {
    // El caso real: la factura salió y el remito falló. Un reintento que emitiera las dos le
    // factura DOS VECES al cliente y consume otro número fiscal.
    tablas['hojas_ruta'] = hojaCon([ped({ im_factura_id: 'f1', im_factura_numero: 50360 })]);
    tablas['hojas_ruta_pedidos'] = { data: [], error: null };

    const r = await llamar(facturarHoja, { params: { id: 'h1' } });

    expect(m.emitirFactura).not.toHaveBeenCalled();
    expect(m.emitirRemito).toHaveBeenCalledTimes(1);
    expect(r.body.facturados).toBe(1);
  });

  it('🔴 un pedido de OTRO DÍA se factura igual: los renglones se buscan por su fecha real', async () => {
    // La hoja lleva pedidos arrastrados (el 07/09 había 417 vigentes de días anteriores). Si
    // los renglones se buscaran sólo en la fecha de la hoja, esos pedidos no se podrían facturar.
    tablas['hojas_ruta'] = hojaCon([ped()], { fecha: '2026-09-08' });
    tablas['hojas_ruta_pedidos'] = { data: [], error: null };
    m.cabeceraComprobante.mockResolvedValue({ fecha: '2026-09-04', anulada: false, existe: true });
    itemsDelDia({ '2026-09-04': [RENGLON] });          // el día de la hoja no tiene nada

    const r = await llamar(facturarHoja, { params: { id: 'h1' } });

    expect(r.body.fallados).toHaveLength(0);
    expect(m.emitirFactura).toHaveBeenCalledTimes(1);
    expect(r.body.hechos[0]).toMatchObject({ factura: 50360, remito: 77291 });
  });

  it('🔴 con pedidos de muchos días distintos igual se traen todos los renglones', async () => {
    // Con más de 6 días sueltos se pide el rango entero en vez de truncar la lista: un día que
    // no se consulta se ve igual que un pedido sin renglones y no se factura nunca.
    const filas = ['04', '03', '02', '01', '08', '07', '06', '05'].map((d, i) => ped({
      id: `p${i}`, im_comprobante_id: `5870000${i}`, im_numero: 58000 + i,
    }));
    tablas['hojas_ruta'] = hojaCon(filas);
    tablas['hojas_ruta_pedidos'] = { data: [], error: null };
    m.cabeceraComprobante.mockImplementation(async (id: string) => ({
      fecha: `2026-09-0${['04', '03', '02', '01', '08', '07', '06', '05'][Number(String(id).slice(-1))].slice(1)}`,
      anulada: false, existe: true,
    }));
    m.fetchVentasItems.mockResolvedValue(filas.map(f => ({ ...RENGLON, id_comprobante: f.im_comprobante_id })));

    const r = await llamar(facturarHoja, { params: { id: 'h1' } });

    // Una sola consulta, del día más viejo al más nuevo, y ningún pedido sin renglones.
    expect(m.fetchVentasItems).toHaveBeenCalledTimes(1);
    expect(m.fetchVentasItems).toHaveBeenCalledWith('2026-09-01', '2026-09-08');
    expect(r.body.fallados).toHaveLength(0);
    expect(m.emitirFactura).toHaveBeenCalledTimes(8);
  });

  it('🔴 si IM no contesta, se frena la hoja entera', async () => {
    // No se sabe si la factura salió: seguir sería arriesgarse a facturar dos veces al resto.
    tablas['hojas_ruta'] = hojaCon([
      ped(), ped({ id: 'p2', im_comprobante_id: '58700638', cod_cliente: 500 }),
    ]);
    tablas['hojas_ruta_pedidos'] = { data: [{ id: 'p2' }], error: null };
    itemsDelDia({ '2026-09-08': [RENGLON, { ...RENGLON, id_comprobante: '58700638' }] });
    m.emitirFactura.mockResolvedValueOnce({ ok: false, error: 'timeout', sinRespuesta: true });

    const r = await llamar(facturarHoja, { params: { id: 'h1' } });

    expect(m.emitirFactura).toHaveBeenCalledTimes(1);       // no siguió con el segundo
    expect(r.body.cortado).toMatch(/no contestó/i);
    expect(r.body.ok).toBe(false);
  });

  it('🔴 la factura se guarda apenas se emite, antes de intentar el remito', async () => {
    // Un comprobante emitido que no quedó registrado es un comprobante que se vuelve a emitir.
    tablas['hojas_ruta'] = hojaCon([ped()]);
    tablas['hojas_ruta_pedidos'] = { data: [], error: null };
    m.emitirRemito.mockResolvedValue({ ok: false, error: 'IM rechazó el remito' });

    const r = await llamar(facturarHoja, { params: { id: 'h1' } });

    const guardadas = escrituras.filter(e => e.tabla === 'hojas_ruta_pedidos' && e.op === 'update');
    expect(guardadas[0].valor).toMatchObject({ im_factura_id: 'f1', im_factura_numero: 50360 });
    expect(guardadas.some(g => g.valor.facturado_at)).toBe(false);   // sin remito no está facturado
    expect(r.body.fallados[0]).toMatch(/remito/i);
  });

  it('el cliente sin condición de IVA se saltea y los demás se facturan', async () => {
    tablas['hojas_ruta'] = hojaCon([
      ped({ cod_cliente: 777 }),
      ped({ id: 'p2', im_comprobante_id: '58700638', cod_cliente: 500 }),
    ]);
    tablas['hojas_ruta_pedidos'] = { data: [{ id: 'p1' }], error: null };
    itemsDelDia({ '2026-09-08': [RENGLON, { ...RENGLON, id_comprobante: '58700638' }] });

    const r = await llamar(facturarHoja, { params: { id: 'h1' } });

    expect(m.emitirFactura).toHaveBeenCalledTimes(1);
    expect(r.body.facturados).toBe(1);
    expect(r.body.fallados[0]).toMatch(/IVA|letra/i);
  });
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
