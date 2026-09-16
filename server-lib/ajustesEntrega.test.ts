import { respuestaReparto } from './test-helpers/repartoRpc.js';
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

vi.mock('./infomanager.js', () => { const fuente = {
  // El cache de /ventas se limpia junto con las vistas (10/09/2026).
  invalidarCacheVentas: vi.fn(),
  invalidarCacheItems: vi.fn(),
  fetchClientesIMCached: m.fetchClientesIMCached,
  fetchVentasItems: m.fetchVentasItems,
  cabeceraComprobante: m.cabeceraComprobante,
  fetchVentas: m.fetchVentas,
  imClient: m.imClient, imGetRetry: (fn: any) => fn(),
  fechaArgentina: () => '2026-09-08',
}; return { ...fuente, invalidarIM: vi.fn(), leerComprobante: async (id: string) => ({ cabecera: await (fuente as any).cabeceraComprobante(id), items: await (fuente as any).getItemsComprobante(id) }) }; });
vi.mock('./facturarIM.js', () => ({ emitirNotaCredito: m.emitirNotaCredito }));
vi.mock('./pedidos.js', () => ({ usuarioIM: vi.fn(async () => 'jorgelina') }));
vi.mock('./supabase.js', () => ({ sb: m.sbMock, TENANT_ID: 'test-tenant', hasSupabase: () => true }));

const { crearAjuste, listarAjustes, borrarAjuste, totalesConAjustes, candidatasAVincular, vincularAjuste } = await import('./ajustesEntrega.js');

let tablas: Record<string, any> = {};
let escrituras: Array<{ tabla: string; op: string; valor: any }> = [];

function fakeSb() {
  m.sbMock.mockImplementation(() => ({
    rpc: respuestaReparto(() => tablas, (tabla, op, valor, filtros) => { escrituras.push({ tabla, op, valor, filtros } as any); }),
    from: (t: string) => {
      const res = tablas[t] ?? { data: null, error: null };
      const lista = t === 'presupuestos_facturados' && res.data && !Array.isArray(res.data) ? { ...res, data: [] } : res;
      const q: any = {
        then: (r: any, j: any) => Promise.resolve(lista).then(r, j),
        maybeSingle: () => Promise.resolve(res),
        insert: (v: any) => { escrituras.push({ tabla: t, op: 'insert', valor: v }); return { ...q, maybeSingle: () => Promise.resolve({ data: { id: 'aj1', ...v }, error: null }) }; },
        update: (v: any) => { escrituras.push({ tabla: t, op: 'update', valor: v }); return q; },
        delete: () => { escrituras.push({ tabla: t, op: 'delete', valor: null }); return q; },
      };
      for (const k of ['range', 'or', 'select', 'eq', 'in', 'is', 'not', 'order', 'limit']) q[k] = () => q;
      return q;
    },
  }));
}

function llamar(fn: any, { rol = 'administrativo', params = {}, body = {}, query = {} } = {}) {
  let status = 200; let out: any;
  const req: any = { user: { rol, sub: 'u1' }, params, body: { version_esperada:1, ...body }, query: { version_esperada:1, ...query } };
  const res: any = { status: (s: number) => { status = s; return res; }, json: (b: any) => { out = b; } };
  return fn(req, res).then(() => ({ status, body: out }));
}

const HOJA = {
  id: 'h1', numero: 3395, fecha: '2026-09-08', estado: 'abierta', cod_empresa: 1,
  hojas_ruta_pedidos: [
    { im_comprobante_id: '10', cod_empresa:1, cod_cliente: 1093, cliente_nombre: 'ARON, Jorge', total: 100000, facturado_at: '2026-09-08T12:00:00Z', im_factura_id: '58796590', im_factura_numero: 50360 },
    { im_comprobante_id: '20', cod_empresa:1, cod_cliente: 500, cliente_nombre: 'MORELLI', total: 50000, facturado_at: '2026-09-08T12:00:00Z', im_factura_numero: 50361 },
  ],
};
/** Una nota de crédito como la devuelve `GET /ventas/{id}`. */
const NC_EN_IM = {
  id: '58900099', tipo_comprobante: 'NC', tipo_factura: 'B', numero: 30058,
  cod_empresa:1, cod_cliente: 1093, total: 20000, anulada: 'N', observaciones: 'NO PIDIO SEGUN HR 3395',
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


describe('el número final de la hoja', () => {
  /** Las notas llegan ya conciliadas de la fuente común: journal de correcciones + panel. */
  it('🔴 descuenta las NC y suma las ND', async () => {
    const t = totalesConAjustes(HOJA, [], [
      { tipo: 'NC B', total: 20000 },
      { tipo: 'ND B', total: 5000 },
    ]);
    expect(t).toMatchObject({ despachado: 150000, notas_credito: 20000, notas_debito: 5000, final: 135000 });
  });

  it('🔴 un ajuste SIN emitir no descuenta: no bajó ninguna cuenta corriente', async () => {
    // Si descontara, al chofer se le pagaría de menos por algo que no pasó. La fuente común ya
    // filtra por `emitido_at`, así que ese ajuste no llega como nota — pero sí se cuenta como
    // pendiente, para que se vea que falta.
    const t = totalesConAjustes(HOJA, [{ tipo: 'nc', importe: 20000, emitido_at: null }], []);
    expect(t.final).toBe(150000);
    expect(t.pendientes_de_emitir).toBe(1);
  });

  it('sin notas, el final es lo despachado', async () => {
    expect(totalesConAjustes(HOJA, [], []).final).toBe(150000);
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
  // La hoja está abierta: el importe de la factura sale de IM, como en producción.
  beforeEach(() => {
    m.cabeceraComprobante.mockResolvedValue({ fecha: '2026-09-08', anulada: false, existe: true, total: 100000, tipo_comprobante: 'FA', cod_cliente: 1093, cod_empresa: 1 });
  });

  const vinculada = (over: any = {}) => ({
    id: 'aj1', hoja_id: 'h1', im_comprobante_id: '10', im_ajuste_id: '58900001', im_ajuste_numero: 30079,
    tipo: 'nc', im_ajuste_tipo: 'NC B', importe: 10000, emitido_at: 'x', ...over,
  });

  it('devuelve los ajustes con el desglose del número final', async () => {
    tablas['hojas_ruta_ajustes'] = { data: [vinculada()], error: null };
    const r = await llamar(listarAjustes, { params: { id: 'h1' } });
    expect(r.body).toMatchObject({ despachado: 150000, notas_credito: 10000, final: 140000 });
  });

  /**
   * 🔑 El modal leía sólo `hojas_ruta_ajustes` y mostraba un final más alto que el papel de la
   * misma hoja, que sí descuenta las notas del circuito de corrección de factura.
   */
  it('🔑 una nota que sólo está en el journal de correcciones también cuenta', async () => {
    tablas['hojas_ruta_ajustes'] = { data: [], error: null };
    tablas['facturas_correcciones'] = { data: [{ im_factura_id: '58796590', im_comprobante_id: '58900002', tipo: 'NC B', total: 25000, numero: 30080 }], error: null };
    tablas['presupuestos_facturados'] = { data: [{ im_comprobante_id: '10', im_factura_id: '58796590', cod_cliente: 1093, cod_empresa: 1, total: 100000, facturado_at: 'x' }], error: null };
    const r = await llamar(listarAjustes, { params: { id: 'h1' } });
    expect(r.body.notas_credito).toBe(25000);
  });

  it('🔑 la misma nota por las dos fuentes se cuenta una sola vez', async () => {
    tablas['hojas_ruta_ajustes'] = { data: [vinculada({ im_ajuste_id: '58900002', importe: 25000 })], error: null };
    tablas['facturas_correcciones'] = { data: [{ im_factura_id: '58796590', im_comprobante_id: '58900002', tipo: 'NC B', total: 25000, numero: 30080 }], error: null };
    tablas['presupuestos_facturados'] = { data: [{ im_comprobante_id: '10', im_factura_id: '58796590', cod_cliente: 1093, cod_empresa: 1, total: 100000, facturado_at: 'x' }], error: null };
    const r = await llamar(listarAjustes, { params: { id: 'h1' } });
    expect(r.body.notas_credito).toBe(25000);
    expect(r.body.final).toBe(125000);
  });

  /**
   * 🔴 CASO REAL (ANDRADES, NC B 13): la misma nota está en el journal Y vinculada desde el
   * panel. Marcarla como "del panel" hacía que la pantalla ofreciera sacarla, y borrar esa fila
   * NO cambia el total — el journal la sigue descontando. El botón prometía un efecto que no
   * ocurre, y se descubría después de tocarlo.
   */
  it('🔑 una nota sostenida por las DOS fuentes cuenta una vez y no se ofrece sacar', async () => {
    tablas['hojas_ruta_ajustes'] = { data: [vinculada({ im_ajuste_id: '58900002', importe: 25000 })], error: null };
    tablas['facturas_correcciones'] = { data: [{ im_factura_id: '58796590', im_comprobante_id: '58900002', tipo: 'NC B', total: 25000, numero: 30080 }], error: null };
    tablas['presupuestos_facturados'] = { data: [{ im_comprobante_id: '10', im_factura_id: '58796590', cod_cliente: 1093, cod_empresa: 1, total: 100000, facturado_at: 'x' }], error: null };
    const r = await llamar(listarAjustes, { params: { id: 'h1' } });
    expect(r.body.notas).toHaveLength(1);
    expect(r.body.notas[0]).toMatchObject({ im_ajuste_id: '58900002', origen: 'ambas', ajuste_id: null });
    expect(r.body.notas_credito).toBe(25000);
  });

  it('🔑 y una que SÓLO vinculó el panel sí se puede sacar', async () => {
    tablas['hojas_ruta_ajustes'] = { data: [vinculada()], error: null };
    tablas['facturas_correcciones'] = { data: [], error: null };
    const r = await llamar(listarAjustes, { params: { id: 'h1' } });
    expect(r.body.notas[0]).toMatchObject({ origen: 'panel', ajuste_id: 'aj1' });
  });

  it('🔑 si las dos fuentes discrepan, no se publica un final', async () => {
    tablas['hojas_ruta_ajustes'] = { data: [vinculada({ im_ajuste_id: '58900002', importe: 40000 })], error: null };
    tablas['facturas_correcciones'] = { data: [{ im_factura_id: '58796590', im_comprobante_id: '58900002', tipo: 'NC B', total: 25000, numero: 30080 }], error: null };
    tablas['presupuestos_facturados'] = { data: [{ im_comprobante_id: '10', im_factura_id: '58796590', cod_cliente: 1093, cod_empresa: 1, total: 100000, facturado_at: 'x' }], error: null };
    const r = await llamar(listarAjustes, { params: { id: 'h1' } });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/58900002/);
  });
});

/** Hallazgos de la auditoría del 08/09/2026 sobre las notas de crédito. */


/** Lo que el operador tenía en pantalla: sin esto no se vincula (ver los tests de más abajo). */
const VISTO = { im_factura_id: '58796590', esperado: { tipo: 'NC B', numero: 30058, importe: 20000 } };

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
      body: { ...VISTO, im_comprobante_id: '10', im_ajuste_id: '58900099', importe: 999999 },
    });
    expect(r.status).toBe(200);
    const fila = escrituras.find(e => e.op === 'insert')!.valor;
    expect(fila).toMatchObject({ importe: 20000, im_ajuste_numero: 30058, im_ajuste_tipo: 'NC B' });
    expect(fila.emitido_at).toBeTruthy();     // ya existe en IM: cuenta desde que se ata
  });

  it('🔴 no se vincula una NC de OTRO cliente', async () => {
    m.imClient.mockResolvedValue({ get: vi.fn(async () => ({ data: { ...NC_EN_IM, cod_cliente: 777 } })) });
    const r = await llamar(vincularAjuste, {
      params: { id: 'h1' }, body: { ...VISTO, im_comprobante_id: '10', im_ajuste_id: '58900099' },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/cliente/i);
    expect(escrituras.some(e => e.op === 'insert')).toBe(false);
  });

  it('🔴 ni una ANULADA, ni algo que no sea una nota de crédito', async () => {
    m.imClient.mockResolvedValue({ get: vi.fn(async () => ({ data: { ...NC_EN_IM, anulada: 'S' } })) });
    expect((await llamar(vincularAjuste, { params: { id: 'h1' }, body: { ...VISTO, im_comprobante_id: '10', im_ajuste_id: '58900099' } })).status).toBe(409);

    m.imClient.mockResolvedValue({ get: vi.fn(async () => ({ data: { ...NC_EN_IM, tipo_comprobante: 'FA' } })) });
    expect((await llamar(vincularAjuste, { params: { id: 'h1' }, body: { ...VISTO, im_comprobante_id: '10', im_ajuste_id: '58900099' } })).status).toBe(409);
  });

  it('🔴 la misma NC no se vincula dos veces: se descontaría dos veces del pago', async () => {
    tablas['hojas_ruta_ajustes'] = { data: null, error: { code: '23505', message: 'duplicate key' } };
    const r = await llamar(vincularAjuste, {
      params: { id: 'h1' }, body: { ...VISTO, im_comprobante_id: '10', im_ajuste_id: '58900099' },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/ya está vinculada/i);
  });

  /**
   * 🔑 Hasta hoy sólo se podían vincular NC. Una ND es lo contrario: SUMA. Si el signo saliera
   * del formulario en vez del tipo verificado en IM, una nota de débito podría descontarle al
   * chofer plata que en realidad se le cobró de más al cliente.
   */
  it('🔑 una NOTA DE DÉBITO se vincula y suma', async () => {
    m.imClient.mockResolvedValue({ get: vi.fn(async () => ({ data: { ...NC_EN_IM, tipo_comprobante: 'ND', numero: 746 } })) });
    const r = await llamar(vincularAjuste, {
      params: { id: 'h1' }, body: { ...VISTO, esperado: { tipo: 'ND B', numero: 746, importe: 20000 }, im_comprobante_id: '10', im_ajuste_id: '58900099' },
    });
    expect(r.status).toBe(200);
    expect(r.body.ajuste).toMatchObject({ tipo: 'ND B', signo: 1 });
    expect(escrituras.find(e => e.op === 'insert')!.valor).toMatchObject({ tipo: 'nd', importe: 20000, im_ajuste_numero: 746 });
  });

  /**
   * 🔴 La lista de candidatas puede venir de caché. Entre verla y confirmar, la nota pudo cambiar
   * de importe, de tipo o de número: grabar el valor nuevo en silencio sería descontarle a la
   * hoja —y al pago del chofer— una cifra que nadie miró.
   */
  describe('si algo cambió entre mostrar y confirmar', () => {
    const confirmar = (esperado: any, extra: any = {}) => llamar(vincularAjuste, {
      params: { id: 'h1' },
      body: { im_factura_id: '58796590', im_comprobante_id: '10', im_ajuste_id: '58900099', esperado: esperado ?? VISTO.esperado, ...extra },
    });

    it('🔑 el importe cambió: no se graba y se pide recargar', async () => {
      const r = await confirmar({ tipo: 'NC B', numero: 30058, importe: 12000 });
      expect(r.status).toBe(409);
      expect(r.body.recargar).toBe(true);
      expect(r.body.error).toMatch(/20000/);
      expect(escrituras.some(e => e.op === 'insert')).toBe(false);
    });

    it('🔑 el tipo o el número cambiaron: tampoco', async () => {
      expect((await confirmar({ tipo: 'ND B', numero: 30058, importe: 20000 })).status).toBe(409);
      expect((await confirmar({ tipo: 'NC B', numero: 99999, importe: 20000 })).status).toBe(409);
      expect(escrituras.some(e => e.op === 'insert')).toBe(false);
    });

    it('🔑 la FACTURA de destino cambió: la nota iría a un comprobante que nadie miró', async () => {
      const r = await confirmar(null, { im_factura_id: '58799606' });
      expect(r.status).toBe(409);
      expect(r.body.recargar).toBe(true);
      expect(r.body.error).toMatch(/factura/i);
      expect(escrituras.some(e => e.op === 'insert')).toBe(false);
    });

    /**
     * 🔴 Si faltaran, la confirmación se saltearía sola: el caso peligroso (la nota cambió) es
     * justo el que no manda el dato. Por eso son obligatorios, no "si vienen, se comparan".
     */
    it('🔑 sin lo que se vio en pantalla no se vincula', async () => {
      for (const body of [
        { im_comprobante_id: '10', im_ajuste_id: '58900099' },
        { im_comprobante_id: '10', im_ajuste_id: '58900099', im_factura_id: '58796590' },
        { im_comprobante_id: '10', im_ajuste_id: '58900099', esperado: { tipo: 'NC B', numero: 30058, importe: 20000 } },
        { im_comprobante_id: '10', im_ajuste_id: '58900099', im_factura_id: '58796590', esperado: 'NC 30058' },
      ]) {
        escrituras = [];
        const r = await llamar(vincularAjuste, { params: { id: 'h1' }, body });
        expect(r.status, JSON.stringify(body)).toBe(400);
        expect(escrituras.some(e => e.op === 'insert')).toBe(false);
      }
    });

    /**
     * 🔴 Un `{}` o un `"ilegible"` haría que cada comparación se saltee sola y la confirmación
     * pase siempre — justo en el caso que se quería atrapar. Se exige cada campo legible.
     */
    it('🔑 un esperado vacío, parcial o ilegible NO confirma nada', async () => {
      for (const esperado of [
        {},
        { tipo: null, numero: 'ilegible', importe: 'ilegible' },
        { tipo: 'NC B' },
        { numero: 30058, importe: 20000 },
        { tipo: 'NC B', numero: 30058 },
        { tipo: 'NC B', numero: 0, importe: 20000 },
        { tipo: 'NC B', numero: 30.5, importe: 20000 },
        { tipo: 'NC B', numero: true, importe: 20000 },
        { tipo: 'NC B', numero: 30058, importe: 0 },
        { tipo: 'NC B', numero: 30058, importe: [20000] },
        { tipo: 'NC B', numero: 30058, importe: Infinity },
        { tipo: 'NCBASURA', numero: 30058, importe: 20000 },
        { tipo: 'NC', numero: 30058, importe: 20000 },       // sin letra no alcanza
        [{ tipo: 'NC B', numero: 30058, importe: 20000 }],
      ]) {
        escrituras = [];
        const r = await confirmar(esperado as any);
        expect(r.status, JSON.stringify(esperado)).toBe(400);
        expect(r.body.recargar).toBeUndefined();
        expect(escrituras.some(e => e.op === 'insert')).toBe(false);
      }
    });

    /** 🪤 'NC A' y 'NC B' son comprobantes distintos: comparar sólo "NC" deja pasar el cambio. */
    it('🔑 la LETRA cambió: es otro comprobante', async () => {
      const r = await confirmar({ tipo: 'NC A', numero: 30058, importe: 20000 });
      expect(r.status).toBe(409);
      expect(r.body.recargar).toBe(true);
      expect(r.body.error).toMatch(/NC B/);
      expect(escrituras.some(e => e.op === 'insert')).toBe(false);
    });

    it('y si no cambió nada, entra', async () => {
      const r = await confirmar({ tipo: 'NC B', numero: 30058, importe: 20000 });
      expect(r.status).toBe(200);
    });
  });

  /** 🪤 Sin id que acredite qué contestó IM no se puede atar plata a una hoja. */
  it('🔑 una respuesta de IM que no acredita su id no vincula', async () => {
    for (const id of [null, undefined, {}, true, '58900098']) {
      escrituras = [];
      m.imClient.mockResolvedValue({ get: vi.fn(async () => ({ data: { ...NC_EN_IM, id } })) });
      const r = await llamar(vincularAjuste, { params: { id: 'h1' }, body: { ...VISTO, im_comprobante_id: '10', im_ajuste_id: '58900099' } });
      expect(r.status, JSON.stringify(id)).toBe(409);
      expect(escrituras.some(e => e.op === 'insert')).toBe(false);
    }
  });

  it('avisa si la nota es más grande que el pedido, pero deja vincularla', async () => {
    // Una NC puede cubrir varios pedidos: el dato de IM es el que manda.
    m.imClient.mockResolvedValue({ get: vi.fn(async () => ({ data: { ...NC_EN_IM, total: 500000 } })) });
    const r = await llamar(vincularAjuste, {
      params: { id: 'h1' }, body: { ...VISTO, esperado: { tipo: 'NC B', numero: 30058, importe: 500000 }, im_comprobante_id: '10', im_ajuste_id: '58900099' },
    });
    expect(r.status).toBe(200);
    expect(r.body.advertencia).toMatch(/MAYOR/);
  });

  it('🔴 sobre una hoja CERRADA no se vincula nada', async () => {
    tablas['hojas_ruta'] = { data: { ...HOJA, estado: 'cerrada' }, error: null };
    const r = await llamar(vincularAjuste, {
      params: { id: 'h1' }, body: { im_comprobante_id: '10', im_ajuste_id: '58900099' },
    });
    expect(r.status).toBe(409);
  });
});

describe('candidatas a vincular', () => {
  it('🔴 pone primero las que mencionan la hoja: es lo que la oficina ya escribe', async () => {
    m.fetchVentas.mockResolvedValue([
      { id: '58900001', tipo_comprobante: 'NC', tipo_factura: 'B', numero: 1, cod_cliente: 1093, cod_empresa: 1, total: 1000, fecha: '2026-09-09', anulada: 'N', observaciones: 'SIN STOCK' },
      { id: '58900002', tipo_comprobante: 'NC', tipo_factura: 'B', numero: 2, cod_cliente: 1093, cod_empresa: 1, total: 2000, fecha: '2026-09-09', anulada: 'N', observaciones: 'NO PIDIO SEGUN HR 3395' },
      { id: '58900003', tipo_comprobante: 'FA', tipo_factura: 'B', numero: 3, cod_cliente: 1093, cod_empresa: 1, total: 3000, fecha: '2026-09-09', anulada: 'N' },
      { id: '58900004', tipo_comprobante: 'NC', tipo_factura: 'B', numero: 4, cod_cliente: 999, cod_empresa: 1, total: 4000, fecha: '2026-09-09', anulada: 'N' },
    ]);
    tablas['hojas_ruta_ajustes'] = { data: [], error: null };

    const r = await llamar(candidatasAVincular, { params: { id: 'h1' }, query: { im_comprobante_id: '10' } });

    // Sólo notas del cliente del pedido, y la que menciona la hoja va primera.
    expect(r.body.candidatas.map((c: any) => c.im_ajuste_id)).toEqual(['58900002', '58900001']);
    expect(r.body.candidatas[0].menciona_esta_hoja).toBe(true);
  });

  it('🔑 también ofrece NOTAS DE DÉBITO, y dice que suman', async () => {
    m.fetchVentas.mockResolvedValue([
      { id: '58900005', tipo_comprobante: 'ND', tipo_factura: 'B', numero: 746, cod_cliente: 1093, cod_empresa: 1, total: 5000, fecha: '2026-09-09', anulada: 'N' },
    ]);
    tablas['hojas_ruta_ajustes'] = { data: [], error: null };
    const r = await llamar(candidatasAVincular, { params: { id: 'h1' }, query: { im_comprobante_id: '10' } });
    expect(r.body.candidatas[0]).toMatchObject({ tipo: 'ND B', signo: 1 });
  });

  /**
   * 🔴 Lo que el POST va a rechazar no se ofrece: mostrarlo es invitar a un clic que sólo puede
   * terminar en error, y encima parece que la nota "no anda" en vez de "no corresponde".
   */
  it('🔑 no ofrece lo que después no se puede vincular', async () => {
    const base = { id: '58900006', tipo_comprobante: 'NC', tipo_factura: 'B', numero: 9, cod_cliente: 1093, cod_empresa: 1, total: 5000, fecha: '2026-09-09', anulada: 'N' };
    for (const malo of [
      { cod_empresa: 2 },            // otra empresa
      { anulada: 'X' },              // vigencia que no se puede confirmar
      { numero: null },              // sin número no se reconoce en pantalla
      { total: 0 },                  // importe cero
      { total: 'ochenta' },          // importe ilegible
      { tipo_factura: '' },          // sin letra
      { cod_cliente: 999 },          // otro cliente
    ]) {
      m.fetchVentas.mockResolvedValue([{ ...base, ...malo }]);
      tablas['hojas_ruta_ajustes'] = { data: [], error: null };
      const r = await llamar(candidatasAVincular, { params: { id: 'h1' }, query: { im_comprobante_id: '10' } });
      expect(r.body.candidatas, JSON.stringify(malo)).toEqual([]);
    }
  });

  /** 🪤 Una nota del journal de correcciones YA descuenta: ofrecerla es invitar a contarla dos veces. */
  it('🔑 no ofrece una nota que ya está en el journal de correcciones', async () => {
    m.fetchVentas.mockResolvedValue([
      { id: '58900007', tipo_comprobante: 'NC', tipo_factura: 'B', numero: 10, cod_cliente: 1093, cod_empresa: 1, total: 5000, fecha: '2026-09-09', anulada: 'N' },
    ]);
    tablas['hojas_ruta_ajustes'] = { data: [], error: null };
    tablas['facturas_correcciones'] = { data: [{ im_comprobante_id: '58900007' }], error: null };
    const r = await llamar(candidatasAVincular, { params: { id: 'h1' }, query: { im_comprobante_id: '10' } });
    expect(r.body.candidatas).toEqual([]);
  });

  /**
   * 🪤 Las dos notas son válidas y sólo se diferencian en que una ya está vinculada: si la
   * fixture tuviera algo que `verificarNota` rechaza igual —un id que no es un id, la empresa
   * ausente—, la prueba pasaría aunque se sacara la exclusión.
   */
  it('🔴 no ofrece una que ya está vinculada, y sí la que no lo está', async () => {
    const nota = (id: string, numero: number) => ({
      id, tipo_comprobante: 'NC', tipo_factura: 'B', numero, cod_cliente: 1093, cod_empresa: 1,
      total: 1000, fecha: '2026-09-09', anulada: 'N', observaciones: '',
    });
    m.fetchVentas.mockResolvedValue([nota('58900010', 1), nota('58900011', 2)]);
    tablas['hojas_ruta_ajustes'] = { data: [{ im_ajuste_id: '58900010' }], error: null };
    const r = await llamar(candidatasAVincular, { params: { id: 'h1' }, query: { im_comprobante_id: '10' } });
    expect(r.body.candidatas.map((c: any) => c.im_ajuste_id)).toEqual(['58900011']);
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

describe('no existe un emisor alternativo bajo flag', () => {
  it.each(['0','1',undefined])('flag %s conserva501 y cero IM', async flag => {
    if (flag == null) delete process.env.IM_NC_EMISION_HABILITADA; else process.env.IM_NC_EMISION_HABILITADA = flag;
    const r = await llamar(crearAjuste, { params: { id: 'h1' }, body: { im_comprobante_id: '10', motivo: 'devolución', items: [{cod_articulo:661,cantidad:1}] } });
    expect(r.status).toBe(501); expect(m.emitirNotaCredito).not.toHaveBeenCalled();
    delete process.env.IM_NC_EMISION_HABILITADA;
  });
  it('mantiene permisos de oficina', async () => {
    expect((await llamar(crearAjuste, { rol: 'vendedor', params: {id:'h1'} })).status).toBe(403);
  });
});
