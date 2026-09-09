import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * La etapa 1 del circuito: la revisión de Jorgelina. Lo que se prueba acá es lo que, si falla,
 * deja pasar a facturación un pedido que no estaba aprobado, o toca en InfoManager un
 * comprobante que ya no se puede tocar.
 */

vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });

const m = vi.hoisted(() => ({
  sbMock: vi.fn(),
  vistaDeRango: vi.fn(),
  actualizarPresupuestoCantidades: vi.fn(),
  fetchVentasItems: vi.fn(),
  getItemsComprobante: vi.fn(),
  cabeceraComprobante: vi.fn(),
}));

vi.mock('./infomanager.js', () => ({
  fechaArgentina: (t?: number) => (t ? new Date(t).toISOString().slice(0, 10) : '2026-09-08'),
  fetchArticulosCatalogo: vi.fn(async () => new Map([[1, { descripcion: 'MEZCLA FINA', unidad_de_medida: 'KG', equivalencia_um: 1 }]])),
  fetchVentasItems: m.fetchVentasItems,
  getItemsComprobante: m.getItemsComprobante,
  cabeceraComprobante: m.cabeceraComprobante,
  actualizarPresupuestoCantidades: m.actualizarPresupuestoCantidades,
}));
vi.mock('./vistaPresupuestos.js', () => ({ vistaDeRango: m.vistaDeRango, invalidarVista: vi.fn() }));
vi.mock('./supabase.js', () => ({ sb: m.sbMock, TENANT_ID: 'test-tenant', hasSupabase: () => true }));

const {
  listarPresupuestos, revisarPresupuesto, corregirCantidades, fraccionadoDelRango,
} = await import('./panelPresupuestos.js');

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
        delete: () => { escrituras.push({ tabla: t, op: 'delete', valor: null }); return q; },
      };
      for (const k of ['select', 'eq', 'in', 'order', 'limit', 'is']) q[k] = () => q;
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

const VISTA_VACIA = {
  pendientes: [], asignados: [], con_avisos: 0, pierde_margen: 0, cobra_de_mas: 0,
  sin_zona: 0, de_otros_dias: 0, sin_revisar: 0, aprobados: 0, observados: 0,
};

beforeEach(() => {
  tablas = {}; escrituras = [];
  vi.clearAllMocks();
  fakeSb();
  m.vistaDeRango.mockResolvedValue(VISTA_VACIA);
  m.actualizarPresupuestoCantidades.mockResolvedValue({ ok: true });
});

describe('el rango de fechas', () => {
  it('🔴 Jorgelina mira varios días, no uno: el rango va tal cual', async () => {
    // Mati: "el filtro de fecha tiene que ser por rangos, ya que Jorgelina ve franjas de
    // varios días para el armado de los pedidos".
    await llamar(listarPresupuestos, { query: { desde: '2026-09-01', hasta: '2026-09-08' } });
    expect(m.vistaDeRango).toHaveBeenCalledWith('2026-09-01', '2026-09-08', false);
  });

  it('🔴 un rango larguísimo se acota: 15 días de renglones son 23 s y la pantalla no abre', async () => {
    await llamar(listarPresupuestos, { query: { desde: '2025-01-01', hasta: '2026-09-08' } });
    const [desde] = m.vistaDeRango.mock.calls[0] as any[];
    expect(desde).toBe('2026-08-08');            // 31 días para atrás, no un año y medio
  });

  it('sin fechas mira el día de hoy', async () => {
    await llamar(listarPresupuestos, {});
    expect(m.vistaDeRango).toHaveBeenCalledWith('2026-09-08', '2026-09-08', false);
  });

  it('un rango dado vuelta no rompe: se toma el día final', async () => {
    await llamar(listarPresupuestos, { query: { desde: '2026-09-08', hasta: '2026-09-01' } });
    expect(m.vistaDeRango).toHaveBeenCalledWith('2026-09-01', '2026-09-01', false);
  });
});

describe('aprobar u observar', () => {
  it('🔴 aprobar deja registro de quién y cuándo: es lo que habilita a facturar', async () => {
    tablas['presupuestos_revision'] = { data: null, error: null };
    const r = await llamar(revisarPresupuesto, {
      params: { comprobanteId: '58700637' }, body: { estado: 'aprobado', im_numero: 58050, cod_cliente: 1093 },
    });
    expect(r.status).toBe(200);
    const fila = escrituras.find(e => e.tabla === 'presupuestos_revision')!.valor;
    expect(fila).toMatchObject({ im_comprobante_id: '58700637', estado: 'aprobado', revisado_por: 'u1' });
    expect(fila.revisado_at).toBeTruthy();
  });

  it('🔴 "observado" sin motivo no se guarda', async () => {
    // Al día siguiente nadie se acuerda por qué estaba frenado.
    const r = await llamar(revisarPresupuesto, { params: { comprobanteId: '1' }, body: { estado: 'observado' } });
    expect(r.status).toBe(400);
    expect(escrituras).toHaveLength(0);
  });

  it('observado con motivo sí', async () => {
    tablas['presupuestos_revision'] = { data: null, error: null };
    const r = await llamar(revisarPresupuesto, {
      params: { comprobanteId: '1' }, body: { estado: 'observado', observacion: 'Falta stock de avena' },
    });
    expect(r.status).toBe(200);
    expect(escrituras[0].valor.observacion).toBe('Falta stock de avena');
  });

  it('un estado inventado se rechaza', async () => {
    const r = await llamar(revisarPresupuesto, { params: { comprobanteId: '1' }, body: { estado: 'listo' } });
    expect(r.status).toBe(400);
  });

  it('🔴 un vendedor no revisa presupuestos', async () => {
    const r = await llamar(revisarPresupuesto, { rol: 'vendedor', params: { comprobanteId: '1' }, body: { estado: 'aprobado' } });
    expect(r.status).toBe(403);
  });
});

describe('corregir cantidades desde el panel', () => {
  it('🔴 un presupuesto YA FACTURADO no se toca', async () => {
    // La factura quedaría diciendo otra cosa que el pedido. Eso se arregla con una NC, no
    // editando el comprobante de origen.
    // 📌 Se mira `presupuestos_facturados`: en el circuito nuevo la hoja se arma DESPUÉS de
    // facturar, así que mirar `hojas_ruta_pedidos` no frenaba nada (auditoría del 08/09/2026).
    tablas['presupuestos_facturados'] = { data: { im_factura_numero: 50360, facturado_at: '2026-09-08T12:00:00Z' }, error: null };
    const r = await llamar(corregirCantidades, {
      params: { comprobanteId: '58700637' }, body: { items: [{ id: 9, cantidad: 5 }] },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/50360/);
    expect(m.actualizarPresupuestoCantidades).not.toHaveBeenCalled();
  });

  it('🔴 sin facturar, el cambio va a InfoManager', async () => {
    tablas['presupuestos_facturados'] = { data: null, error: null };
    const r = await llamar(corregirCantidades, {
      params: { comprobanteId: '58700637' }, body: { items: [{ id: 9, cantidad: 5 }, { id: 10, cantidad: 2 }] },
    });
    expect(r.status).toBe(200);
    expect(m.actualizarPresupuestoCantidades).toHaveBeenCalledWith('58700637', [{ id: 9, cantidad: 5 }, { id: 10, cantidad: 2 }]);
  });

  it('🔴 una cantidad en cero o negativa no llega a IM', async () => {
    tablas['presupuestos_facturados'] = { data: null, error: null };
    const r = await llamar(corregirCantidades, {
      params: { comprobanteId: '1' }, body: { items: [{ id: 9, cantidad: 0 }, { id: 10, cantidad: -3 }] },
    });
    expect(r.status).toBe(400);
    expect(m.actualizarPresupuestoCantidades).not.toHaveBeenCalled();
  });

  it('🔴 corregir cantidades tira abajo la aprobación: era sobre otras cantidades', async () => {
    tablas['presupuestos_facturados'] = { data: null, error: null };
    const r = await llamar(corregirCantidades, {
      params: { comprobanteId: '58700637' }, body: { items: [{ id: 9, cantidad: 5 }] },
    });
    expect(r.status).toBe(200);
    expect(escrituras.some(e => e.tabla === 'presupuestos_revision' && e.op === 'delete')).toBe(true);
  });

  it('si IM rechaza, se dice qué contestó', async () => {
    tablas['presupuestos_facturados'] = { data: null, error: null };
    m.actualizarPresupuestoCantidades.mockResolvedValue({ ok: false, error: 'Talonario cerrado' });
    const r = await llamar(corregirCantidades, { params: { comprobanteId: '1' }, body: { items: [{ id: 9, cantidad: 5 }] } });
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/Talonario cerrado/);
  });
});

describe('el listado de fraccionado', () => {
  const APROBADO = { im_comprobante_id: '10', fecha: '2026-09-08', revision: { estado: 'aprobado' } };
  const SIN_REVISAR = { im_comprobante_id: '20', fecha: '2026-09-08', revision: null };

  it('🔴 sale de lo APROBADO: no se fracciona lo que todavía no se revisó', async () => {
    m.vistaDeRango.mockResolvedValue({ ...VISTA_VACIA, pendientes: [APROBADO, SIN_REVISAR] });
    m.fetchVentasItems.mockResolvedValue([
      { id_comprobante: '10', cod_articulo: 1, cantidad: 30 },
      { id_comprobante: '20', cod_articulo: 1, cantidad: 999 },
    ]);

    const r = await llamar(fraccionadoDelRango, { query: { desde: '2026-09-08', hasta: '2026-09-08' } });

    expect(r.body.comprobantes).toBe(1);
    // 🔄 Desde el 09/09/2026 cada renglón se parte en paquetes de 10 kg como máximo (Mati: "no
    // se fracciona más de 10 kilos"). Sin formato de bolsa conocido, 30 kg son tres paquetes.
    expect(r.body.fraccionado[0]).toMatchObject({ descripcion: 'MEZCLA FINA', cantidades: [10, 10, 10] });
  });

  it('con ?todos=1 se ve todo, para adelantar trabajo antes de terminar la revisión', async () => {
    m.vistaDeRango.mockResolvedValue({ ...VISTA_VACIA, pendientes: [APROBADO, SIN_REVISAR] });
    m.fetchVentasItems.mockResolvedValue([
      { id_comprobante: '10', cod_articulo: 1, cantidad: 30 },
      { id_comprobante: '20', cod_articulo: 1, cantidad: 20 },
    ]);
    const r = await llamar(fraccionadoDelRango, { query: { todos: '1' } });
    expect(r.body.comprobantes).toBe(2);
    expect(r.body.fraccionado[0].cantidades).toEqual([10, 10, 10, 10, 10])   // 30 y 20 kg, en paquetes de 10 (regla del 09/09/2026);
  });

  it('sin nada aprobado devuelve vacío sin salir a pedirle renglones a IM', async () => {
    m.vistaDeRango.mockResolvedValue({ ...VISTA_VACIA, pendientes: [SIN_REVISAR] });
    const r = await llamar(fraccionadoDelRango, {});
    expect(r.body.fraccionado).toEqual([]);
    expect(m.fetchVentasItems).not.toHaveBeenCalled();
  });
});

/**
 * 🔑 Sacar un producto del presupuesto sin salir del panel (Mati, 08/09/2026).
 *
 * La API de IM no tiene un "borrar renglón", pero `cantidad: 0` **sí funciona y recalcula el
 * total** (probado contra IM real el 04/09/2026: 81.185,40 → 59.543,16). El renglón queda a la
 * vista con cantidad 0, que además es mejor que desaparecer: se ve que se sacó a propósito.
 */
describe('sacar un producto del presupuesto', () => {
  beforeEach(() => {
    tablas['presupuestos_facturados'] = { data: null, error: null };
    m.actualizarPresupuestoCantidades.mockResolvedValue({ ok: true });
    // El presupuesto tiene DOS renglones: se puede sacar uno.
    m.getItemsComprobante.mockResolvedValue([
      { id: 101, cod_articulo: 1, cantidad: 10 },
      { id: 102, cod_articulo: 2, cantidad: 5 },
    ]);
  });

  it('🔑 cantidad 0 da de baja el renglón', async () => {
    const r = await llamar(corregirCantidades, {
      params: { comprobanteId: '58700637' },
      body: { items: [{ id: 101, cantidad: 0 }] },
    });
    expect(r.status).toBe(200);
    expect(m.actualizarPresupuestoCantidades).toHaveBeenCalledWith('58700637', [{ id: 101, cantidad: 0 }]);
    expect(r.body.dados_de_baja).toBe(1);
  });

  it('🔴 no se puede vaciar el presupuesto entero: quedaría facturándose por $0', async () => {
    const r = await llamar(corregirCantidades, {
      params: { comprobanteId: '58700637' },
      body: { items: [{ id: 101, cantidad: 0 }, { id: 102, cantidad: 0 }] },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/vac|todos/i);
    expect(m.actualizarPresupuestoCantidades).not.toHaveBeenCalled();
  });

  it('🔴 si no se puede leer el presupuesto en IM, no se da de baja nada a ciegas', async () => {
    m.getItemsComprobante.mockRejectedValue(new Error('timeout'));
    const r = await llamar(corregirCantidades, {
      params: { comprobanteId: '58700637' },
      body: { items: [{ id: 101, cantidad: 0 }] },
    });
    expect(r.status).toBe(502);
    expect(m.actualizarPresupuestoCantidades).not.toHaveBeenCalled();
  });

  it('cambiar cantidades sin ningún cero no consulta los renglones: es el camino de siempre', async () => {
    const r = await llamar(corregirCantidades, {
      params: { comprobanteId: '58700637' },
      body: { items: [{ id: 101, cantidad: 8 }] },
    });
    expect(r.status).toBe(200);
    expect(m.getItemsComprobante).not.toHaveBeenCalled();
  });

  it('una cantidad negativa sigue sin pasar', async () => {
    const r = await llamar(corregirCantidades, {
      params: { comprobanteId: '58700637' },
      body: { items: [{ id: 101, cantidad: -3 }] },
    });
    expect(r.status).toBe(400);
  });
});
