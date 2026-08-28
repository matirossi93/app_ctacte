import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });

const im = vi.hoisted(() => ({ presupuestoFacturado: vi.fn(), sbMock: vi.fn() }));
vi.mock('./infomanager.js', () => ({
  presupuestoFacturado: im.presupuestoFacturado,
  crearPresupuesto: vi.fn(), anularComprobante: vi.fn(), getPrecioLista: vi.fn(),
  getDisponibleCliente: vi.fn(), fetchClientesIMCached: vi.fn(), fetchArticulosCatalogo: vi.fn(),
  fetchArticulosDeDeposito: vi.fn(), getItemsComprobante: vi.fn(),
  actualizarPresupuestoCantidades: vi.fn(), cabeceraComprobante: vi.fn(), fechaComprobante: vi.fn(),
  fechaArgentina: vi.fn(), fetchVendedores: vi.fn(), fetchPreciosDeLista: vi.fn(),
}));
vi.mock('./supabase.js', () => ({ sb: im.sbMock, TENANT_ID: 't', hasSupabase: () => true }));

const { marcarFacturados } = await import('./pedidos.js');

/**
 * Si Jorgelina ya facturó el presupuesto, el vendedor NO tiene que poder editarlo ni anularlo
 * — y sobre todo tiene que ENTERARSE. El chequeo existía pero sólo corría al tocar Editar, así
 * que hasta ahí el pedido figuraba "Enviado a IM" como cualquier otro. Medido en producción el
 * 28/08/2026: 2 de 9 "enviados" ya estaban facturados ($429.089 y $136.776).
 */

/** Lo que se le mandó a Supabase: [ids, valores]. */
let updates: Array<[string[], any]> = [];

beforeEach(() => {
  updates = [];
  im.presupuestoFacturado.mockReset();
  im.sbMock.mockImplementation(() => ({
    from: () => ({
      update: (v: any) => ({ in: (_col: string, ids: string[]) => { updates.push([ids, v]); return Promise.resolve({ error: null }); } }),
    }),
  }));
});

/** Cada test usa ids propios: la cache de "todavía no" es estado de módulo compartido. */
const ped = (id: string, pr: string, estado = 'enviado') =>
  ({ id, im_presupuesto_id: pr, estado });

describe('marcarFacturados', () => {
  it('🔴 un pedido que la oficina ya facturó queda facturado y se persiste', async () => {
    im.presupuestoFacturado.mockResolvedValue({ facturado: true });
    const ps = [ped('a1', 'PR-100')];

    await marcarFacturados(ps);

    expect(ps[0].estado).toBe('facturado');            // lo ve el vendedor en la lista
    expect(updates).toEqual([[['a1'], { estado: 'facturado' }]]);   // y no se vuelve a consultar
  });

  it('🔴 si IM no contesta NO se toca nada: nunca inventar "libre" ni "facturado"', async () => {
    im.presupuestoFacturado.mockResolvedValue({ facturado: false, desconocido: true });
    const ps = [ped('b1', 'PR-200')];

    await marcarFacturados(ps);

    expect(ps[0].estado).toBe('enviado');
    expect(updates).toEqual([]);
  });

  it('sólo consulta los `enviado` con presupuesto: los demás no le cuestan a IM', async () => {
    im.presupuestoFacturado.mockResolvedValue({ facturado: true });
    const ps = [
      ped('c1', 'PR-300', 'anulado'),
      ped('c2', 'PR-301', 'facturado'),
      ped('c3', 'PR-302', 'borrador'),
      { id: 'c4', im_presupuesto_id: null, estado: 'enviado' },   // nunca llegó a IM
    ];

    await marcarFacturados(ps);

    expect(im.presupuestoFacturado).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it('el "todavía no" se cachea: abrir la lista de nuevo no vuelve a pegarle a IM', async () => {
    im.presupuestoFacturado.mockResolvedValue({ facturado: false });

    await marcarFacturados([ped('d1', 'PR-400')]);
    await marcarFacturados([ped('d1', 'PR-400')]);

    expect(im.presupuestoFacturado).toHaveBeenCalledTimes(1);
  });

  it('un `desconocido` NO se cachea: el próximo listado vuelve a preguntar', async () => {
    // Cachear el fallo dejaría el pedido mostrándose mal durante toda la ventana de cache.
    im.presupuestoFacturado.mockResolvedValue({ facturado: false, desconocido: true });

    await marcarFacturados([ped('e1', 'PR-500')]);
    await marcarFacturados([ped('e1', 'PR-500')]);

    expect(im.presupuestoFacturado).toHaveBeenCalledTimes(2);
  });

  it('con varios facturados, se persisten todos de una sola vez', async () => {
    im.presupuestoFacturado.mockResolvedValue({ facturado: true });

    await marcarFacturados([ped('f1', 'PR-600'), ped('f2', 'PR-601')]);

    expect(updates).toHaveLength(1);
    expect(updates[0][0]).toEqual(['f1', 'f2']);
  });
});
