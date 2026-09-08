import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Las notas de crédito por lo que no se entregó. Emitir una es IRREVERSIBLE —consume numeración
 * fiscal y baja la cuenta corriente del cliente— y además define el número final de la hoja, que
 * es la base del pago al chofer. Se prueba que no se acredite de más y que no se emita dos veces.
 */

vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });

const m = vi.hoisted(() => ({
  sbMock: vi.fn(),
  emitirNotaCredito: vi.fn(),
  fetchVentasItems: vi.fn(),
  fetchClientesIMCached: vi.fn(),
  cabeceraComprobante: vi.fn(),
  fetchVentas: vi.fn(),
  imClient: vi.fn(),
}));

vi.mock('./infomanager.js', () => ({
  fetchClientesIMCached: m.fetchClientesIMCached,
  fetchVentasItems: m.fetchVentasItems,
  cabeceraComprobante: m.cabeceraComprobante,
  fetchVentas: m.fetchVentas,
  imClient: m.imClient,
  fechaArgentina: () => '2026-09-08',
}));
vi.mock('./facturarIM.js', () => ({ emitirNotaCredito: m.emitirNotaCredito }));
vi.mock('./pedidos.js', () => ({ usuarioIM: vi.fn(async () => 'jorgelina') }));
vi.mock('./supabase.js', () => ({ sb: m.sbMock, TENANT_ID: 'test-tenant', hasSupabase: () => true }));

const { crearAjuste, listarAjustes, borrarAjuste, totalesConAjustes, candidatasAVincular, vincularAjuste } = await import('./ajustesEntrega.js');

let tablas: Record<string, any> = {};
let escrituras: Array<{ tabla: string; op: string; valor: any }> = [];

function fakeSb() {
  m.sbMock.mockImplementation(() => ({
    from: (t: string) => {
      const res = tablas[t] ?? { data: null, error: null };
      const q: any = {
        then: (r: any, j: any) => Promise.resolve(res).then(r, j),
        maybeSingle: () => Promise.resolve(res),
        insert: (v: any) => { escrituras.push({ tabla: t, op: 'insert', valor: v }); return { ...q, maybeSingle: () => Promise.resolve({ data: { id: 'aj1', ...v }, error: null }) }; },
        update: (v: any) => { escrituras.push({ tabla: t, op: 'update', valor: v }); return q; },
        delete: () => { escrituras.push({ tabla: t, op: 'delete', valor: null }); return q; },
      };
      for (const k of ['select', 'eq', 'in', 'is', 'not', 'order', 'limit']) q[k] = () => q;
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

const HOJA = {
  id: 'h1', numero: 3395, fecha: '2026-09-08', estado: 'abierta', cod_empresa: 1,
  hojas_ruta_pedidos: [
    { im_comprobante_id: '10', cod_cliente: 1093, cliente_nombre: 'ARON, Jorge', total: 100000, facturado_at: '2026-09-08T12:00:00Z', im_factura_numero: 50360 },
    { im_comprobante_id: '20', cod_cliente: 500, cliente_nombre: 'MORELLI', total: 50000, facturado_at: '2026-09-08T12:00:00Z', im_factura_numero: 50361 },
  ],
};
/** Una nota de crédito como la devuelve `GET /ventas/{id}`. */
const NC_EN_IM = {
  id: 'nc-99', tipo_comprobante: 'NC', tipo_factura: 'B', numero: 30058,
  cod_cliente: 1093, total: 20000, anulada: 'N', observaciones: 'NO PIDIO SEGUN HR 3395',
};
const RENGLONES = [
  { id_comprobante: '10', cod_articulo: 661, cantidad: 10, precio: 5000, iva_por: 0, cod_vendedor: 2, cod_lista_precios: 13 },
];

beforeEach(() => {
  tablas = {}; escrituras = [];
  vi.clearAllMocks();
  fakeSb();
  tablas['hojas_ruta'] = { data: HOJA, error: null };
  tablas['hojas_ruta_ajustes'] = { data: [], error: null };
  tablas['presupuestos_facturados'] = { data: { cod_empresa: 1, im_factura_numero: 50360 }, error: null };
  m.cabeceraComprobante.mockResolvedValue({ fecha: '2026-09-08', anulada: false, existe: true });
  m.fetchVentasItems.mockResolvedValue(RENGLONES);
  m.fetchClientesIMCached.mockResolvedValue([{ cod_cliente: 1093, categoria_iva: 'CF' }]);
  m.emitirNotaCredito.mockResolvedValue({ ok: true, id: 'nc1', numero: 29800, tipo: 'NC B' });
  m.fetchVentas.mockResolvedValue([]);
  m.imClient.mockResolvedValue({ get: vi.fn(async () => ({ data: NC_EN_IM })) });
});

describe('cargar una diferencia (con la emisión habilitada)', () => {
  // 🔑 Hoy el interruptor está APAGADO porque IM rechaza las NC del punto 777. Estos tests
  // cubren el camino de emisión para el día que Sistec arregle la validación.
  beforeEach(() => { process.env.IM_NC_EMISION_HABILITADA = '1'; });
  afterEach(() => { delete process.env.IM_NC_EMISION_HABILITADA; });

  it('🔴 emite la NC y la deja registrada con su número', async () => {
    const r = await llamar(crearAjuste, {
      params: { id: 'h1' },
      body: { im_comprobante_id: '10', motivo: 'NO PIDIO', items: [{ cod_articulo: 661, cantidad: 4 }] },
    });
    expect(r.status).toBe(200);
    expect(r.body.ajuste).toMatchObject({ importe: 20000, numero: 29800 });
    const upd = escrituras.find(e => e.op === 'update')!.valor;
    expect(upd).toMatchObject({ im_ajuste_numero: 29800, im_ajuste_id: 'nc1' });
    expect(upd.emitido_at).toBeTruthy();
  });

  it('🔴 la fila se escribe ANTES de emitir: dos personas no emiten la misma NC', async () => {
    await llamar(crearAjuste, {
      params: { id: 'h1' },
      body: { im_comprobante_id: '10', motivo: 'SIN STOCK', items: [{ cod_articulo: 661, cantidad: 1 }] },
    });
    expect(escrituras[0].op).toBe('insert');
    expect(m.emitirNotaCredito).toHaveBeenCalled();
  });

  it('🔴 NO se puede acreditar más de lo que se entregó', async () => {
    // Un error de tipeo dejaría al cliente con saldo a favor de la nada.
    const r = await llamar(crearAjuste, {
      params: { id: 'h1' },
      body: { im_comprobante_id: '10', motivo: 'NO PIDIO', items: [{ cod_articulo: 661, cantidad: 11 }] },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/se entregaron 10/);
    expect(m.emitirNotaCredito).not.toHaveBeenCalled();
  });

  it('🔴 tampoco un artículo que no estaba en el pedido', async () => {
    const r = await llamar(crearAjuste, {
      params: { id: 'h1' },
      body: { im_comprobante_id: '10', motivo: 'NO PIDIO', items: [{ cod_articulo: 999, cantidad: 1 }] },
    });
    expect(r.status).toBe(409);
    expect(m.emitirNotaCredito).not.toHaveBeenCalled();
  });

  it('🔴 el precio sale del comprobante original, no de lo que mande la pantalla', async () => {
    // La NC devuelve lo que se COBRÓ. Si el precio viniera del body, se podría acreditar de más.
    await llamar(crearAjuste, {
      params: { id: 'h1' },
      body: { im_comprobante_id: '10', motivo: 'CERRADO', items: [{ cod_articulo: 661, cantidad: 2, precio: 999999 }] },
    });
    const enviado = m.emitirNotaCredito.mock.calls[0][0];
    expect(enviado.items[0].precio).toBe(5000);
    expect(enviado.total).toBe(10000);
  });

  it('🔴 la observación lleva la referencia a la hoja, como la escribe la oficina', async () => {
    // De 724 NC en 90 días, 287 dicen "SEGUN HR ####". Se respeta esa convención.
    await llamar(crearAjuste, {
      params: { id: 'h1' },
      body: { im_comprobante_id: '10', motivo: 'NO PIDIO', items: [{ cod_articulo: 661, cantidad: 1 }] },
    });
    expect(m.emitirNotaCredito.mock.calls[0][0].observaciones).toBe('NO PIDIO SEGUN HR 3395');
  });

  it('🔴 si IM no contesta, la fila NO se borra: puede que la NC haya salido', async () => {
    m.emitirNotaCredito.mockResolvedValue({ ok: false, error: 'timeout', sinRespuesta: true });
    const r = await llamar(crearAjuste, {
      params: { id: 'h1' },
      body: { im_comprobante_id: '10', motivo: 'NO PIDIO', items: [{ cod_articulo: 661, cantidad: 1 }] },
    });
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/no contestó|verificalo/i);
    expect(escrituras.some(e => e.op === 'delete')).toBe(false);
  });

  it('si IM RECHAZA, se suelta la fila para poder corregir y reintentar', async () => {
    m.emitirNotaCredito.mockResolvedValue({ ok: false, error: 'Talonario cerrado' });
    const r = await llamar(crearAjuste, {
      params: { id: 'h1' },
      body: { im_comprobante_id: '10', motivo: 'NO PIDIO', items: [{ cod_articulo: 661, cantidad: 1 }] },
    });
    expect(r.status).toBe(502);
    expect(escrituras.some(e => e.op === 'delete')).toBe(true);
  });

  it('🔴 un ajuste a medias de ese pedido frena otro nuevo', async () => {
    tablas['hojas_ruta_ajustes'] = { data: [{ id: 'viejo', emitido_at: null, reclamado_at: new Date().toISOString() }], error: null };
    const r = await llamar(crearAjuste, {
      params: { id: 'h1' },
      body: { im_comprobante_id: '10', motivo: 'NO PIDIO', items: [{ cod_articulo: 661, cantidad: 1 }] },
    });
    expect(r.status).toBe(409);
    expect(m.emitirNotaCredito).not.toHaveBeenCalled();
  });

  it('un pedido que no está en la hoja se rechaza', async () => {
    const r = await llamar(crearAjuste, {
      params: { id: 'h1' },
      body: { im_comprobante_id: '999', motivo: 'NO PIDIO', items: [{ cod_articulo: 661, cantidad: 1 }] },
    });
    expect(r.status).toBe(409);
  });

  it('sin motivo no se emite: es lo que se lee después en IM', async () => {
    const r = await llamar(crearAjuste, {
      params: { id: 'h1' }, body: { im_comprobante_id: '10', items: [{ cod_articulo: 661, cantidad: 1 }] },
    });
    expect(r.status).toBe(400);
  });

  it('🔴 un vendedor no emite notas de crédito', async () => {
    expect((await llamar(crearAjuste, { rol: 'vendedor', params: { id: 'h1' } })).status).toBe(403);
  });
});

describe('el número final de la hoja', () => {
  it('🔴 descuenta las NC emitidas y suma las ND', async () => {
    const t = totalesConAjustes(HOJA, [
      { tipo: 'nc', importe: 20000, emitido_at: 'x' },
      { tipo: 'nd', importe: 5000, emitido_at: 'x' },
    ]);
    expect(t).toMatchObject({ despachado: 150000, notas_credito: 20000, notas_debito: 5000, final: 135000 });
  });

  it('🔴 un ajuste SIN emitir no descuenta: no bajó ninguna cuenta corriente', async () => {
    // Si descontara, al chofer se le pagaría de menos por algo que no pasó.
    const t = totalesConAjustes(HOJA, [{ tipo: 'nc', importe: 20000, emitido_at: null }]);
    expect(t.final).toBe(150000);
    expect(t.pendientes_de_emitir).toBe(1);
  });

  it('sin ajustes, el final es lo despachado', async () => {
    expect(totalesConAjustes(HOJA, []).final).toBe(150000);
  });
});

describe('borrar un ajuste', () => {
  /**
   * 🔄 La regla cambió con la auditoría del 08/09/2026. Antes se filtraba por `emitido_at is
   * null`, y como vincular escribe `emitido_at`, el borrado no matcheaba NUNCA. Ahora lo que
   * decide es **quién emitió la nota**, y eso se sabe por `items`: emitir desde el panel exige
   * renglones, vincular los deja vacíos. Los casos completos están en `etapa3Auditoria.test.ts`.
   */
  it('🔴 lo que EMITIMOS NOSOTROS no se borra: esta fila es el único registro del vínculo', async () => {
    tablas['hojas_ruta_ajustes'] = {
      data: { id: 'aj1', items: [{ cod_articulo: 1, cantidad: 1, precio: 10 }], emitido_at: 'x', im_ajuste_numero: 30058 },
      error: null,
    };
    const r = await llamar(borrarAjuste, { params: { id: 'aj1' } });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/anular/i);
  });

  it('una nota VINCULADA se suelta: sigue existiendo en InfoManager', async () => {
    tablas['hojas_ruta_ajustes'] = { data: { id: 'aj1', items: [], emitido_at: 'x' }, error: null };
    expect((await llamar(borrarAjuste, { params: { id: 'aj1' } })).status).toBe(200);
  });

  it('uno que no llegó a emitirse también', async () => {
    tablas['hojas_ruta_ajustes'] = { data: { id: 'aj1', items: [], emitido_at: null }, error: null };
    expect((await llamar(borrarAjuste, { params: { id: 'aj1' } })).status).toBe(200);
  });
});

describe('listar', () => {
  it('devuelve los ajustes con el desglose del número final', async () => {
    tablas['hojas_ruta_ajustes'] = { data: [{ tipo: 'nc', importe: 10000, emitido_at: 'x' }], error: null };
    const r = await llamar(listarAjustes, { params: { id: 'h1' } });
    expect(r.body).toMatchObject({ despachado: 150000, notas_credito: 10000, final: 140000 });
  });
});

/** Hallazgos de la auditoría del 08/09/2026 sobre las notas de crédito. */
describe('lo que ya se acreditó antes', () => {
  beforeEach(() => { process.env.IM_NC_EMISION_HABILITADA = '1'; });
  afterEach(() => { delete process.env.IM_NC_EMISION_HABILITADA; });

  it('🔴 dos notas de crédito no pueden sumar más de lo que se entregó', async () => {
    // Cargar dos veces la misma diferencia emitía dos NC enteras y el cliente quedaba con saldo
    // a favor del doble. El guard anterior sólo miraba los ajustes SIN emitir, o sea ninguno.
    tablas['hojas_ruta_ajustes'] = {
      data: [{ id: 'v1', emitido_at: 'x', tipo: 'nc', importe: 50000, items: [{ cod_articulo: 661, cantidad: 10 }] }],
      error: null,
    };
    const r = await llamar(crearAjuste, {
      params: { id: 'h1' },
      body: { im_comprobante_id: '10', motivo: 'NO PIDIO', items: [{ cod_articulo: 661, cantidad: 1 }] },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/ya se acreditaron 10/);
    expect(m.emitirNotaCredito).not.toHaveBeenCalled();
  });

  it('lo que falta acreditar sí se puede', async () => {
    tablas['hojas_ruta_ajustes'] = {
      data: [{ id: 'v1', emitido_at: 'x', tipo: 'nc', importe: 20000, items: [{ cod_articulo: 661, cantidad: 4 }] }],
      error: null,
    };
    const r = await llamar(crearAjuste, {
      params: { id: 'h1' },
      body: { im_comprobante_id: '10', motivo: 'SIN STOCK', items: [{ cod_articulo: 661, cantidad: 6 }] },
    });
    expect(r.status).toBe(200);
  });

  it('🔴 los renglones acreditados quedan guardados: son la base de ese control', async () => {
    await llamar(crearAjuste, {
      params: { id: 'h1' },
      body: { im_comprobante_id: '10', motivo: 'NO PIDIO', items: [{ cod_articulo: 661, cantidad: 3 }] },
    });
    const fila = escrituras.find(e => e.op === 'insert')!.valor;
    expect(fila.items).toEqual([{ cod_articulo: 661, cantidad: 3, precio: 5000, iva_por: 0, cod_lista_precios: 13 }]);
  });
});

describe('contra qué se puede emitir', () => {
  beforeEach(() => { process.env.IM_NC_EMISION_HABILITADA = '1'; });
  afterEach(() => { delete process.env.IM_NC_EMISION_HABILITADA; });

  it('🔴 no se acredita un pedido que todavía no se facturó', async () => {
    tablas['hojas_ruta'] = {
      data: { ...HOJA, hojas_ruta_pedidos: [{ im_comprobante_id: '10', cod_cliente: 1093, total: 100000, facturado_at: null, im_factura_numero: null }] },
      error: null,
    };
    const r = await llamar(crearAjuste, {
      params: { id: 'h1' }, body: { im_comprobante_id: '10', motivo: 'NO PIDIO', items: [{ cod_articulo: 661, cantidad: 1 }] },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/no se facturó/i);
  });

  it('🔴 ni contra un comprobante ANULADO en InfoManager', async () => {
    m.cabeceraComprobante.mockResolvedValue({ fecha: '2026-09-08', anulada: true, existe: true });
    const r = await llamar(crearAjuste, {
      params: { id: 'h1' }, body: { im_comprobante_id: '10', motivo: 'NO PIDIO', items: [{ cod_articulo: 661, cantidad: 1 }] },
    });
    expect(r.status).toBe(502);
    expect(m.emitirNotaCredito).not.toHaveBeenCalled();
  });

  it('🔴 ni cuando IM no contesta si sigue vigente', async () => {
    m.cabeceraComprobante.mockResolvedValue({ fecha: null, anulada: null, existe: null });
    const r = await llamar(crearAjuste, {
      params: { id: 'h1' }, body: { im_comprobante_id: '10', motivo: 'NO PIDIO', items: [{ cod_articulo: 661, cantidad: 1 }] },
    });
    expect(r.status).toBe(502);
    expect(m.emitirNotaCredito).not.toHaveBeenCalled();
  });

  it('🔴 ni sobre una hoja CERRADA: ya se liquidó', async () => {
    tablas['hojas_ruta'] = { data: { ...HOJA, estado: 'cerrada' }, error: null };
    const r = await llamar(crearAjuste, {
      params: { id: 'h1' }, body: { im_comprobante_id: '10', motivo: 'NO PIDIO', items: [{ cod_articulo: 661, cantidad: 1 }] },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/cerrada/i);
  });
});

/**
 * 🔴 El camino real: InfoManager NO deja emitir notas de crédito por API en el punto 777 (su
 * validación del número no distingue el tipo de comprobante, probado el 08/09/2026). La oficina
 * la emite en IM y el panel la VINCULA.
 */
describe('vincular una nota de crédito ya emitida en IM', () => {
  it('🔴 emitir desde el panel está apagado y lo dice', async () => {
    const r = await llamar(crearAjuste, {
      params: { id: 'h1' }, body: { im_comprobante_id: '10', motivo: 'NO PIDIO', items: [{ cod_articulo: 661, cantidad: 1 }] },
    });
    expect(r.status).toBe(501);
    expect(r.body.error).toMatch(/vincul/i);
    expect(m.emitirNotaCredito).not.toHaveBeenCalled();
  });

  it('🔴 el importe y el número salen de la NC REAL, no del body', async () => {
    // Si vinieran de la pantalla, el número final de la hoja —y el pago del chofer— dependería
    // de lo que alguien tipeó.
    const r = await llamar(vincularAjuste, {
      params: { id: 'h1' },
      body: { im_comprobante_id: '10', im_ajuste_id: 'nc-99', importe: 999999 },
    });
    expect(r.status).toBe(200);
    const fila = escrituras.find(e => e.op === 'insert')!.valor;
    expect(fila).toMatchObject({ importe: 20000, im_ajuste_numero: 30058, im_ajuste_tipo: 'NC B' });
    expect(fila.emitido_at).toBeTruthy();     // ya existe en IM: cuenta desde que se ata
  });

  it('🔴 no se vincula una NC de OTRO cliente', async () => {
    m.imClient.mockResolvedValue({ get: vi.fn(async () => ({ data: { ...NC_EN_IM, cod_cliente: 777 } })) });
    const r = await llamar(vincularAjuste, {
      params: { id: 'h1' }, body: { im_comprobante_id: '10', im_ajuste_id: 'nc-99' },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/cliente/i);
    expect(escrituras.some(e => e.op === 'insert')).toBe(false);
  });

  it('🔴 ni una ANULADA, ni algo que no sea una nota de crédito', async () => {
    m.imClient.mockResolvedValue({ get: vi.fn(async () => ({ data: { ...NC_EN_IM, anulada: 'S' } })) });
    expect((await llamar(vincularAjuste, { params: { id: 'h1' }, body: { im_comprobante_id: '10', im_ajuste_id: 'nc-99' } })).status).toBe(409);

    m.imClient.mockResolvedValue({ get: vi.fn(async () => ({ data: { ...NC_EN_IM, tipo_comprobante: 'FA' } })) });
    expect((await llamar(vincularAjuste, { params: { id: 'h1' }, body: { im_comprobante_id: '10', im_ajuste_id: 'nc-99' } })).status).toBe(409);
  });

  it('🔴 la misma NC no se vincula dos veces: se descontaría dos veces del pago', async () => {
    tablas['hojas_ruta_ajustes'] = { data: null, error: { code: '23505', message: 'duplicate key' } };
    const r = await llamar(vincularAjuste, {
      params: { id: 'h1' }, body: { im_comprobante_id: '10', im_ajuste_id: 'nc-99' },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/ya está vinculada/i);
  });

  it('avisa si la nota es más grande que el pedido, pero deja vincularla', async () => {
    // Una NC puede cubrir varios pedidos: el dato de IM es el que manda.
    m.imClient.mockResolvedValue({ get: vi.fn(async () => ({ data: { ...NC_EN_IM, total: 500000 } })) });
    const r = await llamar(vincularAjuste, {
      params: { id: 'h1' }, body: { im_comprobante_id: '10', im_ajuste_id: 'nc-99' },
    });
    expect(r.status).toBe(200);
    expect(r.body.advertencia).toMatch(/MAYOR/);
  });

  it('🔴 sobre una hoja CERRADA no se vincula nada', async () => {
    tablas['hojas_ruta'] = { data: { ...HOJA, estado: 'cerrada' }, error: null };
    const r = await llamar(vincularAjuste, {
      params: { id: 'h1' }, body: { im_comprobante_id: '10', im_ajuste_id: 'nc-99' },
    });
    expect(r.status).toBe(409);
  });
});

describe('candidatas a vincular', () => {
  it('🔴 pone primero las que mencionan la hoja: es lo que la oficina ya escribe', async () => {
    m.fetchVentas.mockResolvedValue([
      { id: 'a', tipo_comprobante: 'NC', tipo_factura: 'B', numero: 1, cod_cliente: 1093, total: 1000, fecha: '2026-09-09', anulada: 'N', observaciones: 'SIN STOCK' },
      { id: 'b', tipo_comprobante: 'NC', tipo_factura: 'B', numero: 2, cod_cliente: 1093, total: 2000, fecha: '2026-09-09', anulada: 'N', observaciones: 'NO PIDIO SEGUN HR 3395' },
      { id: 'c', tipo_comprobante: 'FA', tipo_factura: 'B', numero: 3, cod_cliente: 1093, total: 3000, fecha: '2026-09-09', anulada: 'N' },
      { id: 'd', tipo_comprobante: 'NC', tipo_factura: 'B', numero: 4, cod_cliente: 999, total: 4000, fecha: '2026-09-09', anulada: 'N' },
    ]);
    tablas['hojas_ruta_ajustes'] = { data: [], error: null };

    const r = await llamar(candidatasAVincular, { params: { id: 'h1' }, query: { im_comprobante_id: '10' } });

    // Sólo NC del cliente del pedido, y la que menciona la hoja va primera.
    expect(r.body.candidatas.map((c: any) => c.im_ajuste_id)).toEqual(['b', 'a']);
    expect(r.body.candidatas[0].menciona_esta_hoja).toBe(true);
  });

  it('🔴 no ofrece una que ya está vinculada', async () => {
    m.fetchVentas.mockResolvedValue([
      { id: 'a', tipo_comprobante: 'NC', tipo_factura: 'B', numero: 1, cod_cliente: 1093, total: 1000, fecha: '2026-09-09', anulada: 'N', observaciones: '' },
    ]);
    tablas['hojas_ruta_ajustes'] = { data: [{ im_ajuste_id: 'a' }], error: null };
    const r = await llamar(candidatasAVincular, { params: { id: 'h1' }, query: { im_comprobante_id: '10' } });
    expect(r.body.candidatas).toHaveLength(0);
  });

  it('tampoco las anuladas', async () => {
    m.fetchVentas.mockResolvedValue([
      { id: 'a', tipo_comprobante: 'NC', tipo_factura: 'B', numero: 1, cod_cliente: 1093, total: 1000, fecha: '2026-09-09', anulada: 'S', observaciones: '' },
    ]);
    tablas['hojas_ruta_ajustes'] = { data: [], error: null };
    const r = await llamar(candidatasAVincular, { params: { id: 'h1' }, query: { im_comprobante_id: '10' } });
    expect(r.body.candidatas).toHaveLength(0);
  });
});
