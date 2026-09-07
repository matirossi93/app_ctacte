import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

/**
 * 🪤 04/09/2026, segunda causa del mismo síntoma. El catálogo salía de `/articulos/stock`, que
 * sólo devuelve los artículos que tienen FICHA DE STOCK. Un artículo que nunca tuvo movimiento
 * no aparece ahí, así que para la app directamente no existía — ni siquiera como "sin stock".
 *
 * Así es como MANI SABORIZADO PANCETA (775) seguía sin aparecer después de arreglar el filtro
 * por depósito: PIZZA (772) sí estaba en el catálogo y se filtraba por stock, pero PANCETA no
 * estaba en el catálogo en absoluto.
 *
 * Medido contra IM: `/articulos/stock` traía 1.422 y `/articulos` trae 1.991 (1.856
 * habilitados). De los 569 que faltaban, 80 estaban habilitados y con precio en Lista 1 —
 * COMINO PURO entre ellos, que es de los que más se fraccionan.
 */

vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });
vi.mock('axios', () => ({ default: { post: vi.fn(), create: vi.fn() } }));

const { fetchArticulosCatalogo, invalidateArticulosCatalogo } = await import('./infomanager.js');

/** Simula IM: devuelve `paginas` y registra qué se pidió. */
function mockIM(paginas: any[][]) {
  const get = vi.fn(async (url: string, cfg?: any) => {
    if (url === '/articulos') {
      const p = Number(cfg?.params?.page ?? 1);
      return { data: { results: paginas[p - 1] ?? [] } };
    }
    throw new Error(`endpoint inesperado: ${url}`);
  });
  vi.mocked(axios.create).mockReturnValue({
    get, post: vi.fn(), put: vi.fn(), interceptors: { request: { use: vi.fn() } },
  } as any);
  vi.mocked(axios.post).mockResolvedValue({ data: { token: 'tok' } } as any);
  return get;
}

const art = (cod: number, descripcion: string, habilitado = 1) => ({
  cod_articulo: cod, descripcion, habilitado,
  cod_rubro: 10, subrubro: 'Maní', unidad_de_medida: 'Unidad', equivalencia_um: 1, precio_venta: 4595,
});

beforeEach(() => { vi.clearAllMocks(); invalidateArticulosCatalogo(); });

describe('fetchArticulosCatalogo — de dónde sale el catálogo', () => {
  it('🔴 sale de /articulos, NO de /articulos/stock', async () => {
    // /articulos/stock deja afuera lo que nunca tuvo movimiento. Si alguien vuelve a ese
    // endpoint, este test lo frena: el mock tira si le piden otra cosa.
    const get = mockIM([[art(775, 'MANI SABORIZADO PANCETA')]]);
    const map = await fetchArticulosCatalogo();
    expect(get.mock.calls[0][0]).toBe('/articulos');
    expect(map.has(775)).toBe(true);
    expect(map.get(775)!.descripcion).toBe('MANI SABORIZADO PANCETA');
  });

  it('🔴 pagina hasta traer todo', async () => {
    // Son ~1.991 artículos y IM pagina: quedarse con la primera página perdería la mitad.
    const p1 = Array.from({ length: 1000 }, (_, i) => art(i + 1, `ART ${i + 1}`));
    const p2 = [art(2001, 'COMINO PURO'), art(2002, 'MANI SABORIZADO PANCETA')];
    await fetchArticulosCatalogo();
    invalidateArticulosCatalogo();
    mockIM([p1, p2]);
    const map = await fetchArticulosCatalogo();
    expect(map.size).toBe(1002);
    expect(map.has(2001)).toBe(true);
  });

  it('🔴 los deshabilitados NO entran', async () => {
    // Un artículo dado de baja no se vende. Hoy se colaban 7 por este camino.
    mockIM([[art(1, 'VIVO'), art(2, 'DE BAJA', 0)]]);
    const map = await fetchArticulosCatalogo();
    expect(map.has(1)).toBe(true);
    expect(map.has(2)).toBe(false);
  });

  it('mapea rubro y unidad de medida, que es lo que usa el control de listas', async () => {
    mockIM([[{ ...art(400, 'ALPISTE'), cod_rubro: 7, subrubro: 'Semillas', unidad_de_medida: 'Kilos', equivalencia_um: 1 }]]);
    const map = await fetchArticulosCatalogo();
    const a = map.get(400)!;
    expect(a.cod_rubro).toBe(7);
    expect(a.subrubro).toBe('Semillas');
    expect(a.unidad_de_medida).toBe('Kilos');
    expect(a.equivalencia_um).toBe(1);
  });
});
