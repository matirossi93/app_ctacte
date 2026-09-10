import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Los dos filtros que limpian la pantalla de hojas de ruta (Mati, 09/09/2026):
 *   · sólo CASA CENTRAL — es la única que despacha con hoja de ruta;
 *   · nada anterior al ARRANQUE del método — lo de antes ya salió por el circuito viejo.
 *
 * Medido ese día: de los remitos vivos de una semana, 182 eran de Casa Central y **1.852 de las
 * sucursales**. Nueve de cada diez filas eran ruido.
 */
vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });

const m = vi.hoisted(() => ({ fetchVentas: vi.fn(), fetchVentasItems: vi.fn(), sbMock: vi.fn() }));
vi.mock('./infomanager.js', () => ({
  // El cache de /ventas se limpia junto con las vistas (10/09/2026).
  invalidarCacheVentas: vi.fn(),
  invalidarCacheItems: vi.fn(),
  fetchVentas: m.fetchVentas,
  fetchVentasItems: m.fetchVentasItems,
  fetchArticulosCatalogo: vi.fn(async () => new Map()),
  fetchClientesIMCached: vi.fn(async () => []),
}));
vi.mock('./supabase.js', () => ({ sb: m.sbMock, TENANT_ID: 't', hasSupabase: () => true }));
vi.mock('./aparearFactura.js', () => ({ aparearFacturas: vi.fn(() => new Map()) }));

const { vistaRemitos, invalidarRemitos } = await import('./vistaRemitos.js');

const RE = (id: string, cod_empresa: number, fecha = '2026-09-10') => ({
  id, numero: Number(id), tipo_comprobante: 'RE', anulada: 'N',
  cod_empresa, punto_de_venta: cod_empresa === 1 ? 7 : 888,
  fecha, cod_cliente: 7, total: 1000,
});

beforeEach(() => {
  vi.clearAllMocks();
  invalidarRemitos();
  m.fetchVentasItems.mockResolvedValue([]);
  // Supabase: ninguna hoja, ningún retiro.
  m.sbMock.mockImplementation(() => ({
    from: () => {
      const q: any = {
        select: () => q, eq: () => q, in: () => q, gte: () => q, lte: () => q,
        then: (r: any, j: any) => Promise.resolve({ data: [], error: null }).then(r, j),
      };
      return q;
    },
  }));
});

describe('vistaRemitos — sólo Casa Central', () => {
  it('🔴 los remitos de las sucursales NO entran', async () => {
    m.fetchVentas.mockResolvedValue([RE('1', 1), RE('2', 2), RE('3', 3), RE('4', 4)]);
    const v = await vistaRemitos('2026-09-10', '2026-09-10', true);
    const ids = [...v.pendientes, ...v.asignados].map((f: any) => String(f.im_comprobante_id));
    expect(ids).toEqual(['1']);
  });
});

describe('vistaRemitos — nada anterior al arranque', () => {
  it('🔴 un rango entero anterior al arranque devuelve vacío sin consultar InfoManager', async () => {
    const v = await vistaRemitos('2026-08-01', '2026-08-31', true);
    expect(v.pendientes).toEqual([]);
    expect(m.fetchVentas).not.toHaveBeenCalled();
  });

  it('un rango que arranca antes se recorta al arranque, no se rechaza', async () => {
    m.fetchVentas.mockResolvedValue([RE('1', 1)]);
    await vistaRemitos('2026-08-01', '2026-09-10', true);
    expect((m.fetchVentas.mock.calls[0] as any[])[0]).toBe('2026-09-09');
  });
});
