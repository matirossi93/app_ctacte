import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 🔴 UNA FACTURA QUE NO SE PUEDE VERIFICAR NO PUEDE DEJAR SIN PANTALLA A TODAS LAS DEMÁS.
 *
 * El 12/09/2026 la pantalla de hojas no trajo NADA en el rango 09→14. La factura 58812033 había
 * sido borrada en InfoManager —`GET /ventas/{id}` contesta 500 'No se encontraron datos para el
 * id'— y esa única fila propagaba la excepción y tumbaba el listado entero. Con Cloudflare de
 * por medio, el 502 llegaba como HTML y la pantalla ni siquiera podía decir qué pasaba.
 */
vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });

const m = vi.hoisted(() => ({
  fetchVentas: vi.fn(), fetchVentasItems: vi.fn(), sbMock: vi.fn(), cabecera: vi.fn(),
}));
vi.mock('./infomanager.js', () => ({
  invalidarCacheVentas: vi.fn(), invalidarCacheItems: vi.fn(),
  fetchVentas: m.fetchVentas, fetchVentasItems: m.fetchVentasItems,
  fetchArticulosCatalogo: vi.fn(async () => new Map()),
  fetchClientesIMCached: vi.fn(async () => []),
  cabeceraComprobante: m.cabecera,
}));
vi.mock('./supabase.js', () => ({ sb: m.sbMock, TENANT_ID: 't', hasSupabase: () => true }));
// El apareo real vive en su propio módulo y su propio test: acá se le da el vínculo ya resuelto.
const apareo = vi.hoisted(() => ({ mapa: new Map<string, any>() }));
vi.mock('./aparearFactura.js', () => ({ aparearFacturas: () => apareo.mapa }));

const { vistaRemitos, invalidarRemitos } = await import('./vistaRemitos.js');
const { invalidarImportesFacturas } = await import('./importesFacturas.js');

/** Un remito de Casa Central con su factura vinculada. */
const RE = (id: string, facturaId: string, total = 1000) => ({
  id, numero: Number(id), tipo_comprobante: 'RE', anulada: 'N', cod_empresa: 1,
  punto_de_venta: 7, fecha: '2026-09-12', cod_cliente: 350, total,
  im_factura_id: facturaId,
});
const FA = (id: string, total: number) => ({
  id, numero: 50500 + Number(id.slice(-2)), tipo_comprobante: 'FA', tipo_factura: 'B',
  anulada: 'N', cod_empresa: 1, cod_cliente: 350, total, fecha: '2026-09-12',
});

let vinculos: any[] = [];
/** Ata cada remito con su factura, como haría el apareo real. */
const vincular = (pares: Array<[string, string, number]>) => {
  apareo.mapa = new Map(pares.map(([re, fa, numero]) => [re, { im_factura_id: fa, im_factura_numero: numero, im_factura_tipo: 'FA B', origen: 'nuestra' }]));
};

beforeEach(() => {
  vi.clearAllMocks(); invalidarRemitos(); invalidarImportesFacturas();
  apareo.mapa = new Map();
  m.fetchVentasItems.mockResolvedValue([]);
  vinculos = [];
  m.sbMock.mockImplementation(() => ({
    from: (t: string) => {
      const data = t === 'presupuestos_facturados' ? vinculos : [];
      const q: any = {
        select: () => q, eq: () => q, in: () => q, gte: () => q, lte: () => q, not: () => q, is: () => q, or: () => q, order: () => q, limit: () => q,
        then: (r: any, j: any) => Promise.resolve({ data, error: null }).then(r, j),
      };
      return q;
    },
  }));
});

describe('una factura que falta no tumba el listado', () => {
  it('🔑 las demás filas llegan, y la afectada viene SIN importe y con el motivo', async () => {
    vinculos = [
      { im_comprobante_id: '100', im_remito_id: '1', im_factura_id: '900', im_factura_numero: 50500, cod_cliente: 350, cod_empresa: 1 },
      { im_comprobante_id: '200', im_remito_id: '2', im_factura_id: '901', im_factura_numero: 50506, cod_cliente: 350, cod_empresa: 1 },
    ];
    vincular([['1', '900', 50500], ['2', '901', 50506]]);
    // La 901 NO está en el listado del rango y la lectura puntual dice que no existe.
    m.fetchVentas.mockResolvedValue([RE('1', '900'), RE('2', '901', 563780.91), FA('900', 1000)]);
    m.cabecera.mockResolvedValue({ existe: false, anulada: null, total: null });

    const v = await vistaRemitos('2026-09-09', '2026-09-14', true);
    const todas = [...v.pendientes, ...v.asignados, ...(v.conflictos_asignacion ?? [])];
    expect(todas.map((f: any) => String(f.im_comprobante_id)).sort()).toEqual(['1', '2']);

    const rota = todas.find((f: any) => String(f.im_comprobante_id) === '2') as any;
    expect(rota.total).toBeNull();
    expect(rota.total).not.toBe(0);
    expect(rota.importe_error).toBeTruthy();
    expect(rota.importe_fuente).toBe('no_verificado');
  });

  it('🔑 el vínculo con la factura se CONSERVA, aunque esté borrada', async () => {
    vinculos = [{ im_comprobante_id: '200', im_remito_id: '2', im_factura_id: '901', im_factura_numero: 50506, cod_cliente: 350, cod_empresa: 1 }];
    vincular([['2', '901', 50506]]);
    m.fetchVentas.mockResolvedValue([RE('2', '901', 563780.91)]);
    m.cabecera.mockResolvedValue({ existe: false, anulada: null, total: null });

    const v = await vistaRemitos('2026-09-09', '2026-09-14', true);
    const f = [...v.pendientes, ...v.asignados][0] as any;
    expect(String(f.im_factura_id)).toBe('901');
    expect(f.im_factura_numero).toBe(50506);
  });

  /** 🪤 El importe del remito NO reemplaza al de la factura: son cosas distintas. */
  it('🔑 no se cae al total del remito como importe', async () => {
    vinculos = [{ im_comprobante_id: '200', im_remito_id: '2', im_factura_id: '901', im_factura_numero: 50506, cod_cliente: 350, cod_empresa: 1 }];
    vincular([['2', '901', 50506]]);
    m.fetchVentas.mockResolvedValue([RE('2', '901', 563780.91)]);
    m.cabecera.mockResolvedValue({ existe: false, anulada: null, total: null });

    const f = [...(await vistaRemitos('2026-09-09', '2026-09-14', true)).pendientes][0] as any;
    expect(f.total).not.toBe(563780.91);
    expect(f.total).toBeNull();
  });

  it('🔑 el total agregado es null, no la suma de lo que sí se pudo verificar', async () => {
    vinculos = [
      { im_comprobante_id: '100', im_remito_id: '1', im_factura_id: '900', im_factura_numero: 50500, cod_cliente: 350, cod_empresa: 1 },
      { im_comprobante_id: '200', im_remito_id: '2', im_factura_id: '901', im_factura_numero: 50506, cod_cliente: 350, cod_empresa: 1 },
    ];
    vincular([['1', '900', 50500], ['2', '901', 50506]]);
    m.fetchVentas.mockResolvedValue([RE('1', '900'), RE('2', '901'), FA('900', 1000)]);
    m.cabecera.mockResolvedValue({ existe: false, anulada: null, total: null });

    const v: any = await vistaRemitos('2026-09-09', '2026-09-14', true);
    expect(v.totales.importe).toBeNull();
    expect(v.totales.importe_parcial).toBe(1000);
    expect(v.sin_verificar).toBe(1);
  });

  it('sin ninguna rota, el total sigue siendo un número y no hay parcial', async () => {
    vinculos = [{ im_comprobante_id: '100', im_remito_id: '1', im_factura_id: '900', im_factura_numero: 50500, cod_cliente: 350, cod_empresa: 1 }];
    vincular([['1', '900', 50500]]);
    m.fetchVentas.mockResolvedValue([RE('1', '900'), FA('900', 1000)]);

    const v: any = await vistaRemitos('2026-09-09', '2026-09-14', true);
    expect(v.totales.importe).toBe(1000);
    expect(v.totales.importe_parcial).toBeNull();
    expect(v.sin_verificar).toBe(0);
  });

  it('🪤 varias rotas se toleran todas: ninguna tumba la vista', async () => {
    vinculos = [
      { im_comprobante_id: '100', im_remito_id: '1', im_factura_id: '901', im_factura_numero: 1, cod_cliente: 350, cod_empresa: 1 },
      { im_comprobante_id: '200', im_remito_id: '2', im_factura_id: '902', im_factura_numero: 2, cod_cliente: 350, cod_empresa: 1 },
    ];
    vincular([['1', '901', 1], ['2', '902', 2]]);
    m.fetchVentas.mockResolvedValue([RE('1', '901'), RE('2', '902')]);
    m.cabecera.mockResolvedValue({ existe: false, anulada: null, total: null });

    const v: any = await vistaRemitos('2026-09-09', '2026-09-14', true);
    expect([...v.pendientes, ...v.asignados]).toHaveLength(2);
    expect(v.sin_verificar).toBe(2);
  });
});

/**
 * 🔴 Y la otra mitad: un pedido sin importe acreditado tampoco puede entrar a una hoja por API.
 * La pantalla lo bloquea, pero el backend no puede confiar en eso.
 */
describe('el camino de asignar no acepta un importe sin acreditar', () => {
  it('🔑 `enriquecerEntregas` sin tolerar lanza cuando la factura no se puede verificar', async () => {
    const { enriquecerEntregas } = await import('./repartoDatos.js');
    m.cabecera.mockResolvedValue({ existe: false, anulada: null, total: null });
    m.fetchVentas.mockResolvedValue([]);
    await expect(enriquecerEntregas([
      { im_comprobante_id: '2', im_factura_id: '901', cod_cliente: 350, cod_empresa: 1, total: 563780.91, fecha: '2026-09-12' },
    ] as any)).rejects.toThrow(/No pude verificar/i);
  });

  it('🪤 y con tolerancia explícita devuelve la fila marcada, sin importe', async () => {
    const { enriquecerEntregas } = await import('./repartoDatos.js');
    m.cabecera.mockResolvedValue({ existe: false, anulada: null, total: null });
    m.fetchVentas.mockResolvedValue([]);
    const [f] = await enriquecerEntregas([
      { im_comprobante_id: '2', im_factura_id: '901', cod_cliente: 350, cod_empresa: 1, total: 563780.91, fecha: '2026-09-12' },
    ] as any, false, true, true) as any[];
    expect(f.total).toBeNull();
    expect(f.importe_error).toBeTruthy();
  });
});

