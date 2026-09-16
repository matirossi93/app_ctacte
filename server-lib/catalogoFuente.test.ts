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

/**
 * 🪤 16/09/2026: este test venía pasando con un campo que IM NO manda. La fila de prueba decía
 * `iva_por` —así se llama en los renglones de un comprobante— y el parseo leía lo mismo, así que
 * los dos estaban de acuerdo y los dos equivocados. En `/articulos` el campo se llama `iva`:
 * medido en producción, 0 de 1874 artículos traían alícuota. Un test escrito contra la respuesta
 * inventada confirma el código, no la realidad.
 */
it('conserva IVA explícito y distingue ausencia de tasa cero sin otra descarga', async()=>{
  const get=mockIM([[{...art(1,'A'),iva:'10.5'},art(2,'B'),{...art(3,'C'),iva:0}]]);
  const cat=await fetchArticulosCatalogo(); expect(cat.get(1)?.iva_por).toBe(10.5);expect(cat.get(2)?.iva_por).toBeNull();expect(cat.get(3)?.iva_por).toBe(0);expect(get).toHaveBeenCalledTimes(1);
});

it('🔴 el nombre viejo ya no alcanza: si IM vuelve a mandar sólo `iva_por`, queda en "no sé"', async()=>{
  // Sin esto, un rename de IM volvería a dejar el catálogo entero sin alícuota en silencio.
  mockIM([[{...art(9,'X'),iva_por:21}]]);
  expect((await fetchArticulosCatalogo()).get(9)?.iva_por).toBeNull();
});
