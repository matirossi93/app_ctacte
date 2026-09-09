import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Editar un presupuesto desde el panel. De acá salen comprobantes REALES en InfoManager, así que
 * lo que se prueba es lo que, si falla, deja al cliente sin presupuesto o con dos vivos —y los
 * dos se pueden facturar.
 */

vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });

const m = vi.hoisted(() => ({
  sbMock: vi.fn(),
  cabeceraComprobante: vi.fn(),
  getItemsComprobante: vi.fn(),
  actualizarPresupuestoCantidades: vi.fn(),
  crearPresupuesto: vi.fn(),
  anularComprobante: vi.fn(),
}));

vi.mock('./infomanager.js', () => ({
  cabeceraComprobante: m.cabeceraComprobante,
  getItemsComprobante: m.getItemsComprobante,
  actualizarPresupuestoCantidades: m.actualizarPresupuestoCantidades,
  crearPresupuesto: m.crearPresupuesto,
  anularComprobante: m.anularComprobante,
  fetchArticulosCatalogo: vi.fn(async () => new Map([[1, { descripcion: 'ALPISTE X 30 KG' }]])),
  fechaArgentina: () => '2026-09-09',
}));
vi.mock('./vistaPresupuestos.js', () => ({ invalidarVista: vi.fn(), vistaDeRango: vi.fn() }));
vi.mock('./vistaRemitos.js', () => ({ invalidarRemitos: vi.fn(), vistaRemitos: vi.fn() }));
vi.mock('./supabase.js', () => ({ sb: m.sbMock, TENANT_ID: 'test-tenant', hasSupabase: () => true }));

const { editarPresupuesto, firmaDelSurtido, emparejarParaPut } = await import('./editarPresupuesto.js');

let tablas: Record<string, any> = {};

function fakeSb() {
  m.sbMock.mockImplementation(() => ({
    from: (t: string) => {
      const res = tablas[t] ?? { data: null, error: null };
      const q: any = {
        then: (r: any, j: any) => Promise.resolve(res).then(r, j),
        maybeSingle: () => Promise.resolve(res),
        delete: () => q, insert: () => q, upsert: () => q, update: () => q,
      };
      for (const k of ['select', 'eq', 'in', 'not', 'is', 'or', 'order', 'limit']) q[k] = () => q;
      return q;
    },
  }));
}

function llamar(body: any, params = { comprobanteId: '58727292' }) {
  let status = 200; let out: any;
  const req: any = { user: { rol: 'administrativo', sub: 'u1' }, params, body, query: {} };
  const res: any = { status: (s: number) => { status = s; return res; }, json: (b: any) => { out = b; } };
  return editarPresupuesto(req, res).then(() => ({ status, body: out }));
}

const CAB_OK = {
  fecha: '2026-09-09', anulada: false, existe: true, observaciones: 'entregar el jueves',
  numero: 58158, cod_cliente: 297, cod_vendedor: '2', cod_empresa: 1,
  cod_lista_precios: 13, punto_de_venta: 1, usuario: 'jorgelina',
  tipo_presupuesto: 'C', fecha_entrega: '2026-09-09',
};
/** Los renglones que hoy tiene el presupuesto en IM. */
const ITEMS_IM = [
  { id: 101, cod_articulo: 1, cantidad: 10, cod_lista_precios: 13, descuento_porc: 0 },
  { id: 102, cod_articulo: 2, cantidad: 5, cod_lista_precios: 13, descuento_porc: 0 },
];

beforeEach(() => {
  tablas = { presupuestos_facturados: { data: null, error: null }, presupuestos_revision: { data: null, error: null } };
  vi.clearAllMocks();
  fakeSb();
  m.cabeceraComprobante.mockResolvedValue(CAB_OK);
  m.getItemsComprobante.mockResolvedValue(ITEMS_IM);
  m.actualizarPresupuestoCantidades.mockResolvedValue({ ok: true });
  m.crearPresupuesto.mockResolvedValue({ ok: true, id: '58800999', numero: 58200, raw: {} });
  m.anularComprobante.mockResolvedValue({ ok: true, raw: {} });
});

describe('cambiar sólo cantidades', () => {
  it('🔑 usa el camino barato y CONSERVA el número de presupuesto', async () => {
    const r = await llamar({ items: [
      { cod_articulo: 1, cantidad: 20, cod_lista_precios: 13, descuento_porc: 0 },
      { cod_articulo: 2, cantidad: 5, cod_lista_precios: 13, descuento_porc: 0 },
    ] });
    expect(r.status).toBe(200);
    expect(r.body.modo).toBe('cantidades');
    expect(m.actualizarPresupuestoCantidades).toHaveBeenCalledWith('58727292', [
      { id: 101, cantidad: 20 }, { id: 102, cantidad: 5 },
    ]);
    expect(m.crearPresupuesto).not.toHaveBeenCalled();
    expect(m.anularComprobante).not.toHaveBeenCalled();
  });
});

describe('cambiar el surtido obliga a recrear', () => {
  /**
   * 🔴 `PUT /presupuestos/{id}` sólo aplica `cantidad`: agregar un renglón devuelve 200 y no hace
   * nada, y cambiar la lista o el descuento se ignora en silencio. Sin recrear, el panel diría
   * "guardado" y a InfoManager no habría llegado nada.
   */
  it('🔴 SACAR un producto recrea: no queda ningún renglón en cantidad 0', async () => {
    // Mati rechazó el 07/09/2026 la salida de dejarlo en 0: "no es viable que se vea cantidad 0".
    const r = await llamar({ items: [{ cod_articulo: 1, cantidad: 10, cod_lista_precios: 13, descuento_porc: 0 }] });
    expect(r.body.modo).toBe('recreado');
    const enviados = m.crearPresupuesto.mock.calls[0][0].items;
    expect(enviados).toHaveLength(1);
    expect(enviados.every((i: any) => i.cantidad > 0)).toBe(true);
  });

  it('🔴 AGREGAR un producto recrea', async () => {
    const r = await llamar({ items: [
      ...ITEMS_IM.map(i => ({ cod_articulo: i.cod_articulo, cantidad: i.cantidad, cod_lista_precios: 13, descuento_porc: 0 })),
      { cod_articulo: 9, cantidad: 3, cod_lista_precios: 13, descuento_porc: 0 },
    ] });
    expect(r.body.modo).toBe('recreado');
    expect(m.crearPresupuesto.mock.calls[0][0].items).toHaveLength(3);
  });

  it('🔴 cambiar la LISTA de un renglón recrea: el PUT la ignora en silencio', async () => {
    const r = await llamar({ items: [
      { cod_articulo: 1, cantidad: 10, cod_lista_precios: 14, descuento_porc: 0 },
      { cod_articulo: 2, cantidad: 5, cod_lista_precios: 13, descuento_porc: 0 },
    ] });
    expect(r.body.modo).toBe('recreado');
    expect(m.crearPresupuesto.mock.calls[0][0].items[0].cod_lista_precios).toBe(14);
  });

  it('🔴 cambiar el DESCUENTO también recrea', async () => {
    const r = await llamar({ items: [
      { cod_articulo: 1, cantidad: 10, cod_lista_precios: 13, descuento_porc: 10 },
      { cod_articulo: 2, cantidad: 5, cod_lista_precios: 13, descuento_porc: 0 },
    ] });
    expect(r.body.modo).toBe('recreado');
  });

  it('🔑 se conservan cliente, empresa, fecha y observaciones del original', async () => {
    await llamar({ items: [{ cod_articulo: 1, cantidad: 10, cod_lista_precios: 14, descuento_porc: 0 }] });
    expect(m.crearPresupuesto.mock.calls[0][0]).toMatchObject({
      cod_cliente: 297, cod_empresa: 1, cod_vendedor: '2', usuario: 'jorgelina',
      fecha: '2026-09-09', observaciones: 'entregar el jueves',
    });
  });
});

describe('el orden de las operaciones', () => {
  /**
   * 🔴 De los dos pasos, el que NO se puede deshacer es la anulación. Si se anulara primero y la
   * creación fallara, el cliente queda sin ningún presupuesto vivo: se perdió el pedido y en
   * InfoManager no hay nada para facturar.
   */
  it('🔴 si la creación FALLA, el original NO se anula', async () => {
    m.crearPresupuesto.mockResolvedValue({ ok: false, error: 'artículo inexistente' });
    const r = await llamar({ items: [{ cod_articulo: 999, cantidad: 1, cod_lista_precios: 13, descuento_porc: 0 }] });
    expect(r.status).toBe(502);
    expect(m.anularComprobante).not.toHaveBeenCalled();
    expect(r.body.error).toMatch(/sigue como estaba/i);
  });

  it('🔴 si la anulación falla, se avisa FUERTE: quedan dos presupuestos vivos', async () => {
    m.anularComprobante.mockResolvedValue({ ok: false, error: 'IM rechazó la anulación' });
    const r = await llamar({ items: [{ cod_articulo: 1, cantidad: 10, cod_lista_precios: 14, descuento_porc: 0 }] });
    expect(r.status).toBe(200);
    expect(r.body.aviso).toMatch(/dos vivos|no se pudo anular/i);
    expect(r.body.aviso).toMatch(/58158/);
  });

  it('crea primero y anula después, en ese orden', async () => {
    const orden: string[] = [];
    m.crearPresupuesto.mockImplementation(async () => { orden.push('crear'); return { ok: true, id: 'x', numero: 1, raw: {} }; });
    m.anularComprobante.mockImplementation(async () => { orden.push('anular'); return { ok: true, raw: {} }; });
    await llamar({ items: [{ cod_articulo: 1, cantidad: 10, cod_lista_precios: 14, descuento_porc: 0 }] });
    expect(orden).toEqual(['crear', 'anular']);
  });
});

describe('lo que no se puede editar', () => {
  it('🔴 un presupuesto YA FACTURADO no se toca', async () => {
    tablas['presupuestos_facturados'] = { data: { im_factura_numero: 50370, facturado_at: 'x' }, error: null };
    const r = await llamar({ items: [{ cod_articulo: 1, cantidad: 10, cod_lista_precios: 13, descuento_porc: 0 }] });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/nota de crédito/i);
    expect(m.crearPresupuesto).not.toHaveBeenCalled();
  });

  it('🔴 si no se puede verificar si está facturado, no se edita a ciegas', async () => {
    tablas['presupuestos_facturados'] = { data: null, error: { message: 'timeout' } };
    const r = await llamar({ items: [{ cod_articulo: 1, cantidad: 10, cod_lista_precios: 13, descuento_porc: 0 }] });
    expect(r.status).toBe(502);
    expect(m.crearPresupuesto).not.toHaveBeenCalled();
  });

  it('🔴 uno ANULADO en InfoManager tampoco', async () => {
    m.cabeceraComprobante.mockResolvedValue({ ...CAB_OK, anulada: true });
    const r = await llamar({ items: [{ cod_articulo: 1, cantidad: 10, cod_lista_precios: 13, descuento_porc: 0 }] });
    expect(r.status).toBe(409);
  });

  it('🔴 si no se pudo leer el presupuesto, no se escribe nada', async () => {
    m.cabeceraComprobante.mockResolvedValue({ ...CAB_OK, existe: null, anulada: null });
    const r = await llamar({ items: [{ cod_articulo: 1, cantidad: 10, cod_lista_precios: 13, descuento_porc: 0 }] });
    expect(r.status).toBe(502);
    expect(m.actualizarPresupuestoCantidades).not.toHaveBeenCalled();
    expect(m.crearPresupuesto).not.toHaveBeenCalled();
  });

  it('🔴 no se puede dejar el presupuesto vacío', async () => {
    const r = await llamar({ items: [] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/al menos un producto/i);
  });

  it('un renglón con lista inválida se rechaza, no se corrige solo', async () => {
    const r = await llamar({ items: [{ cod_articulo: 1, cantidad: 10, cod_lista_precios: 99, descuento_porc: 0 }] });
    expect(r.status).toBe(400);
  });

  it('un vendedor no puede editar presupuestos', async () => {
    let status = 200;
    const req: any = { user: { rol: 'vendedor' }, params: { comprobanteId: '1' }, body: {}, query: {} };
    const res: any = { status: (s: number) => { status = s; return res; }, json: () => {} };
    await editarPresupuesto(req, res);
    expect(status).toBe(403);
  });
});

describe('firmaDelSurtido', () => {
  it('🔑 la lista y el descuento están en la firma: el PUT los ignora', async () => {
    const base = [{ cod_articulo: 1, cod_lista_precios: 13, descuento_porc: 0 }];
    expect(firmaDelSurtido(base)).not.toBe(firmaDelSurtido([{ cod_articulo: 1, cod_lista_precios: 14, descuento_porc: 0 }]));
    expect(firmaDelSurtido(base)).not.toBe(firmaDelSurtido([{ cod_articulo: 1, cod_lista_precios: 13, descuento_porc: 5 }]));
  });

  it('la cantidad NO está: cambiarla es justamente lo que sí se puede hacer con un PUT', async () => {
    expect(firmaDelSurtido([{ cod_articulo: 1, cod_lista_precios: 13, descuento_porc: 0 }]))
      .toBe(firmaDelSurtido([{ cod_articulo: 1, cod_lista_precios: 13, descuento_porc: 0 }]));
  });
});

describe('emparejarParaPut', () => {
  it('empareja el mismo artículo repetido por orden de aparición', async () => {
    const r = emparejarParaPut(
      [{ cod_articulo: 1, cantidad: 5 }, { cod_articulo: 1, cantidad: 7 }],
      [{ id: 10, cod_articulo: 1 }, { id: 11, cod_articulo: 1 }],
    );
    expect(r).toEqual([{ id: 10, cantidad: 5 }, { id: 11, cantidad: 7 }]);
  });

  it('🔴 si un renglón se queda sin pareja devuelve null: no se adivina', async () => {
    expect(emparejarParaPut([{ cod_articulo: 9, cantidad: 1 }], [{ id: 10, cod_articulo: 1 }])).toBeNull();
  });
});
