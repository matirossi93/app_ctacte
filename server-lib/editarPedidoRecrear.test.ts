import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Editar un pedido que cambió de surtido/lista/descuento obliga a RECREAR el presupuesto en
 * IM (el schema VentasPresupuestosActualizar sólo acepta {id, cantidad}). Ese camino tenía
 * tres heridas, y el 28/08/2026 se llevaron puesto un pedido real:
 *
 *   1. El presupuesto nuevo salía con `cod_compatibilidad = pedido.id.slice(0,8)`, el MISMO
 *      código que ya había gastado el original. IM exige unicidad incluyendo los ANULADOS
 *      (verificado: el 58640964 quedó anulada:"S", 0 renglones, y retiene su "3c6e378c") ⇒
 *      400 seguro, siempre.
 *   2. Anulaba PRIMERO y creaba después, así que ese 400 dejaba al pedido sin NINGÚN
 *      presupuesto vivo: el vendedor perdió el pedido y en IM no quedó nada para facturar.
 *   3. El pedido quedó apuntando a un comprobante anulado con sus renglones viejos intactos
 *      acá ⇒ la próxima edición que sólo cambie cantidades da la MISMA firma y le manda el
 *      PUT a un muerto. Callejón sin salida.
 */

vi.hoisted(() => {
  process.env.IM_USUARIO_PEDIDOS = 'susana';
  process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret';
});

const im = vi.hoisted(() => ({
  crearPresupuesto: vi.fn(),
  anularComprobante: vi.fn(),
  actualizarPresupuestoCantidades: vi.fn(),
  getItemsComprobante: vi.fn(),
  presupuestoFacturado: vi.fn(),
  cabeceraComprobante: vi.fn(),
  fechaComprobante: vi.fn(),
  getPrecioLista: vi.fn(),
  fetchVendedores: vi.fn(),
  fetchArticulosCatalogo: vi.fn(),
  sbMock: vi.fn(),
}));

vi.mock('./infomanager.js', () => ({
  crearPresupuesto: im.crearPresupuesto,
  anularComprobante: im.anularComprobante,
  actualizarPresupuestoCantidades: im.actualizarPresupuestoCantidades,
  getItemsComprobante: im.getItemsComprobante,
  presupuestoFacturado: im.presupuestoFacturado,
  // 🪤 Si falta en este factory queda `undefined` y explota al llamarla (importar no rompe).
  cabeceraComprobante: im.cabeceraComprobante,
  fechaComprobante: im.fechaComprobante,
  getPrecioLista: im.getPrecioLista,
  fetchVendedores: im.fetchVendedores,
  fetchArticulosCatalogo: im.fetchArticulosCatalogo,
  fechaArgentina: () => '2026-08-27',
  getDisponibleCliente: vi.fn(),
  fetchClientesIMCached: vi.fn(),
  fetchArticulosDeDeposito: vi.fn(),
  fetchPreciosDeLista: vi.fn(),
}));
vi.mock('./supabase.js', () => ({ sb: im.sbMock, TENANT_ID: 'test-tenant', hasSupabase: () => true }));

const { editarPedido } = await import('./pedidos.js');

const PEDIDO_ID = '3c6e378c-1111-2222-3333-444455556666';
const PEDIDO = {
  id: PEDIDO_ID,
  tenant_id: 'test-tenant',
  estado: 'enviado',
  cod_vendedor: 2,
  cod_cliente: 500,
  cod_empresa: 1,
  cod_lista_precios: 12,
  im_presupuesto_id: 58640964,
  im_numero: 57874,
  im_punto_de_venta: 1,
  observaciones: null,
  created_at: '2026-08-27T14:00:00.000Z',
};
/** Los renglones que hoy tiene el pedido en NUESTRA base. Definen la firma. */
const ACTUALES = [{ cod_articulo: 100, cod_lista_precios: 12, descuento_porc: 0, orden: 0 }];

/** Todo lo que escribe editarPedido, en orden: [tabla, valores]. */
let updates: Array<[string, any]> = [];

/**
 * Fake encadenable Y awaitable de supabase-js. `then` es lo que hace que `await q.eq(...)`
 * funcione, que es como editarPedido consume el select de renglones, el delete y el insert.
 */
function fakeSb(resultados: Record<string, any>) {
  im.sbMock.mockImplementation(() => ({
    from: (t: string) => {
      const res = resultados[t] ?? { data: null, error: null };
      const q: any = {
        then: (r: any, j: any) => Promise.resolve(res).then(r, j),
        maybeSingle: () => Promise.resolve(res),
        update: (v: any) => { updates.push([t, v]); return q; },
      };
      for (const m of ['select', 'eq', 'order', 'delete', 'insert']) q[m] = () => q;
      return q;
    },
  }));
}

const USER = { rol: 'admin', nombre: 'Jorgelina' } as any;

/** Corre PUT /api/pedidos/:id y devuelve {status, body}. */
async function editar(items: Array<{ cod_articulo: number; cantidad: number; cod_lista?: number; descuento_porc?: number }>) {
  let status = 200;
  let body: any;
  const req: any = { params: { id: PEDIDO_ID }, body: { items }, user: USER };
  const res: any = { status: (s: number) => { status = s; return res; }, json: (b: any) => { body = b; } };
  await editarPedido(req, res);
  return { status, body };
}

/** Cambia el surtido: agrega un segundo renglón ⇒ la firma no coincide ⇒ recrear. */
const SURTIDO_NUEVO = [
  { cod_articulo: 100, cantidad: 5, cod_lista: 12 },
  { cod_articulo: 200, cantidad: 3, cod_lista: 12 },
];
/** Misma firma que ACTUALES: sólo cambia la cantidad ⇒ camino barato. */
const SOLO_CANTIDADES = [{ cod_articulo: 100, cantidad: 9, cod_lista: 12 }];

beforeEach(() => {
  updates = [];
  for (const f of Object.values(im)) (f as any).mockReset?.();
  fakeSb({
    pedidos_vendedor: { data: PEDIDO, error: null },
    pedidos_vendedor_items: { data: ACTUALES, error: null },
  });
  im.presupuestoFacturado.mockResolvedValue({ facturado: false });
  im.getPrecioLista.mockResolvedValue({ precio_vta: 1000, iva: 21, descripcion: 'X' });
  im.fetchVendedores.mockResolvedValue([]);
  im.fetchArticulosCatalogo.mockResolvedValue(new Map());
  im.cabeceraComprobante.mockResolvedValue({ fecha: '2026-08-27', anulada: false });
  im.fechaComprobante.mockResolvedValue('2026-08-27');
  im.anularComprobante.mockResolvedValue({ ok: true, raw: {} });
  im.actualizarPresupuestoCantidades.mockResolvedValue({ ok: true });
  im.getItemsComprobante.mockResolvedValue([{ id: 1, cod_articulo: 100, cantidad: 5, cod_lista_precios: 12 }]);
  im.crearPresupuesto.mockResolvedValue({ ok: true, id: '58700001', numero: 57999, raw: {} });
});

describe('editarPedido — recrear el presupuesto en IM', () => {
  it('🔴 ORDEN: primero CREA el nuevo, recién después anula el viejo', async () => {
    // De los dos pasos el que falla es el create (toda la validación de negocio de IM + la
    // trampa del 200-sin-isCreated). La operación frágil va primero, donde fallar es gratis.
    await editar(SURTIDO_NUEVO);
    expect(im.crearPresupuesto).toHaveBeenCalledTimes(1);
    expect(im.anularComprobante).toHaveBeenCalledTimes(1);
    expect(im.crearPresupuesto.mock.invocationCallOrder[0])
      .toBeLessThan(im.anularComprobante.mock.invocationCallOrder[0]);
  });

  it('🔴 EL CASO DEL 28/08: el cod_compatibilidad del pedido ya está gastado y IM lo rechaza', async () => {
    // IM real: unicidad de cod_compatibilidad INCLUYENDO comprobantes anulados. El original
    // ya quemó "3c6e378c", así que reusarlo es un 400 garantizado.
    const usados = new Set<string>([PEDIDO_ID.slice(0, 8)]);
    im.crearPresupuesto.mockImplementation(async (input: any) => {
      const cc = String(input.cod_compatibilidad ?? '');
      if (usados.has(cc)) {
        return { ok: false, error: `El codigo de compatibilidad ${cc} ya esta asignado a un presupuesto.` };
      }
      usados.add(cc);
      return { ok: true, id: '58700001', numero: 57999, raw: {} };
    });

    const { body } = await editar(SURTIDO_NUEVO);

    expect(body.ok).toBe(true);
    expect(body.numero_cambio).toBe(true);
    const cc = im.crearPresupuesto.mock.calls[0][0].cod_compatibilidad;
    expect(cc).not.toBe(PEDIDO_ID.slice(0, 8));
    expect(cc).toMatch(/^[0-9a-f]{8}$/);
    // Y el pedido NO puede quedar destruido: nada lo marcó en error.
    expect(updates.some(([, v]) => v.estado === 'error')).toBe(false);
  });

  it('🔴 si IM rechaza el create, NO se toca el viejo y el pedido queda como estaba', async () => {
    im.crearPresupuesto.mockResolvedValue({ ok: false, error: 'HTTP 400: el artículo no existe' });

    const { status, body } = await editar(SURTIDO_NUEVO);

    expect(im.anularComprobante).not.toHaveBeenCalled();
    expect(status).toBe(400);
    expect(body.error).toContain('57874');
    expect(body.error).toContain('sigue vigente');
    // El pedido no sufrió nada: ensuciarle el estado a un pedido sano es parte del bug.
    expect(updates.some(([, v]) => v.estado != null)).toBe(false);
  });

  it('🔴 YA ANULADO: un presupuesto muerto se recrea aunque sólo cambien las cantidades', async () => {
    // Así se recupera el pedido roto del 28/08: el vendedor abre y toca Confirmar. Sin esto
    // se va por el camino barato y le manda el PUT a un comprobante anulado (409 sin salida).
    im.cabeceraComprobante.mockResolvedValue({ fecha: '2026-08-27', anulada: true });

    const { body } = await editar(SOLO_CANTIDADES);

    expect(im.actualizarPresupuestoCantidades).not.toHaveBeenCalled();
    expect(im.anularComprobante).not.toHaveBeenCalled();   // ya está anulado: no se re-anula
    expect(im.crearPresupuesto).toHaveBeenCalledTimes(1);
    expect(body.ok).toBe(true);
    expect(body.numero_cambio).toBe(true);
    expect(body.solo_cantidades).toBe(false);
    expect(updates.some(([t, v]) => t === 'pedidos_vendedor' && v.estado === 'enviado')).toBe(true);
  });

  it('🔴 si el create salió bien y falla el anular, la edición SALIÓ BIEN: ok + aviso ámbar', async () => {
    // Si esto contestara error, el vendedor lo vuelve a guardar y crea un TERCERO.
    im.anularComprobante.mockResolvedValue({ ok: false, error: 'HTTP 500: IM se cayó' });

    const { status, body } = await editar(SURTIDO_NUEVO);

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.aviso).toContain('57999');   // el nuevo, donde quedó el pedido
    expect(body.aviso).toContain('57874');   // el viejo, que hay que anular a mano
    const upd = updates.filter(([t]) => t === 'pedidos_vendedor').pop()![1];
    expect(upd.im_presupuesto_id).toBe('58700001');
    expect(upd.im_error).toBeTruthy();
  });

  it('🔴 si IM no contesta el create, no se anula nada y el pedido queda congelado', async () => {
    im.crearPresupuesto.mockResolvedValue({ ok: false, sinRespuesta: true, error: 'timeout' });

    const { status, body } = await editar(SURTIDO_NUEVO);

    expect(im.anularComprobante).not.toHaveBeenCalled();
    expect(status).toBe(202);
    expect(body.sin_respuesta).toBe(true);
    expect(body.error).toContain('57874');
    expect(updates.some(([, v]) => v.estado === 'sin_respuesta')).toBe(true);
  });

  it('regresión: con la misma firma y el comprobante vivo sigue el camino barato', async () => {
    const { body } = await editar(SOLO_CANTIDADES);

    expect(im.crearPresupuesto).not.toHaveBeenCalled();
    expect(im.anularComprobante).not.toHaveBeenCalled();
    expect(im.actualizarPresupuestoCantidades).toHaveBeenCalledTimes(1);
    expect(body.ok).toBe(true);
    expect(body.solo_cantidades).toBe(true);
  });
});

/**
 * Las tres salidas de error que quedan DESPUÉS de que IM ya se movió. Son el punto ciego del
 * archivo: para cuando se llega acá el presupuesto nuevo ya existe y el viejo ya está anulado,
 * así que irse sin dejar registro no es "fallar", es perder de vista un comprobante vivo y
 * facturable. El fake de arriba devuelve `error: null` para todo, así que ninguna de las tres
 * estaba ejercitada.
 */
function fakeSbConFallas(fallas: { del?: string; ins?: string; updFinal?: string }) {
  im.sbMock.mockImplementation(() => ({
    from: (t: string) => {
      let res: any = t === 'pedidos_vendedor'
        ? { data: PEDIDO, error: null }
        : { data: ACTUALES, error: null };
      const q: any = {
        then: (r: any, j: any) => Promise.resolve(res).then(r, j),
        maybeSingle: () => Promise.resolve(res),
        update: (v: any) => {
          updates.push([t, v]);
          if (t === 'pedidos_vendedor' && fallas.updFinal) res = { data: null, error: { message: fallas.updFinal } };
          return q;
        },
        delete: () => { if (fallas.del) res = { data: null, error: { message: fallas.del } }; return q; },
        insert: () => { if (fallas.ins) res = { data: null, error: { message: fallas.ins } }; return q; },
      };
      for (const m of ['select', 'eq', 'order']) q[m] = () => q;
      return q;
    },
  }));
}

describe('editarPedido — que no se pierda de vista un presupuesto vivo', () => {
  it('🔴 si falla el DELETE de renglones, igual queda guardado el id del presupuesto NUEVO', async () => {
    // 🪤 Acá se salía con un 500 sin escribir nada, y `imUpdate` vive sólo en memoria: la fila
    // quedaba apuntando al presupuesto VIEJO (recién anulado) y el NUEVO sin dueño. El vendedor
    // reintenta, `yaAnulado` fuerza recrear, y como el viejo ya está anulado no se anula nada:
    // cada reintento suma OTRO presupuesto vivo y facturable del mismo pedido.
    fakeSbConFallas({ del: 'PostgREST 503' });

    const { status } = await editar(SURTIDO_NUEVO);

    expect(status).toBe(500);
    const upd = updates.filter(([t]) => t === 'pedidos_vendedor').pop()?.[1];
    expect(upd?.im_presupuesto_id).toBe('58700001');   // el NUEVO, no el viejo
    expect(upd?.estado).toBe('error');
  });

  it('🔴 si falla el guardado final, no contesta ok limpio: avisa con qué número quedó en IM', async () => {
    // 🪤 Este update sólo miraba `data`. Con un error transitorio contestaba ok:true y verde,
    // con la fila apuntando al viejo anulado y el nuevo huérfano: nadie sabía su número.
    fakeSbConFallas({ updFinal: 'timeout del pool' });

    const { body } = await editar(SURTIDO_NUEVO);

    expect(body.aviso).toBeTruthy();
    expect(body.aviso).toContain('57999');   // el número que hay que anotar
  });

  it('🔴 el aviso de "quedaron los DOS vivos" no lo pisa el error de renglones', async () => {
    // 🪤 Los dos textos iban a la misma columna `im_error` y el segundo pisaba al primero:
    // se borraba justo el aviso que evita que le facturen dos veces al cliente.
    im.anularComprobante.mockResolvedValue({ ok: false, error: 'HTTP 500: IM se cayó' });
    fakeSbConFallas({ ins: 'no se pudo insertar' });

    const { status } = await editar(SURTIDO_NUEVO);

    expect(status).toBe(500);
    const upd = updates.filter(([t]) => t === 'pedidos_vendedor').pop()?.[1];
    expect(upd?.im_error).toContain('57874');     // el viejo, que hay que anular a mano
    expect(upd?.im_error).toContain('renglones'); // y el problema nuevo, sin tapar al anterior
  });
});
