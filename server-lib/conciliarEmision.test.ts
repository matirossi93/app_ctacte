import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * SE ANULÓ LA FACTURA Y EL REMITO QUEDÓ VIVO.
 *
 * El caso real, leído de InfoManager el 22/09/2026: el pedido era de BUSTOS, Roberto (124) y el
 * vendedor lo cargó a BUSTOS, Rafael (522). Salieron FA 50695 + RE 77809 al cliente equivocado;
 * la oficina borró la factura en IM y rehizo el pedido para Roberto.
 *
 * Cuatro días después seguían vivos el remito del cliente equivocado —descontando por segunda vez
 * los mismos 9 artículos— y un presupuesto duplicado que cualquiera podía facturar. La app lo
 * había detectado y mostraba *"conciliá también el remito"*: un cartel sin ningún botón detrás.
 *
 * Lo que se prueba acá es que las dos salidas existan y que ninguna se dispare sola: anular un
 * remito bueno deja mercadería entregada sin respaldo, y dejar vivo uno malo la descuenta dos
 * veces. Las dos cuestan plata y la app no puede adivinar cuál es cuál.
 */
vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });

const m = vi.hoisted(() => ({
  cabeceraComprobante: vi.fn(),
  anularComprobante: vi.fn(),
  mutarReparto: vi.fn(),
}));

vi.mock('./infomanager.js', () => ({
  cabeceraComprobante: m.cabeceraComprobante,
  anularComprobante: m.anularComprobante,
  fechaArgentina: () => '2026-09-22',
  invalidarIM: vi.fn(),
}));
vi.mock('./vistaPresupuestos.js', () => ({ invalidarVista: vi.fn() }));
vi.mock('./vistaRemitos.js', () => ({ invalidarRemitos: vi.fn() }));
vi.mock('./repartoDatos.js', () => ({ mutarReparto: m.mutarReparto }));
// `frenaSiNoPuede` va de verdad: es la regla de permisos, no un detalle del test.
vi.mock('./facturarPresupuestos.js', async original => await original<any>());

/** Lo que contesta cada tabla. `single` es lo que devuelve `maybeSingle`. */
let filas: Record<string, { single?: any; error?: any }> = {};
/** Los campos con los que se pidió cada select, en orden. */
let selects: string[] = [];
/** Si está, el primer select que pida esa columna falla como lo hace Postgres sin la migración. */
let columnaQueFalta: string | null = null;
let escrituras: Array<{ tabla: string; op: string; valor: any; filtros: any[][] }> = [];
/** Lo que el update/delete dice haber tocado: `[]` = ninguna fila cumplió las condiciones. */
let filasTocadas: any[] = [{ im_comprobante_id: '10' }];
let errorAlEscribir: any = null;

vi.mock('./supabase.js', () => ({
  TENANT_ID: 't',
  hasSupabase: () => true,
  sb: () => ({
    from: (tabla: string) => {
      const q: any = {};
      const filtros: any[][] = [];
      const encadena = (k: string) => (...args: any[]) => { filtros.push([k, ...args]); return q; };
      for (const k of ['eq', 'in', 'is', 'not', 'limit', 'order']) q[k] = encadena(k);
      q.select = (campos: string) => { selects.push(String(campos ?? '')); return encadena('select')(campos); };
      q.maybeSingle = async () => {
        const pidioLaColumna = columnaQueFalta && selects[selects.length - 1]?.includes(columnaQueFalta);
        if (pidioLaColumna) return { data: null, error: { code: '42703', message: `column ${columnaQueFalta} does not exist` } };
        return { data: filas[tabla]?.single ?? null, error: filas[tabla]?.error ?? null };
      };
      q.single = q.maybeSingle;
      q.update = (valor: any) => {
        const w: any = { select: async () => ({ data: errorAlEscribir ? null : filasTocadas, error: errorAlEscribir }) };
        for (const k of ['eq', 'in', 'is', 'not']) w[k] = (...args: any[]) => { filtros.push([k, ...args]); return w; };
        escrituras.push({ tabla, op: 'update', valor, filtros });
        // Sin `.select()` el update se espera directo.
        w.then = (r: any, j: any) => Promise.resolve({ data: null, error: errorAlEscribir }).then(r, j);
        return w;
      };
      q.delete = () => {
        const w: any = {};
        for (const k of ['eq', 'in', 'is']) w[k] = (...args: any[]) => { filtros.push([k, ...args]); return w; };
        escrituras.push({ tabla, op: 'delete', valor: null, filtros });
        w.then = (r: any, j: any) => Promise.resolve({ data: filasTocadas, error: errorAlEscribir }).then(r, j);
        w.select = async () => ({ data: filasTocadas, error: errorAlEscribir });
        return w;
      };
      return q;
    },
  }),
}));

const { descartarRemitoSobrante, habilitarFacturaPendiente } = await import('./conciliarEmision.js');

function llamar(fn: any, { rol = 'administrativo', id = '10' } = {}) {
  let status = 200; let out: any;
  const req: any = { params: { comprobanteId: id }, user: { rol, sub: 'u1' }, body: {} };
  const res: any = { status: (s: number) => { status = s; return res; }, json: (b: any) => { out = b; } };
  return fn(req, res).then(() => ({ status, body: out }));
}

/** La fila de BUSTOS tal como quedó: factura muerta registrada, remito vivo. */
const FILA = {
  im_comprobante_id: '10', im_numero: 58753, cliente_nombre: 'BUSTOS, Rafael (La Florida)',
  cod_cliente: 522, cod_empresa: 1,
  im_factura_id: 'fa-muerta', im_factura_numero: 50695, im_factura_tipo: 'FA B',
  im_remito_id: 're-vivo', im_remito_numero: 77809,
  facturado_at: null, estado_emision: 'anulado',
  historial_remitos: [], historial_facturas: [],
};
const BORRADA = { existe: false, anulada: null, numero: null, punto_de_venta: null, fecha: null, cod_cliente: null };
const REMITO_VIVO = { existe: true, anulada: false, numero: 77809, punto_de_venta: 7, fecha: '2026-09-18', cod_cliente: 522 };
const HOJA_ABIERTA = { hoja_id: 'h1', im_comprobante_id: 're-vivo', hojas_ruta: { numero: 3419, estado: 'abierta', version: 7 } };

/** Cada id contesta lo suyo: la factura muerta y el remito vivo. */
function enIM(factura: any = BORRADA, remito: any = REMITO_VIVO) {
  m.cabeceraComprobante.mockImplementation(async (id: string) =>
    String(id) === 'fa-muerta' ? factura : remito);
}

beforeEach(() => {
  vi.clearAllMocks();
  filas = { presupuestos_facturados: { single: { ...FILA } }, hojas_ruta_pedidos: { single: null } };
  escrituras = []; filasTocadas = [{ im_comprobante_id: '10' }]; errorAlEscribir = null;
  selects = []; columnaQueFalta = null;
  enIM();
  m.anularComprobante.mockResolvedValue({ ok: true, raw: {} });
  m.mutarReparto.mockResolvedValue({ ok: true, version: 8 });
});

describe('el remito NO corresponde', () => {
  it('🔴 lo anula en InfoManager, lo saca de la hoja y libera el pedido', async () => {
    filas.hojas_ruta_pedidos = { single: HOJA_ABIERTA };
    // Después de anular, IM dice que quedó anulado.
    let vecesRemito = 0;
    m.cabeceraComprobante.mockImplementation(async (id: string) => {
      if (String(id) === 'fa-muerta') return BORRADA;
      return ++vecesRemito === 1 ? REMITO_VIVO : { ...REMITO_VIVO, anulada: true };
    });

    const r = await llamar(descartarRemitoSobrante);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, remito: 77809, hoja: 3419, ya_estaba_anulado: false });
    expect(m.anularComprobante).toHaveBeenCalledWith(expect.objectContaining({
      id: 're-vivo', numero: 77809, punto_de_venta: 7, tipo_comprobante: 'RE',
    }));
    expect(m.mutarReparto).toHaveBeenCalledWith('u1', 'quitar', expect.objectContaining({
      hoja_id: 'h1', im_comprobante_id: 're-vivo', version_esperada: 7,
    }));
    expect(escrituras.filter(e => e.op === 'delete' && e.tabla === 'presupuestos_facturados')).toHaveLength(1);
  });

  /**
   * 🔴 EL GUARD QUE MÁS IMPORTA. `estado_emision: 'anulado'` es lo que vio la app la última vez
   * que sincronizó; anular un remito irreversiblemente sobre esa memoria, si la factura revivió
   * o la lectura de entonces fue un falso positivo, rompe una emisión sana.
   */
  it('🔴 NO toca nada si la factura está VIGENTE en InfoManager', async () => {
    enIM({ existe: true, anulada: false, numero: 50695 });
    const r = await llamar(descartarRemitoSobrante);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/VIGENTE/);
    expect(m.anularComprobante).not.toHaveBeenCalled();
    expect(escrituras.filter(e => e.op === 'delete')).toHaveLength(0);
  });

  it('🪤 y tampoco si no se pudo preguntar: "no sé" no es "está muerta"', async () => {
    enIM({ existe: null, anulada: null });
    const r = await llamar(descartarRemitoSobrante);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/no pude verificar/i);
    expect(m.anularComprobante).not.toHaveBeenCalled();
  });

  /**
   * 🔴 La hoja se verifica ANTES de anular: después ya no hay vuelta atrás, y sacarle un remito a
   * una hoja liquidada descuadra el cierre.
   */
  it('🔴 frena si la hoja está CERRADA, y no anula nada', async () => {
    filas.hojas_ruta_pedidos = { single: { ...HOJA_ABIERTA, hojas_ruta: { numero: 3419, estado: 'cerrada', version: 9 } } };
    const r = await llamar(descartarRemitoSobrante);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/CERRADA/);
    expect(m.anularComprobante).not.toHaveBeenCalled();
    expect(m.mutarReparto).not.toHaveBeenCalled();
  });

  /**
   * 🔴 La regla de oro de esta API: contesta 200 con el error adentro. Que el remito quedó
   * anulado lo dice una relectura, no el PUT.
   */
  it('🔴 si IM dice que lo anuló pero sigue vigente, no se libera el pedido', async () => {
    m.cabeceraComprobante.mockImplementation(async (id: string) =>
      String(id) === 'fa-muerta' ? BORRADA : REMITO_VIVO);   // sigue vivo también después
    const r = await llamar(descartarRemitoSobrante);
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/sigue figurando vigente/i);
    expect(escrituras.filter(e => e.op === 'delete')).toHaveLength(0);
  });

  it('si el remito YA estaba anulado no lo vuelve a anular: sólo limpia acá', async () => {
    enIM(BORRADA, { ...REMITO_VIVO, anulada: true });
    const r = await llamar(descartarRemitoSobrante);
    expect(r.status).toBe(200);
    expect(r.body.ya_estaba_anulado).toBe(true);
    expect(m.anularComprobante).not.toHaveBeenCalled();
    expect(escrituras.filter(e => e.op === 'delete')).toHaveLength(1);
  });

  it('un vendedor no puede: esto anula comprobantes reales', async () => {
    const r = await llamar(descartarRemitoSobrante, { rol: 'vendedor' });
    expect(r.status).toBe(403);
    expect(m.anularComprobante).not.toHaveBeenCalled();
  });
});

describe('el remito está bien, falta la factura', () => {
  it('🔴 deja el pedido en factura_pendiente, sin factura y con el remito intacto', async () => {
    const r = await llamar(habilitarFacturaPendiente);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, remito: 77809, factura_anulada: 50695 });
    const up = escrituras.find(e => e.op === 'update' && e.tabla === 'presupuestos_facturados')!;
    expect(up.valor).toMatchObject({
      im_factura_id: null, im_factura_numero: null, facturado_at: null, estado_emision: 'factura_pendiente',
    });
    // El remito no se toca: es lo único que respalda la mercadería que ya salió.
    expect(up.valor).not.toHaveProperty('im_remito_id');
    // Y el número de la factura muerta queda anotado.
    expect(up.valor.historial_facturas).toEqual([
      { id: 'fa-muerta', numero: 50695, tipo: 'FA B', motivo: 'anulada en IM' },
    ]);
  });

  it('🔴 NO emite nada: lo irreversible pasa por Facturar, con su reclamo', async () => {
    await llamar(habilitarFacturaPendiente);
    expect(m.anularComprobante).not.toHaveBeenCalled();
  });

  /**
   * 🔴 Con el remito anulado esto emitiría una factura sin mercadería que la respalde, y encima
   * cerraría el pedido como completo.
   */
  it('🔴 rechaza si el remito ya no está vigente', async () => {
    enIM(BORRADA, { ...REMITO_VIVO, anulada: true });
    const r = await llamar(habilitarFacturaPendiente);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/no corresponde/);
    expect(escrituras.filter(e => e.op === 'update')).toHaveLength(0);
  });

  /**
   * 🔴 Es literalmente el caso de BUSTOS: dos clientes con el mismo apellido. Engancharle a una
   * factura el remito de otro cliente es darle a uno la mercadería del otro.
   */
  it('🔴 rechaza si el remito es de otro cliente', async () => {
    enIM(BORRADA, { ...REMITO_VIVO, cod_cliente: 124 });
    const r = await llamar(habilitarFacturaPendiente);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/cliente 124/);
    expect(escrituras.filter(e => e.op === 'update')).toHaveLength(0);
  });

  it('🪤 rechaza si la factura registrada sigue viva: no hay nada que rehacer', async () => {
    enIM({ existe: true, anulada: false, numero: 50695 });
    const r = await llamar(habilitarFacturaPendiente);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/VIGENTE/);
  });

  it('🪤 si alguien lo resolvió mientras tanto, no pisa nada', async () => {
    filasTocadas = [];
    const r = await llamar(habilitarFacturaPendiente);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/mientras tanto/i);
  });
});

describe('qué filas admite', () => {
  it('un pedido sin emisión registrada da 404', async () => {
    filas.presupuestos_facturados = { single: null };
    const r = await llamar(descartarRemitoSobrante);
    expect(r.status).toBe(404);
  });

  it('un pedido sano (completo) no se toca por ninguna de las dos vías', async () => {
    filas.presupuestos_facturados = { single: { ...FILA, estado_emision: 'completo', facturado_at: 'x' } };
    for (const fn of [descartarRemitoSobrante, habilitarFacturaPendiente]) {
      const r = await llamar(fn);
      expect(r.status).toBe(409);
    }
    expect(m.anularComprobante).not.toHaveBeenCalled();
  });

  /**
   * 🪤 LA VENTANA ENTRE EL DEPLOY Y LA MIGRACIÓN. Verificado contra la base de producción el
   * 22/09/2026: con la 051 sin aplicar, el select con `historial_facturas` devuelve 42703 y el
   * mismo select sin ella trae la fila. Sin la relectura, descartar un remito —que ni usa esa
   * columna— fallaba con un error de Postgres.
   */
  it('🪤 sin la migración 051 todavía se puede descartar un remito', async () => {
    columnaQueFalta = 'historial_facturas';
    filas.hojas_ruta_pedidos = { single: null };
    let vecesRemito = 0;
    m.cabeceraComprobante.mockImplementation(async (id: string) => {
      if (String(id) === 'fa-muerta') return BORRADA;
      return ++vecesRemito === 1 ? REMITO_VIVO : { ...REMITO_VIVO, anulada: true };
    });
    const r = await llamar(descartarRemitoSobrante);
    expect(r.status).toBe(200);
    expect(m.anularComprobante).toHaveBeenCalled();
    // Pidió los campos completos, se topó con la columna que falta y releyó sin ella.
    expect(selects[0]).toContain('historial_facturas');
    expect(selects[1]).not.toContain('historial_facturas');
  });

  it('sin remito registrado no hay nada que conciliar', async () => {
    filas.presupuestos_facturados = { single: { ...FILA, im_remito_id: null, im_remito_numero: null } };
    const r = await llamar(descartarRemitoSobrante);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/no tiene un remito/i);
  });

  /**
   * 🪤 Si el remito se anula DESPUÉS de que alguien dijo "el remito está bien", el pedido queda
   * en `factura_pendiente` con un remito muerto. La emisión lo frena, pero sin esto no habría
   * forma de destrabarlo desde la app.
   */
  it('🪤 un pedido en factura_pendiente se puede seguir destrabando', async () => {
    filas.presupuestos_facturados = { single: { ...FILA, estado_emision: 'factura_pendiente', im_factura_id: null, im_factura_numero: null } };
    enIM(BORRADA, { ...REMITO_VIVO, anulada: true });
    const r = await llamar(descartarRemitoSobrante);
    expect(r.status).toBe(200);
    expect(r.body.ya_estaba_anulado).toBe(true);
  });
});
