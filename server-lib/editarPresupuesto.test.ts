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
  actualizarCabecera: vi.fn(),
}));

vi.mock('./infomanager.js', () => ({
  // El cache de /ventas se limpia junto con las vistas (10/09/2026).
  invalidarCacheVentas: vi.fn(),
  invalidarCacheItems: vi.fn(),
  cabeceraComprobante: m.cabeceraComprobante,
  getItemsComprobante: m.getItemsComprobante,
  actualizarPresupuestoCantidades: m.actualizarPresupuestoCantidades,
  crearPresupuesto: m.crearPresupuesto,
  anularComprobante: m.anularComprobante,
  actualizarCabecera: m.actualizarCabecera,
  fetchArticulosCatalogo: vi.fn(async () => new Map([[1, { descripcion: 'ALPISTE X 30 KG' }]])),
  fechaArgentina: () => '2026-09-09',
}));
vi.mock('./vistaPresupuestos.js', () => ({ invalidarVista: vi.fn(), vistaDeRango: vi.fn() }));
vi.mock('./vistaRemitos.js', () => ({ invalidarRemitos: vi.fn(), vistaRemitos: vi.fn() }));
vi.mock('./supabase.js', () => ({ sb: m.sbMock, TENANT_ID: 'test-tenant', hasSupabase: () => true }));

const { editarPresupuesto, firmaDelSurtido, emparejarParaPut } = await import('./editarPresupuesto.js');

let tablas: Record<string, any> = {};
let escrituras: Array<{ tabla: string; op: string; valor: any }> = [];
/** Si está seteado, toda ESCRITURA contesta este error (Supabase no tira: devuelve `{error}`). */
let errorEnEscritura: { message: string } | null = null;

function fakeSb() {
  m.sbMock.mockImplementation(() => ({
    from: (t: string) => {
      const res = tablas[t] ?? { data: null, error: null };
      const escribio = () => (errorEnEscritura ? { data: null, error: errorEnEscritura } : res);
      const anota = (op: string) => (valor?: any) => { escrituras.push({ tabla: t, op, valor }); return w; };
      const w: any = {
        then: (r: any, j: any) => Promise.resolve(escribio()).then(r, j),
        maybeSingle: () => Promise.resolve(escribio()),
      };
      const q: any = {
        then: (r: any, j: any) => Promise.resolve(res).then(r, j),
        maybeSingle: () => Promise.resolve(res),
        delete: anota('delete'), insert: anota('insert'), upsert: anota('upsert'), update: anota('update'),
      };
      for (const k of ['select', 'eq', 'in', 'not', 'is', 'or', 'order', 'limit']) { q[k] = () => q; w[k] = () => w; }
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
  { id: 101, cod_articulo: 1, cantidad: 10, cod_lista_precios: 13, descuento_porc: 0, precio: 100, precio_orig: 100, iva_por: 0, detalle: 'ALPISTE X 30 KG' },
  { id: 102, cod_articulo: 2, cantidad: 5, cod_lista_precios: 13, descuento_porc: 0, precio: 200, precio_orig: 200, iva_por: 0, detalle: 'MIJO' },
];

beforeEach(() => {
  tablas = { presupuestos_facturados: { data: null, error: null }, presupuestos_revision: { data: null, error: null } };
  escrituras = [];
  errorEnEscritura = null;
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
      { cod_articulo: 1, cantidad: 20, cod_lista_precios: 13, descuento_porc: 0, precio: 100 },
      { cod_articulo: 2, cantidad: 5, cod_lista_precios: 13, descuento_porc: 0, precio: 100 },
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
    const r = await llamar({ items: [{ cod_articulo: 1, cantidad: 10, cod_lista_precios: 13, descuento_porc: 0, precio: 100 }] });
    expect(r.body.modo).toBe('recreado');
    const enviados = m.crearPresupuesto.mock.calls[0][0].items;
    expect(enviados).toHaveLength(1);
    expect(enviados.every((i: any) => i.cantidad > 0)).toBe(true);
  });

  it('🔴 AGREGAR un producto recrea', async () => {
    const r = await llamar({ items: [
      ...ITEMS_IM.map(i => ({ cod_articulo: i.cod_articulo, cantidad: i.cantidad, cod_lista_precios: 13, descuento_porc: 0, precio: i.precio })),
      { cod_articulo: 9, cantidad: 3, cod_lista_precios: 13, descuento_porc: 0, precio: 100 },
    ] });
    expect(r.body.modo).toBe('recreado');
    expect(m.crearPresupuesto.mock.calls[0][0].items).toHaveLength(3);
  });

  it('🔴 cambiar la LISTA de un renglón recrea: el PUT la ignora en silencio', async () => {
    const r = await llamar({ items: [
      { cod_articulo: 1, cantidad: 10, cod_lista_precios: 14, descuento_porc: 0, precio: 100 },
      { cod_articulo: 2, cantidad: 5, cod_lista_precios: 13, descuento_porc: 0, precio: 100 },
    ] });
    expect(r.body.modo).toBe('recreado');
    expect(m.crearPresupuesto.mock.calls[0][0].items[0].cod_lista_precios).toBe(14);
  });

  it('🔴 cambiar el DESCUENTO también recrea', async () => {
    const r = await llamar({ items: [
      { cod_articulo: 1, cantidad: 10, cod_lista_precios: 13, descuento_porc: 10, precio: 100 },
      { cod_articulo: 2, cantidad: 5, cod_lista_precios: 13, descuento_porc: 0, precio: 100 },
    ] });
    expect(r.body.modo).toBe('recreado');
  });

  it('🔑 se conservan cliente, empresa, fecha y observaciones del original', async () => {
    await llamar({ items: [{ cod_articulo: 1, cantidad: 10, cod_lista_precios: 14, descuento_porc: 0, precio: 100 }] });
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
    const r = await llamar({ items: [{ cod_articulo: 999, cantidad: 1, cod_lista_precios: 13, descuento_porc: 0, precio: 100 }] });
    expect(r.status).toBe(502);
    expect(m.anularComprobante).not.toHaveBeenCalled();
    expect(r.body.error).toMatch(/sigue como estaba/i);
  });

  it('🔴 si la anulación falla, se avisa FUERTE: quedan dos presupuestos vivos', async () => {
    m.anularComprobante.mockResolvedValue({ ok: false, error: 'IM rechazó la anulación' });
    const r = await llamar({ items: [{ cod_articulo: 1, cantidad: 10, cod_lista_precios: 14, descuento_porc: 0, precio: 100 }] });
    expect(r.status).toBe(200);
    expect(r.body.aviso).toMatch(/dos vivos|no se pudo anular/i);
    expect(r.body.aviso).toMatch(/58158/);
  });

  it('crea primero y anula después, en ese orden', async () => {
    const orden: string[] = [];
    m.crearPresupuesto.mockImplementation(async () => { orden.push('crear'); return { ok: true, id: 'x', numero: 1, raw: {} }; });
    m.anularComprobante.mockImplementation(async () => { orden.push('anular'); return { ok: true, raw: {} }; });
    await llamar({ items: [{ cod_articulo: 1, cantidad: 10, cod_lista_precios: 14, descuento_porc: 0, precio: 100 }] });
    expect(orden).toEqual(['crear', 'anular']);
  });
});

describe('lo que no se puede editar', () => {
  it('🔴 un presupuesto YA FACTURADO no se toca', async () => {
    tablas['presupuestos_facturados'] = { data: { im_factura_numero: 50370, facturado_at: 'x' }, error: null };
    const r = await llamar({ items: [{ cod_articulo: 1, cantidad: 10, cod_lista_precios: 13, descuento_porc: 0, precio: 100 }] });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/nota de crédito/i);
    expect(m.crearPresupuesto).not.toHaveBeenCalled();
  });

  it('🔴 si no se puede verificar si está facturado, no se edita a ciegas', async () => {
    tablas['presupuestos_facturados'] = { data: null, error: { message: 'timeout' } };
    const r = await llamar({ items: [{ cod_articulo: 1, cantidad: 10, cod_lista_precios: 13, descuento_porc: 0, precio: 100 }] });
    expect(r.status).toBe(502);
    expect(m.crearPresupuesto).not.toHaveBeenCalled();
  });

  it('🔴 uno ANULADO en InfoManager tampoco', async () => {
    m.cabeceraComprobante.mockResolvedValue({ ...CAB_OK, anulada: true });
    const r = await llamar({ items: [{ cod_articulo: 1, cantidad: 10, cod_lista_precios: 13, descuento_porc: 0, precio: 100 }] });
    expect(r.status).toBe(409);
  });

  it('🔴 si no se pudo leer el presupuesto, no se escribe nada', async () => {
    m.cabeceraComprobante.mockResolvedValue({ ...CAB_OK, existe: null, anulada: null });
    const r = await llamar({ items: [{ cod_articulo: 1, cantidad: 10, cod_lista_precios: 13, descuento_porc: 0, precio: 100 }] });
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
    const r = await llamar({ items: [{ cod_articulo: 1, cantidad: 10, cod_lista_precios: 99, descuento_porc: 0, precio: 100 }] });
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

describe('el costo de distribución', () => {
  /**
   * 🔴 Mati (09/09/2026): *"a algunos pedidos les cargamos el costo de distribución. Es un ítem
   * aparte que no tiene código, le ponemos el precio"*, y después: *"al querer guardar no hace
   * nada"*.
   *
   * La causa: se mandaba como renglón LIBRE, y la API de InfoManager no los tiene. `cod_articulo`
   * es `int64` obligatorio en el schema; con `""` contesta *"The JSON value could not be
   * converted to System.Int64"* y con `0` *"No se encontró un artículo válido para
   * cod_articulo = 0"*. Las dos probadas contra IM ese día. Va con el artículo 13819, que existe
   * en el catálogo justamente para esto.
   */
  it('🔑 va como un artículo más, con su precio escrito a mano', async () => {
    const r = await llamar({ items: [
      { cod_articulo: 1, cantidad: 10, cod_lista_precios: 13, descuento_porc: 0, precio: 100 },
      { cod_articulo: 2, cantidad: 5, cod_lista_precios: 13, descuento_porc: 0, precio: 100 },
      { cod_articulo: 13819, cantidad: 1, cod_lista_precios: 13, descuento_porc: 0, precio: 15000 },
    ] });
    expect(r.status).toBe(200);
    expect(r.body.modo).toBe('recreado');
    const enviados = m.crearPresupuesto.mock.calls[0][0].items;
    expect(enviados).toHaveLength(3);
    expect(enviados[2]).toMatchObject({ cod_articulo: 13819, cantidad: 1, precio: 15000 });
    // Ni rastro de renglones sin código: IM rechazaría el presupuesto entero.
    expect(enviados.every((i: any) => Number(i.cod_articulo) > 0)).toBe(true);
  });

  it('🔴 un renglón SIN artículo no se manda: IM rechaza el presupuesto entero', async () => {
    const r = await llamar({ items: [
      { cod_articulo: 1, cantidad: 10, cod_lista_precios: 13, descuento_porc: 0, precio: 100 },
      { cod_articulo: 2, cantidad: 5, cod_lista_precios: 13, descuento_porc: 0, precio: 100 },
      { cod_articulo: 0, cantidad: 1, cod_lista_precios: 13, descuento_porc: 0, precio: 15000, detalle: 'FLETE' },
    ] });
    // Se descarta y el resto sigue igual, así que alcanza con el camino barato.
    expect(r.body.modo).toBe('cantidades');
    expect(m.crearPresupuesto).not.toHaveBeenCalled();
  });

  it('🔴 sin precio no se guarda: InfoManager lo grabaría en $0', async () => {
    // Probado el 09/09/2026 (PR 58307, anulado): sin `precio` IM NO lo busca en la lista.
    const r = await llamar({ items: [
      { cod_articulo: 1, cantidad: 10, cod_lista_precios: 13, descuento_porc: 0, precio: 100 },
      { cod_articulo: 13819, cantidad: 1, cod_lista_precios: 13, descuento_porc: 0 },
    ] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/precio/i);
    expect(m.crearPresupuesto).not.toHaveBeenCalled();
    expect(m.actualizarPresupuestoCantidades).not.toHaveBeenCalled();
  });

  /**
   * 🔴 Los renglones sin artículo que YA están en InfoManager son notas que escribió la oficina
   * desde su propio sistema ("QUEBRADO GRUESO PENDIENTE"). Rehacer el presupuesto las borraría y
   * la API no las puede volver a cargar, así que se frena y se dice por qué.
   */
  it('🔴 si el presupuesto tiene notas sin código, no se rehace: se perderían', async () => {
    m.getItemsComprobante.mockResolvedValue([
      { id: 101, cod_articulo: 1, cantidad: 10, cod_lista_precios: 13, descuento_porc: 0, precio: 100, precio_orig: 100, iva_por: 0, detalle: 'ALPISTE X 30 KG' },
      { id: 103, cod_articulo: 0, cantidad: 1, cod_lista_precios: 13, descuento_porc: 0, precio: 0, precio_orig: 0, iva_por: 0, detalle: 'QUEBRADO GRUESO PENDIENTE' },
    ]);
    const r = await llamar({ items: [
      { cod_articulo: 1, cantidad: 10, cod_lista_precios: 13, descuento_porc: 0, precio: 100 },
      { cod_articulo: 13819, cantidad: 1, cod_lista_precios: 13, descuento_porc: 0, precio: 15000 },
    ] });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/QUEBRADO GRUESO PENDIENTE/);
    expect(m.crearPresupuesto).not.toHaveBeenCalled();
    expect(m.anularComprobante).not.toHaveBeenCalled();
  });

  it('con notas sin código SÍ se pueden corregir cantidades: eso no las toca', async () => {
    m.getItemsComprobante.mockResolvedValue([
      { id: 101, cod_articulo: 1, cantidad: 10, cod_lista_precios: 13, descuento_porc: 0, precio: 100, precio_orig: 100, iva_por: 0, detalle: 'ALPISTE X 30 KG' },
      { id: 103, cod_articulo: 0, cantidad: 1, cod_lista_precios: 13, descuento_porc: 0, precio: 0, precio_orig: 0, iva_por: 0, detalle: 'NOTA' },
    ]);
    const r = await llamar({ items: [
      { cod_articulo: 1, cantidad: 25, cod_lista_precios: 13, descuento_porc: 0, precio: 100 },
    ] });
    expect(r.status).toBe(200);
    expect(r.body.modo).toBe('cantidades');
    expect(m.actualizarPresupuestoCantidades).toHaveBeenCalledWith('58727292', [{ id: 101, cantidad: 25 }]);
  });
});

describe('las observaciones', () => {
  /**
   * 🔑 Mati (09/09/2026): *"necesito que podamos agregar observaciones en el presupuesto"*. Es el
   * campo que la oficina lee antes de facturar ("facturar a nombre de la SRL", "entregar el
   * jueves"), y hasta ahora sólo se podía escribir desde InfoManager.
   */
  it('🔑 cambiarlas solas no rehace el presupuesto: va por PUT y el número no cambia', async () => {
    m.actualizarCabecera.mockResolvedValue({ ok: true, raw: {} });
    const r = await llamar({
      observaciones: 'FACTURAR A NOMBRE DE LA SRL',
      items: ITEMS_IM.map(i => ({ cod_articulo: i.cod_articulo, cantidad: i.cantidad, cod_lista_precios: 13, descuento_porc: 0, precio: i.precio })),
    });
    expect(r.status).toBe(200);
    expect(r.body.modo).toBe('cantidades');
    expect(m.actualizarCabecera).toHaveBeenCalledWith(expect.objectContaining({
      id: '58727292', numero: 58158, punto_de_venta: 1, observaciones: 'FACTURAR A NOMBRE DE LA SRL',
    }));
    expect(m.crearPresupuesto).not.toHaveBeenCalled();
  });

  it('🪤 si las observaciones no se pudieron guardar se avisa: las cantidades YA se guardaron', async () => {
    m.actualizarCabecera.mockResolvedValue({ ok: false, error: 'IM caído' });
    const r = await llamar({
      observaciones: 'OTRA COSA',
      items: ITEMS_IM.map(i => ({ cod_articulo: i.cod_articulo, cantidad: i.cantidad, cod_lista_precios: 13, descuento_porc: 0, precio: i.precio })),
    });
    expect(r.status).toBe(200);
    expect(r.body.aviso).toMatch(/NO las observaciones/);
  });

  it('si no cambiaron, no se le pide nada a InfoManager', async () => {
    const r = await llamar({
      observaciones: 'entregar el jueves',   // las mismas que ya tiene
      items: ITEMS_IM.map(i => ({ cod_articulo: i.cod_articulo, cantidad: i.cantidad, cod_lista_precios: 13, descuento_porc: 0, precio: i.precio })),
    });
    expect(r.status).toBe(200);
    expect(m.actualizarCabecera).not.toHaveBeenCalled();
  });

  it('🔑 al rehacer el presupuesto viajan las nuevas, no las viejas', async () => {
    const r = await llamar({
      observaciones: 'ENTREGAR EL VIERNES',
      items: [{ cod_articulo: 1, cantidad: 10, cod_lista_precios: 13, descuento_porc: 0, precio: 100 }],
    });
    expect(r.body.modo).toBe('recreado');
    expect(m.crearPresupuesto.mock.calls[0][0].observaciones).toBe('ENTREGAR EL VIERNES');
  });
});

describe('el código de compatibilidad', () => {
  /**
   * 🔴 09/09/2026, en vivo. `crearPresupuesto` TRUNCA `cod_compatibilidad` a 8 caracteres, y el
   * que se generaba acá empezaba con `EDIT-` + el reloj en base36: de todo eso sobrevivían tres
   * dígitos que cambian una vez cada ~17 horas. Resultado: todas las ediciones de la tarde
   * mandaron `EDIT-MTU`, la primera creó el presupuesto y el resto chocó contra ella — IM
   * devolvía el que ya existía y el panel no guardaba nada ("el costo de distribución no graba").
   */
  it('🔴 dos ediciones seguidas NO pueden compartir el código, ni truncado a 8', async () => {
    const items = [{ cod_articulo: 1, cantidad: 10, cod_lista_precios: 13, descuento_porc: 0, precio: 100 }];
    await llamar({ items });
    await llamar({ items });
    const [a, b] = m.crearPresupuesto.mock.calls.map((c: any) => String(c[0].cod_compatibilidad));
    expect(a).not.toBe(b);
    expect(a.slice(0, 8)).not.toBe(b.slice(0, 8));
    expect(a).toHaveLength(8);
  });

  it('🔴 si IM contesta que ya existía, NO se anula el original', async () => {
    m.crearPresupuesto.mockResolvedValue({
      ok: false, error: 'InfoManager no creó el presupuesto: devolvió el nº 58304, que ya existía.',
    });
    const r = await llamar({ items: [{ cod_articulo: 1, cantidad: 10, cod_lista_precios: 13, descuento_porc: 0, precio: 100 }] });
    expect(r.status).toBe(502);
    expect(m.anularComprobante).not.toHaveBeenCalled();
  });
});


describe('la fecha del presupuesto', () => {
  /**
   * 🔑 Mati (09/09/2026): *"necesitamos poder editar la fecha del presupuesto apenas llegan al
   * panel así lo redireccionamos a otra fecha"*. La fecha del comprobante es la que decide en qué
   * día de reparto entra el pedido — la oficina la mueve todo el tiempo para reordenar despachos.
   */
  it('🔑 moverla de día no rehace el presupuesto: el número no cambia', async () => {
    m.actualizarCabecera.mockResolvedValue({ ok: true, raw: {} });
    const r = await llamar({
      fecha: '2026-09-11',
      items: ITEMS_IM.map(i => ({ cod_articulo: i.cod_articulo, cantidad: i.cantidad, cod_lista_precios: 13, descuento_porc: 0, precio: i.precio })),
    });
    expect(r.status).toBe(200);
    expect(r.body.modo).toBe('cantidades');
    expect(r.body.fecha).toBe('2026-09-11');
    expect(m.actualizarCabecera).toHaveBeenCalledWith(expect.objectContaining({ fecha: '2026-09-11' }));
    expect(m.crearPresupuesto).not.toHaveBeenCalled();
  });

  /**
   * 🪤 Fecha y observaciones viajan en el MISMO PUT de IM. Mandar sólo una pisaría la otra con
   * lo que hubiera en el body, así que las dos se resuelven juntas contra lo que ya tenía.
   */
  it('🪤 al mover la fecha, las observaciones que ya tenía NO se borran', async () => {
    m.actualizarCabecera.mockResolvedValue({ ok: true, raw: {} });
    await llamar({
      fecha: '2026-09-11',
      items: ITEMS_IM.map(i => ({ cod_articulo: i.cod_articulo, cantidad: i.cantidad, cod_lista_precios: 13, descuento_porc: 0, precio: i.precio })),
    });
    expect(m.actualizarCabecera).toHaveBeenCalledWith(expect.objectContaining({
      observaciones: 'entregar el jueves',
    }));
  });

  it('🔴 una fecha inventada se rechaza: el pedido desaparecería de la pantalla', async () => {
    const r = await llamar({
      fecha: '11/09/2026',
      items: ITEMS_IM.map(i => ({ cod_articulo: i.cod_articulo, cantidad: i.cantidad, cod_lista_precios: 13, descuento_porc: 0, precio: i.precio })),
    });
    expect(r.status).toBe(400);
    expect(m.actualizarCabecera).not.toHaveBeenCalled();
    expect(m.actualizarPresupuestoCantidades).not.toHaveBeenCalled();
  });

  it('si no cambió, no se le pide nada a InfoManager', async () => {
    const r = await llamar({
      fecha: '2026-09-09',                 // la que ya tiene
      items: ITEMS_IM.map(i => ({ cod_articulo: i.cod_articulo, cantidad: i.cantidad, cod_lista_precios: 13, descuento_porc: 0, precio: i.precio })),
    });
    expect(r.status).toBe(200);
    expect(m.actualizarCabecera).not.toHaveBeenCalled();
  });

  it('🔑 al rehacer el presupuesto, el nuevo nace con la fecha nueva', async () => {
    const r = await llamar({
      fecha: '2026-09-11',
      items: [{ cod_articulo: 1, cantidad: 10, cod_lista_precios: 13, descuento_porc: 0, precio: 100 }],
    });
    expect(r.body.modo).toBe('recreado');
    const creado = m.crearPresupuesto.mock.calls[0][0];
    expect(creado.fecha).toBe('2026-09-11');
    expect(creado.fecha_entrega).toBe('2026-09-11');
  });
});

describe('el pedido del vendedor al rehacer el presupuesto', () => {
  /**
   * 🔴 09/09/2026, NAVARRO Andrea. El panel editó el PR 58301 y creó el 58309, pero
   * `pedidos_vendedor` siguió apuntando al 58301 — el que se acababa de anular. Cuando el
   * vendedor editó su pedido desde la app, `editarPedido` vio ese comprobante anulado, recreó a
   * partir de ÉL y anuló el que ya estaba anulado: el 58309 quedó vivo y huérfano.
   *
   * Resultado: DOS presupuestos vigentes del mismo pedido, los dos facturables.
   */
  it('🔴 el pedido de la app pasa a apuntar al presupuesto NUEVO', async () => {
    await llamar({ items: [{ cod_articulo: 1, cantidad: 10, cod_lista_precios: 13, descuento_porc: 0, precio: 100 }] });
    const upd = escrituras.find(e => e.tabla === 'pedidos_vendedor' && e.op === 'update');
    expect(upd).toBeTruthy();
    expect(upd!.valor).toMatchObject({ im_presupuesto_id: '58800999', im_numero: 58200 });
  });

  it('🔴 si no se puede reapuntar, se avisa: el próximo cambio del vendedor duplicaría el pedido', async () => {
    errorEnEscritura = { message: 'supabase caído' };
    const r = await llamar({ items: [{ cod_articulo: 1, cantidad: 10, cod_lista_precios: 13, descuento_porc: 0, precio: 100 }] });
    expect(r.status).toBe(200);
    expect(r.body.aviso).toMatch(/duplicado/i);
  });

  it('cambiar sólo cantidades no lo toca: el presupuesto es el mismo', async () => {
    await llamar({ items: [
      { cod_articulo: 1, cantidad: 20, cod_lista_precios: 13, descuento_porc: 0, precio: 100 },
      { cod_articulo: 2, cantidad: 5, cod_lista_precios: 13, descuento_porc: 0, precio: 200 },
    ] });
    expect(escrituras.find(e => e.tabla === 'pedidos_vendedor')).toBeUndefined();
  });
});
