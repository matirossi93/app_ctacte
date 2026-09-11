import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ANULAR UN PRESUPUESTO DESDE EL PANEL.
 *
 * Mati (10/09/2026): *"ver la manera de tener la opción de anular algún presupuesto"* y
 * *"Bianconi sigue apareciendo en la app y eso ya lo resolvimos"*.
 *
 * 🔑 El caso de Bianconi explica para qué sirve: el PR 58288 estaba en `tipo_presupuesto: 'NC'`
 * (desconfirmado) pero con `anulada: 'N'`, y la vista filtra los ANULADOS, no los desconfirmados.
 * Desconfirmar no lo saca de la lista; anularlo sí.
 *
 * 🔴 Y no se puede filtrar por `tipo_presupuesto` en su lugar: medido el 10/09/2026, 30 de los 47
 * pedidos vivos de un solo vendedor estaban en 'NC'. Ese filtro escondería pedidos reales.
 */
vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });

const m = vi.hoisted(() => ({
  anularComprobante: vi.fn(),
  cabeceraComprobante: vi.fn(),
}));
vi.mock('./infomanager.js', () => { const fuente = {
  // El cache de /ventas se limpia junto con las vistas (10/09/2026).
  invalidarCacheVentas: vi.fn(),
  invalidarCacheItems: vi.fn(),
  anularComprobante: m.anularComprobante,
  cabeceraComprobante: m.cabeceraComprobante,
  fechaArgentina: () => '2026-09-10',
}; return { ...fuente, invalidarIM: vi.fn(), leerComprobante: async (id: string) => ({ cabecera: await (fuente as any).cabeceraComprobante(id), items: await (fuente as any).getItemsComprobante(id) }) }; });
vi.mock('./vistaPresupuestos.js', () => ({ invalidarVista: vi.fn() }));
vi.mock('./vistaRemitos.js', () => ({ invalidarRemitos: vi.fn() }));

let facturado: any = null;
vi.mock('./supabase.js', () => ({
  TENANT_ID: 't',
  sb: () => ({
    rpc: async () => ({ data:true,error:null }),
    from: () => ({
      delete: () => ({ eq: () => ({ eq: async () => ({data:null,error:null}) }) }),
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: facturado, error: null }) }) }) }),
    }),
  }),
}));

const { anularPresupuesto } = await import('./anularPresupuesto.js');

function llamar(body: any, rol = 'admin') {
  const req: any = { params: { comprobanteId: body.id ?? '58777277' }, body, user: { rol, sub: 'u1' } };
  const res: any = {
    status(c: number) { this.statusCode = c; return this; },
    json(b: any) { this.body = b; return this; },
    statusCode: 200, body: null,
  };
  return anularPresupuesto(req, res).then(() => res);
}

const VIVO = { cod_empresa:1, tipo_comprobante:'PR', existe: true, anulada: false, numero: 58288, punto_de_venta: 1, fecha: '2026-09-10' };

describe('anularPresupuesto', () => {
  beforeEach(() => { vi.clearAllMocks(); facturado = null; });

  it('🔴 anula en InfoManager y lo saca de la vista', async () => {
    facturado = null;
    m.cabeceraComprobante.mockResolvedValue(VIVO);
    m.anularComprobante.mockResolvedValue({ ok: true });
    const r = await llamar({ motivo: 'lo resolvimos por IM' });
    expect(r.statusCode).toBe(200);
    expect(m.anularComprobante).toHaveBeenCalledTimes(1);
    // Va con tipo PR y su propio número: el body del PUT de IM los exige.
    expect(m.anularComprobante.mock.calls[0][0]).toMatchObject({ numero: 58288, tipo_comprobante: 'PR' });
  });

  /** 🔴 Lo que no puede pasar: anular un pedido que ya se facturó. La factura queda huérfana. */
  it('🔴 un presupuesto YA FACTURADO no se anula', async () => {
    facturado = { im_factura_numero: 50401, im_factura_id: 'f1' };
    m.cabeceraComprobante.mockResolvedValue(VIVO);
    const r = await llamar({});
    expect(r.statusCode).toBe(409);
    expect(String(r.body.error)).toMatch(/50401|facturad/i);
    expect(m.anularComprobante).not.toHaveBeenCalled();
  });

  it('🪤 uno que ya estaba anulado no se vuelve a anular: se avisa y listo', async () => {
    facturado = null;
    m.cabeceraComprobante.mockResolvedValue({ ...VIVO, anulada: true });
    const r = await llamar({});
    expect(r.statusCode).toBe(409);
    expect(m.anularComprobante).not.toHaveBeenCalled();
  });

  it('🪤 si ya no está en InfoManager no se inventa un error raro', async () => {
    facturado = null;
    m.cabeceraComprobante.mockResolvedValue({ existe: false, anulada: null, numero: null });
    const r = await llamar({});
    expect(r.statusCode).toBe(404);
  });

  /** 🪤 `existe: null` es "no pude preguntar", y no habilita a anular a ciegas. */
  it('🪤 si InfoManager no contesta, NO se anula', async () => {
    facturado = null;
    m.cabeceraComprobante.mockResolvedValue({ existe: null, anulada: null, numero: null });
    const r = await llamar({});
    expect(r.statusCode).toBe(502);
    expect(m.anularComprobante).not.toHaveBeenCalled();
  });

  it('🔴 lo hace administración, no cualquiera', async () => {
    facturado = null;
    m.cabeceraComprobante.mockResolvedValue(VIVO);
    const r = await llamar({}, 'vendedor');
    expect(r.statusCode).toBe(403);
    expect(m.anularComprobante).not.toHaveBeenCalled();
  });

  it('🪤 si IM rechaza la anulación se dice, no se da por hecha', async () => {
    facturado = null;
    m.cabeceraComprobante.mockResolvedValue(VIVO);
    m.anularComprobante.mockResolvedValue({ ok: false, error: 'no se puede' });
    const r = await llamar({});
    expect(r.statusCode).toBe(502);
    expect(String(r.body.error)).toMatch(/no se puede/);
  });

  it('el motivo viaja a las observaciones de InfoManager', async () => {
    facturado = null;
    m.cabeceraComprobante.mockResolvedValue(VIVO);
    m.anularComprobante.mockResolvedValue({ ok: true });
    await llamar({ motivo: 'cliente rechazó el pedido' });
    expect(String(m.anularComprobante.mock.calls.at(-1)![0].observaciones)).toMatch(/cliente rechazó el pedido/);
  });
});
