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
  fetchVentas: vi.fn(async () => [] as any[]),
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
  fetchVentas: m.fetchVentas,
  fetchVentasItems: m.fetchVentasItems,
  fetchArticulosCatalogo: vi.fn(async () => new Map()),
  // El remito valida stock: la preparación lo consulta para avisar antes de facturar.
  fetchStockPorDeposito: vi.fn(async () => new Map()),
  // Se pide con los códigos de lo que se factura: un cliente nuevo no está cacheado.
  fetchClientesIMCon: m.fetchClientesIMCached,
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

const { facturarSeleccion, previsualizarFacturacion, tableroFacturacion, liberarReclamo, prepararFacturacion, articulosSinStockDelError } = await import('./facturarPresupuestos.js');

let tablas: Record<string, any> = {};
let escrituras: Array<{ tabla: string; op: string; valor: any }> = [];
/** Si está seteado, TODA escritura contesta este error (Supabase no tira: devuelve `{error}`). */
let errorAlEscribir: any = null;
/** Si está seteado, el reclamo previo a emitir choca: otro usuario lo tomó primero. */
let errorAlReclamar: any = null;

function fakeSb() {
  m.sbMock.mockImplementation(() => ({
    from: (t: string) => {
      const res = tablas[t] ?? { data: null, error: null };
      const q: any = {
        then: (r: any, j: any) => Promise.resolve(res).then(r, j),
        maybeSingle: () => Promise.resolve(res),
        upsert: (v: any) => {
          escrituras.push({ tabla: t, op: 'upsert', valor: v });
          return errorAlEscribir
            ? { ...q, then: (r: any, j: any) => Promise.resolve({ data: null, error: errorAlEscribir }).then(r, j) }
            : q;
        },
        // El "reclamo" que se escribe ANTES de emitir: con `errorAlReclamar` se simula que otro
        // usuario lo tomó primero (el índice único de la tabla lo rechaza).
        insert: (v: any) => {
          escrituras.push({ tabla: t, op: 'insert', valor: v });
          return errorAlReclamar
            ? { ...q, then: (r: any, j: any) => Promise.resolve({ data: null, error: errorAlReclamar }).then(r, j) }
            : q;
        },
        update: (v: any) => { escrituras.push({ tabla: t, op: 'update', valor: v }); return q; },
        delete: () => { escrituras.push({ tabla: t, op: 'delete', valor: null }); return q; },
      };
      for (const k of ['select', 'eq', 'in', 'order', 'limit', 'is', 'not', 'or']) q[k] = () => q;
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
  tablas = {}; escrituras = []; errorAlEscribir = null; errorAlReclamar = null;
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
    const guardadas = escrituras.filter(e => e.tabla === 'presupuestos_facturados' && e.op === 'upsert');
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

/**
 * Hallazgos de la auditoría del 08/09/2026. Supabase NO tira excepción cuando una consulta
 * falla: devuelve `{ data: null, error }`. Ignorar ese `error` convierte "no pude preguntar" en
 * "nadie está facturado", que es la receta exacta para emitir dos veces.
 */
describe('cuando la base no contesta', () => {
  it('🔴 si no se puede leer lo ya facturado, NO se emite nada', async () => {
    // Sin esa lectura no se sabe qué ya salió. Emitir a ciegas duplica facturas.
    tablas['presupuestos_facturados'] = { data: null, error: { message: 'timeout' } };
    const r = await llamar(facturarSeleccion, { body: { ids: ['10'] } });
    expect(r.status).toBe(502);
    expect(m.emitirFactura).not.toHaveBeenCalled();
    expect(m.emitirRemito).not.toHaveBeenCalled();
  });

  it('🔴 si no se puede REGISTRAR la factura emitida, se frena la tanda y se dice el número', async () => {
    // La factura ya salió en IM. Si nadie la registra, mañana el presupuesto figura pendiente y
    // alguien la vuelve a emitir. Se corta y el mensaje lleva el número para poder buscarla.
    m.vistaDeRango.mockResolvedValue({
      ...VISTA_BASE,
      pendientes: [presu(), presu({ im_comprobante_id: '20', cod_cliente: 500 })],
    });
    m.fetchVentasItems.mockResolvedValue([RENGLON, { ...RENGLON, id_comprobante: '20' }]);
    errorAlEscribir = { message: 'connection reset' };

    const r = await llamar(facturarSeleccion, { body: { ids: ['10', '20'] } });

    expect(m.emitirFactura).toHaveBeenCalledTimes(1);          // no siguió con el segundo
    expect(r.body.cortado).toMatch(/50360/);                   // el número de la factura que salió
    expect(r.body.ok).toBe(false);
  });

  it('🔴 y tampoco sigue si falla el registro del remito', async () => {
    tablas['presupuestos_facturados'] = { data: [], error: null };
    errorAlEscribir = null;
    let upserts = 0;
    m.sbMock.mockImplementation(() => ({
      from: () => {
        const q: any = {
          then: (r: any, j: any) => Promise.resolve({ data: [], error: null }).then(r, j),
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
          insert: () => q,                     // el reclamo entra bien
          delete: () => q,
          upsert: () => {
            upserts += 1;   // el primero (factura) pasa; el segundo (remito) falla
            const res = upserts >= 2 ? { data: null, error: { message: 'boom' } } : { data: null, error: null };
            return { ...q, then: (r: any, j: any) => Promise.resolve(res).then(r, j) };
          },
        };
        for (const k of ['select', 'eq', 'in', 'order', 'limit', 'is', 'not', 'or']) q[k] = () => q;
        return q;
      },
    }));

    const r = await llamar(facturarSeleccion, { body: { ids: ['10'] } });

    expect(r.body.cortado).toMatch(/77291|remito/i);
    expect(r.body.ok).toBe(false);
  });
});

describe('cuando InfoManager no contesta la cabecera', () => {
  it('🔴 "no pude preguntar si está anulado" NO es "está vigente"', async () => {
    // `cabeceraComprobante` devuelve null en los tres campos cuando IM falla. La oficina anula
    // presupuestos en IM todo el tiempo: emitir sin poder verificarlo deja una factura sin
    // respaldo.
    m.cabeceraComprobante.mockResolvedValue({ fecha: null, anulada: null, existe: null });
    const r = await llamar(facturarSeleccion, { body: { ids: ['10'] } });
    expect(m.emitirFactura).not.toHaveBeenCalled();
    expect(r.body.fallados[0]).toMatch(/verificar|InfoManager/i);
  });
});

describe('tandas grandes', () => {
  it('🔴 más de 400 pedidos se rechaza en vez de truncar la consulta', async () => {
    // La consulta de lo ya facturado se corta en 400: los de más allá volverían como "sin
    // facturar" y se re-emitirían.
    const ids = Array.from({ length: 401 }, (_, i) => String(i + 1));
    const r = await llamar(facturarSeleccion, { body: { ids } });
    expect(r.status).toBe(400);
    expect(m.emitirFactura).not.toHaveBeenCalled();
  });
});

describe('dos personas facturando a la vez', () => {
  it('🔴 el segundo que llega NO emite: el reclamo choca contra el índice único', async () => {
    // El rol administrativo lo tienen dos personas. Sin esto, las dos leen "no está facturado"
    // y las dos emiten la misma factura.
    errorAlReclamar = { code: '23505', message: 'duplicate key value violates unique constraint' };
    const r = await llamar(facturarSeleccion, { body: { ids: ['10'] } });
    expect(m.emitirFactura).not.toHaveBeenCalled();
    expect(r.body.fallados[0]).toMatch(/otro usuario|actualizá/i);
  });

  it('🔴 el reclamo se escribe ANTES de llamar a InfoManager', async () => {
    await llamar(facturarSeleccion, { body: { ids: ['10'] } });
    const orden = escrituras.map(e => e.op);
    expect(orden[0]).toBe('insert');                       // primero se reclama
    expect(m.emitirFactura).toHaveBeenCalled();            // y recién después se emite
  });
});

/**
 * Verificación adversarial del 08/09/2026: el reclamo tenía dos agujeros. Un `update` no choca
 * contra ningún índice único, así que "retomar" un reclamo vencido dejaba pasar a dos personas
 * a la vez; y el reintento de sólo-remito no reclamaba nada.
 */
describe('reclamos que quedaron a medias', () => {
  const RECLAMO_VIEJO = { im_comprobante_id: '10', im_factura_id: null, im_factura_numero: null, facturado_at: null, reclamado_at: '2026-09-08T00:00:00Z' };

  it('🔴 un reclamo vencido NO se retoma solo: puede que la factura haya salido igual', async () => {
    // Desde afuera, "se cortó antes de emitir" y "se emitió y no se pudo registrar" son
    // idénticos. Reanudar automáticamente es apostar a que fue el primero.
    tablas['presupuestos_facturados'] = { data: [RECLAMO_VIEJO], error: null };
    const r = await llamar(facturarSeleccion, { body: { ids: ['10'] } });
    expect(m.emitirFactura).not.toHaveBeenCalled();
    expect(r.body.fallados[0]).toMatch(/intento anterior|InfoManager/i);
  });

  it('🔴 y uno FRESCO tampoco: lo está facturando otro en este momento', async () => {
    tablas['presupuestos_facturados'] = { data: [{ ...RECLAMO_VIEJO, reclamado_at: new Date().toISOString() }], error: null };
    const r = await llamar(facturarSeleccion, { body: { ids: ['10'] } });
    expect(m.emitirFactura).not.toHaveBeenCalled();
    expect(r.body.fallados[0]).toMatch(/alguien más/i);
  });

  it('🔴 el reintento de SÓLO REMITO también reclama: dos remitos descuentan stock dos veces', async () => {
    tablas['presupuestos_facturados'] = {
      data: [{ im_comprobante_id: '10', im_factura_id: 'f1', im_factura_numero: 50360, facturado_at: null, reclamado_at: new Date().toISOString() }],
      error: null,
    };
    const r = await llamar(facturarSeleccion, { body: { ids: ['10'] } });
    expect(m.emitirRemito).not.toHaveBeenCalled();
    expect(r.body.fallados[0]).toMatch(/remito.*alguien más/i);
  });

  it('con el reclamo del remito ya vencido, se hace el remito', async () => {
    tablas['presupuestos_facturados'] = {
      data: [{ im_comprobante_id: '10', im_factura_id: 'f1', im_factura_numero: 50360, facturado_at: null, reclamado_at: '2026-09-08T00:00:00Z' }],
      error: null,
    };
    const r = await llamar(facturarSeleccion, { body: { ids: ['10'] } });
    expect(m.emitirFactura).not.toHaveBeenCalled();     // la factura ya estaba
    expect(m.emitirRemito).toHaveBeenCalledTimes(1);
    expect(r.body.facturados).toBe(1);
  });
});

describe('liberar un intento a medias', () => {
  it('🔴 sólo libera lo que NO tiene comprobantes registrados', async () => {
    tablas['presupuestos_facturados'] = { data: [], error: null };   // el filtro no devolvió nada
    const r = await llamar(liberarReclamo, { body: {} });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/ya tiene comprobantes/i);
  });

  it('libera el reclamo huérfano', async () => {
    tablas['presupuestos_facturados'] = { data: [{ im_comprobante_id: '10' }], error: null };
    const r = await llamar(liberarReclamo, { body: {} });
    expect(r.status).toBe(200);
    expect(escrituras.some(e => e.op === 'delete')).toBe(true);
  });

  it('🔴 un vendedor no libera nada', async () => {
    expect((await llamar(liberarReclamo, { rol: 'vendedor' })).status).toBe(403);
  });
});

describe('no facturar dos veces lo mismo', () => {
  /**
   * 🔴 El 09/09/2026 Mati facturó a propósito desde el panel un presupuesto que YA estaba
   * facturado en InfoManager: **se emitió una segunda factura real** (la 50401, que hubo que
   * borrar a mano). El remito falló después porque el stock ya estaba descontado, pero la
   * factura ya había salido.
   *
   * 🪤 IM no marca el presupuesto al facturarlo — medido ese día: los 35 presupuestos con
   * factura y los 23 sin ella están todos en `tipo_presupuesto: 'C'`. Se deduce comparando
   * contra las facturas reales: mismo cliente, mismo importe.
   */
  it('🔴 un presupuesto que ya tiene factura en IM no se factura de nuevo', async () => {
    tablas['presupuestos_facturados'] = { data: [], error: null };
    m.cabeceraComprobante.mockResolvedValue({ fecha: '2026-09-08', anulada: false, existe: true, observaciones: null });
    m.fetchClientesIMCached.mockResolvedValue([{ cod_cliente: 297, categoria_iva: 'CF' }]);
    m.fetchVentasItems.mockResolvedValue([{ id_comprobante: '58727292', cod_articulo: 1, cantidad: 1, precio: 155430.72 }]);
    // La factura que ya existe en InfoManager, del mismo cliente y por el mismo importe.
    m.fetchVentas.mockResolvedValue([
      { id: 'f-vieja', numero: 50370, cod_cliente: 297, total: 155430.72, tipo_factura: 'B',
        tipo_comprobante: 'FA', anulada: 'N', fecha: '2026-09-09' },
    ]);

    const r = await prepararFacturacion(
      [{ im_comprobante_id: '58727292', im_numero: 58158, cod_cliente: 297,
         cliente_nombre: 'FORRAJERIA El Parque', total: 155430.72, fecha: '2026-09-08' } as any],
      'jorgelina',
    );
    expect(r[0].estado).toBe('no_se_puede');
    expect(r[0].motivo).toMatch(/YA ESTÁ FACTURADO/i);
    expect(r[0].motivo).toMatch(/50370/);
  });

  it('sin factura que le calce, se factura normalmente', async () => {
    tablas['presupuestos_facturados'] = { data: [], error: null };
    m.cabeceraComprobante.mockResolvedValue({ fecha: '2026-09-08', anulada: false, existe: true, observaciones: null });
    m.fetchClientesIMCached.mockResolvedValue([{ cod_cliente: 297, categoria_iva: 'CF' }]);
    m.fetchVentasItems.mockResolvedValue([{ id_comprobante: '58727292', cod_articulo: 1, cantidad: 1, precio: 155430.72 }]);
    // Una factura de OTRO cliente: no tiene nada que ver.
    m.fetchVentas.mockResolvedValue([
      { id: 'f-otra', numero: 50370, cod_cliente: 999, total: 155430.72, tipo_factura: 'B',
        tipo_comprobante: 'FA', anulada: 'N', fecha: '2026-09-09' },
    ]);
    const r = await prepararFacturacion(
      [{ im_comprobante_id: '58727292', im_numero: 58158, cod_cliente: 297,
         cliente_nombre: 'FORRAJERIA El Parque', total: 155430.72, fecha: '2026-09-08' } as any],
      'jorgelina',
    );
    expect(r[0].estado).toBe('listo');
  });

  it('🪤 una factura ANULADA no cuenta: ésa justamente hay que rehacerla', async () => {
    tablas['presupuestos_facturados'] = { data: [], error: null };
    m.cabeceraComprobante.mockResolvedValue({ fecha: '2026-09-08', anulada: false, existe: true, observaciones: null });
    m.fetchClientesIMCached.mockResolvedValue([{ cod_cliente: 297, categoria_iva: 'CF' }]);
    m.fetchVentasItems.mockResolvedValue([{ id_comprobante: '58727292', cod_articulo: 1, cantidad: 1, precio: 155430.72 }]);
    m.fetchVentas.mockResolvedValue([
      { id: 'f-anulada', numero: 50401, cod_cliente: 297, total: 155430.72, tipo_factura: 'B',
        tipo_comprobante: 'FA', anulada: 'S', fecha: '2026-09-09' },
    ]);
    const r = await prepararFacturacion(
      [{ im_comprobante_id: '58727292', im_numero: 58158, cod_cliente: 297,
         cliente_nombre: 'FORRAJERIA El Parque', total: 155430.72, fecha: '2026-09-08' } as any],
      'jorgelina',
    );
    expect(r[0].estado).toBe('listo');
  });
});

describe('el descuento no se puede aplicar dos veces', () => {
  /**
   * 🔴 El 09/09/2026 la factura 50401 de BIANCONI salió por $514.237,59 cuando el presupuesto
   * era de $587.301,97: **$73.064 de menos**. `/ventas/items` devuelve `precio` YA NETO y
   * nosotros lo reenviábamos junto con `descuento_porc`, así que IM lo descontaba otra vez.
   *
   * El remito lo detectó ("el total del comprobante no coincide con el total calculado según los
   * ítems") porque `/remitos` sí valida; `/ventas` no valida y emitió mal en silencio.
   */
  it('🔴 con descuento se manda el precio BRUTO, no el neto', async () => {
    tablas['presupuestos_facturados'] = { data: [], error: null };
    m.cabeceraComprobante.mockResolvedValue({ fecha: '2026-09-09', anulada: false, existe: true, observaciones: null });
    m.fetchClientesIMCached.mockResolvedValue([{ cod_cliente: 233, categoria_iva: 'CF' }]);
    m.fetchVentas.mockResolvedValue([]);
    // Los números reales del PR 58288: bruto 22473.67, 35% de descuento, neto 14607.8855.
    m.fetchVentasItems.mockResolvedValue([{
      id_comprobante: '58777277', cod_articulo: 320, cantidad: 4,
      precio: 14607.8855, precio_orig: 22473.67, descuento_porc: 35, iva_por: 0,
    }]);
    const r = await prepararFacturacion(
      [{ im_comprobante_id: '58777277', im_numero: 58288, cod_cliente: 233,
         cliente_nombre: 'BIANCONI, Paola', total: 58431.542, fecha: '2026-09-09' } as any],
      'jorgelina',
    );
    expect(r[0].estado).toBe('listo');
    // 22473.67 × 4 × 0,65 = 58.431,54, que es el total del renglón en el presupuesto.
    expect(r[0].datos!.items[0]).toMatchObject({ precio: 22473.67, descuento_porc: 35 });
  });

  it('sin descuento, el precio va tal cual', async () => {
    tablas['presupuestos_facturados'] = { data: [], error: null };
    m.cabeceraComprobante.mockResolvedValue({ fecha: '2026-09-09', anulada: false, existe: true, observaciones: null });
    m.fetchClientesIMCached.mockResolvedValue([{ cod_cliente: 233, categoria_iva: 'CF' }]);
    m.fetchVentas.mockResolvedValue([]);
    m.fetchVentasItems.mockResolvedValue([{
      id_comprobante: '58777277', cod_articulo: 165, cantidad: 15,
      precio: 10924.15, precio_orig: 10924.15, descuento_porc: 0, iva_por: 0,
    }]);
    const r = await prepararFacturacion(
      [{ im_comprobante_id: '58777277', im_numero: 58288, cod_cliente: 233,
         cliente_nombre: 'BIANCONI, Paola', total: 163862.25, fecha: '2026-09-09' } as any],
      'jorgelina',
    );
    expect(r[0].datos!.items[0]).toMatchObject({ precio: 10924.15, descuento_porc: null });
  });

  it('🪤 si IM no manda `precio_orig`, se usa el neto: es mejor que mandar cero', async () => {
    tablas['presupuestos_facturados'] = { data: [], error: null };
    m.cabeceraComprobante.mockResolvedValue({ fecha: '2026-09-09', anulada: false, existe: true, observaciones: null });
    m.fetchClientesIMCached.mockResolvedValue([{ cod_cliente: 233, categoria_iva: 'CF' }]);
    m.fetchVentas.mockResolvedValue([]);
    m.fetchVentasItems.mockResolvedValue([{
      id_comprobante: '58777277', cod_articulo: 320, cantidad: 1,
      precio: 100, descuento_porc: 10, iva_por: 0,
    }]);
    const r = await prepararFacturacion(
      [{ im_comprobante_id: '58777277', im_numero: 58288, cod_cliente: 233,
         cliente_nombre: 'X', total: 100, fecha: '2026-09-09' } as any],
      'jorgelina',
    );
    expect(r[0].datos!.items[0].precio).toBe(100);
  });
});


describe('el remito falla por stock (09/09/2026)', () => {
  /**
   * 🔴 `POST /remitos` VALIDA STOCK y la factura no. Verificado contra IM con el pedido de
   * Carrizo, que quedó con la factura 50402 emitida y sin remito: InfoManager contestó
   * *"Artículos sin stock suficiente: [{cod_articulo:470, cantidad:5, stock_disponible:-570}]"*.
   *
   * El JSON crudo en pantalla no le dice nada a Jorgelina: hay que nombrar el producto.
   */
  it('🔑 traduce el rechazo de IM al nombre del producto', () => {
    const cat = new Map([[470, { descripcion: 'MEZCLA P/PAJARO' }]]);
    const txt = articulosSinStockDelError(
      'HTTP 500: Validaciones: \n\n• No se puede crear el presupuesto. Artículos sin stock suficiente: [{"cod_articulo":470,"cantidad":5,"stock_disponible":-570.00000}]\n',
      cat as any);
    expect(txt).toBe('MEZCLA P/PAJARO (piden 5, hay -570)');
  });

  it('nombra todos los que rechazó, no sólo el primero', () => {
    const cat = new Map([[470, { descripcion: 'MEZCLA P/PAJARO' }], [1, { descripcion: 'ALPISTE' }]]);
    const txt = articulosSinStockDelError(
      'Artículos sin stock suficiente: [{"cod_articulo":470,"cantidad":5,"stock_disponible":-570},{"cod_articulo":1,"cantidad":2,"stock_disponible":0}]',
      cat as any);
    expect(txt).toBe('MEZCLA P/PAJARO (piden 5, hay -570) · ALPISTE (piden 2, hay 0)');
  });

  it('un artículo que no está en el catálogo igual se nombra por su código', () => {
    const txt = articulosSinStockDelError(
      'Artículos sin stock suficiente: [{"cod_articulo":9999,"cantidad":1,"stock_disponible":0}]',
      new Map() as any);
    expect(txt).toBe('artículo 9999 (piden 1, hay 0)');
  });

  /**
   * 🪤 Si el error es otro, devuelve null y quien llama muestra el mensaje crudo de IM. Inventar
   * una explicación de stock para un error que no es de stock manda a Jorgelina a mirar el
   * depósito por nada.
   */
  it('🔴 si el error NO es de stock devuelve null, no adivina', () => {
    expect(articulosSinStockDelError('HTTP 500: Talonario manual no válido', new Map() as any)).toBeNull();
    expect(articulosSinStockDelError('sin stock pero sin el detalle en JSON', new Map() as any)).toBeNull();
    expect(articulosSinStockDelError('Artículos sin stock suficiente: [roto', new Map() as any)).toBeNull();
  });
});
