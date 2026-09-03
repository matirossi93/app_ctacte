import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Un pedido queda en `sin_respuesta` cuando IM tarda más de 25 s al crear el presupuesto de
 * reemplazo: la app corta sin saber si entró, y a propósito no anula el viejo (si el nuevo no
 * entró, anularlo dejaría al cliente sin pedido). El agujero era que nadie lo resolvía DESPUÉS:
 * el 02/09/2026 quedaron dos pares de presupuestos vivos y facturables del mismo cliente
 * (PARRILLA 58067/58068 y DIAZ 58071/58072) que hubo que reconciliar a mano.
 *
 * La regla que se testea acá: **sólo se actúa sobre hechos seguros**. Un falso "no entró"
 * recrearía el presupuesto y duplicaría, que es justo lo que se quiere evitar.
 */

vi.hoisted(() => {
  process.env.IM_USUARIO_PEDIDOS = 'susana';
  process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret';
});

const im = vi.hoisted(() => ({
  buscarPresupuestoPorCompatibilidad: vi.fn(),
  cabeceraComprobante: vi.fn(),
  anularComprobante: vi.fn(),
  desconfirmarPresupuesto: vi.fn(),
  getItemsComprobante: vi.fn(),
  sbMock: vi.fn(),
}));

vi.mock('./infomanager.js', () => ({
  buscarPresupuestoPorCompatibilidad: im.buscarPresupuestoPorCompatibilidad,
  cabeceraComprobante: im.cabeceraComprobante,
  anularComprobante: im.anularComprobante,
  desconfirmarPresupuesto: im.desconfirmarPresupuesto,
  getItemsComprobante: im.getItemsComprobante,
  fechaArgentina: (d?: any) => (d == null ? '2026-09-03' : new Date(d).toISOString().slice(0, 10)),
  crearPresupuesto: vi.fn(),
  actualizarPresupuestoCantidades: vi.fn(),
  presupuestoFacturado: vi.fn(),
  fechaComprobante: vi.fn(),
  getPrecioLista: vi.fn(),
  fetchVendedores: vi.fn(),
  fetchArticulosCatalogo: vi.fn(),
  getDisponibleCliente: vi.fn(),
  fetchClientesIMCached: vi.fn(),
  fetchArticulosDeDeposito: vi.fn(),
  fetchPreciosDeLista: vi.fn(),
}));
vi.mock('./supabase.js', () => ({ sb: im.sbMock, TENANT_ID: 'test-tenant', hasSupabase: () => true }));

const { reconciliarSinRespuesta } = await import('./pedidos.js');

/** Todo lo que se escribe, en orden: [tabla, valores]. */
let updates: Array<[string, any]> = [];
let borrados: string[] = [];
let insertados: Array<[string, any]> = [];

function fakeSb() {
  im.sbMock.mockImplementation(() => ({
    from: (t: string) => {
      const q: any = {
        then: (r: any, j: any) => Promise.resolve({ data: null, error: null }).then(r, j),
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        update: (v: any) => { updates.push([t, v]); return q; },
        insert: (v: any) => { insertados.push([t, v]); return q; },
        delete: () => { borrados.push(t); return q; },
      };
      for (const m of ['select', 'eq', 'order', 'in']) q[m] = () => q;
      return q;
    },
  }));
}

/** Un pedido colgado por timeout al editar: tiene presupuesto viejo y código guardado. */
const COLGADO = {
  id: 'ped-1', estado: 'sin_respuesta', cod_cliente: 727, cliente_nombre: 'PARRILLA',
  im_presupuesto_id: '58706782', im_numero: 58067, im_punto_de_venta: 1,
  im_cod_compatibilidad: 'abc12345',
  created_at: '2026-09-02T12:00:00.000Z', updated_at: '2026-09-02T12:00:00.000Z',
};
const clonar = (extra: any = {}) => ({ ...COLGADO, ...extra });

beforeEach(() => {
  updates = []; borrados = []; insertados = [];
  for (const f of Object.values(im)) (f as any).mockReset?.();
  fakeSb();
  im.anularComprobante.mockResolvedValue({ ok: true, raw: {} });
  im.desconfirmarPresupuesto.mockResolvedValue({ ok: true });
  im.getItemsComprobante.mockResolvedValue([{ id: 1, cod_articulo: 100, cantidad: 5, cod_lista_precios: 12 }]);
});

describe('reconciliarSinRespuesta — el pedido colgado por timeout de IM', () => {
  it('🔴 SÍ ENTRÓ: adopta el presupuesto nuevo y anula el viejo', async () => {
    // El caso PARRILLA: IM había creado el 58068 pero no contestó a tiempo.
    im.buscarPresupuestoPorCompatibilidad.mockResolvedValue({
      busquedaOk: true, encontrado: { id: '58706797', numero: 58068, fecha: '2026-09-04' },
    });
    im.cabeceraComprobante.mockResolvedValue({ fecha: '2026-09-02', anulada: false, existe: true });

    const p = clonar();
    await reconciliarSinRespuesta([p]);

    expect(im.anularComprobante).toHaveBeenCalledTimes(1);
    expect(im.anularComprobante.mock.calls[0][0].id).toBe('58706782');   // el VIEJO
    const upd = updates.filter(([t]) => t === 'pedidos_vendedor').pop()![1];
    expect(upd.estado).toBe('enviado');
    expect(upd.im_presupuesto_id).toBe('58706797');
    expect(upd.im_numero).toBe(58068);
    // El objeto en memoria también, porque la lista se contesta con él.
    expect(p.estado).toBe('enviado');
    expect(p.im_numero).toBe(58068);
  });

  it('🔴 SÍ ENTRÓ: reescribe los renglones con los que IM tiene de verdad', async () => {
    // El camino del timeout corta ANTES de guardar los renglones editados, así que en la app
    // quedaron los de antes de editar. Sin esto el vendedor ve un pedido que no es el que está
    // en IM.
    im.buscarPresupuestoPorCompatibilidad.mockResolvedValue({
      busquedaOk: true, encontrado: { id: '58706797', numero: 58068, fecha: '2026-09-04' },
    });
    im.cabeceraComprobante.mockResolvedValue({ fecha: '2026-09-02', anulada: false, existe: true });

    await reconciliarSinRespuesta([clonar()]);

    expect(borrados).toContain('pedidos_vendedor_items');
    const ins = insertados.find(([t]) => t === 'pedidos_vendedor_items');
    expect(ins![1][0].cod_articulo).toBe(100);
  });

  it('🔴 si el nuevo entró pero NO se pudo anular el viejo, queda escrito el aviso', async () => {
    // Quedan los dos vivos igual, pero a la vista. El silencio era el problema.
    im.buscarPresupuestoPorCompatibilidad.mockResolvedValue({
      busquedaOk: true, encontrado: { id: '58706797', numero: 58068, fecha: '2026-09-04' },
    });
    im.cabeceraComprobante.mockResolvedValue({ fecha: '2026-09-02', anulada: false, existe: true });
    im.anularComprobante.mockResolvedValue({ ok: false, error: 'HTTP 500' });

    await reconciliarSinRespuesta([clonar()]);

    const upd = updates.filter(([t]) => t === 'pedidos_vendedor').pop()![1];
    expect(upd.im_presupuesto_id).toBe('58706797');
    expect(upd.im_error).toContain('58067');
    expect(upd.im_error).toMatch(/no se pudo anular/i);
    expect(im.desconfirmarPresupuesto).not.toHaveBeenCalled();   // tiene que seguir a la vista
  });

  it('🔴 NO ENTRÓ y el viejo sigue vivo: el pedido se destraba con el presupuesto original', async () => {
    im.buscarPresupuestoPorCompatibilidad.mockResolvedValue({ busquedaOk: true, encontrado: null });
    im.cabeceraComprobante.mockResolvedValue({ fecha: '2026-09-02', anulada: false, existe: true });

    const p = clonar();
    await reconciliarSinRespuesta([p]);

    expect(im.anularComprobante).not.toHaveBeenCalled();
    const upd = updates.filter(([t]) => t === 'pedidos_vendedor').pop()![1];
    expect(upd.estado).toBe('enviado');
    expect(upd.im_presupuesto_id).toBeUndefined();   // sigue apuntando al viejo
    expect(p.estado).toBe('enviado');
  });

  it('🔴 NO PUDO BUSCAR: no se toca nada', async () => {
    // "No pude preguntar" no es "no está". Tratarlos igual es lo que duplica.
    im.buscarPresupuestoPorCompatibilidad.mockResolvedValue({ busquedaOk: false, encontrado: null });

    const p = clonar();
    await reconciliarSinRespuesta([p]);

    expect(updates).toHaveLength(0);
    expect(im.anularComprobante).not.toHaveBeenCalled();
    expect(p.estado).toBe('sin_respuesta');
  });

  it('🔴 el viejo está anulado o borrado y el nuevo no aparece: no se toca (hace falta un humano)', async () => {
    im.buscarPresupuestoPorCompatibilidad.mockResolvedValue({ busquedaOk: true, encontrado: null });
    im.cabeceraComprobante.mockResolvedValue({ fecha: null, anulada: null, existe: false });

    await reconciliarSinRespuesta([clonar()]);

    expect(updates).toHaveLength(0);
  });

  it('un pedido sin cod_compatibilidad (anterior a la migración 031) se saltea', async () => {
    await reconciliarSinRespuesta([clonar({ im_cod_compatibilidad: null })]);
    expect(im.buscarPresupuestoPorCompatibilidad).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('los pedidos que no están en sin_respuesta ni se miran', async () => {
    await reconciliarSinRespuesta([clonar({ estado: 'enviado' }), clonar({ estado: 'facturado' })]);
    expect(im.buscarPresupuestoPorCompatibilidad).not.toHaveBeenCalled();
  });

  it('si ya apuntaba al presupuesto encontrado, no lo anula a sí mismo', async () => {
    // 🪤 Sin este corte, el pedido se anularía su PROPIO presupuesto: el viejo y el nuevo son
    // el mismo id, y el "anular el viejo" lo mataría.
    im.buscarPresupuestoPorCompatibilidad.mockResolvedValue({
      busquedaOk: true, encontrado: { id: '58706782', numero: 58067, fecha: '2026-09-02' },
    });

    await reconciliarSinRespuesta([clonar()]);

    expect(im.anularComprobante).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });
});
