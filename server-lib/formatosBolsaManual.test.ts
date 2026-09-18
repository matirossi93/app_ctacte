import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * EL KILAJE QUE CARGA LA OFICINA MANDA SOBRE TODO LO DEMÁS.
 *
 * Mati (17/09/2026): *"van cambiando los kilajes de las bolsas, no son siempre iguales...
 * instantánea ahora tiene 20, arrollada por 30 y el sorgo por 40"*.
 *
 * La escalera, de más confiable a menos:
 *   1. Lo cargado a mano (tabla `formatos_bolsa`) — el que abrió la bolsa.
 *   2. Lo deducido de 30 días de pedidos — necesita 20 renglones, así que no llega a todos.
 *   3. Nada: la cantidad va como vino y la pantalla pide el dato.
 */
vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });
const m = vi.hoisted(() => ({ filas: vi.fn(), sbMock: vi.fn() }));
vi.mock('./infomanager.js', () => ({
  fechaArgentina: () => '2026-09-18',
  fetchVentas: async () => [],
  fetchArticulosCatalogo: async () => new Map(),
  fetchVentasItems: async () => [],
}));
vi.mock('./supabase.js', () => ({ sb: m.sbMock, TENANT_ID: 't', hasSupabase: () => true }));

const { formatosDeBolsa, _resetFormatos, FORMATOS_CONOCIDOS } = await import('./formatosBolsa.js');

/** Simula la tabla: `respuesta` es lo que contesta Supabase. */
function tabla(respuesta: { data?: any[]; error?: any }) {
  m.filas.mockResolvedValue(respuesta);
  m.sbMock.mockImplementation(() => ({
    from: () => {
      const q: any = { then: (fn: any) => m.filas().then(fn) };
      for (const k of ['select', 'eq']) q[k] = () => q;
      return q;
    },
  }));
}

beforeEach(() => { vi.clearAllMocks(); _resetFormatos(); });

describe('de dónde sale el kilaje de la bolsa', () => {
  it('🔑 lo cargado a mano le gana a lo deducido de los pedidos', async () => {
    // 🪤 Código que NO está en FORMATOS_CONOCIDOS a propósito: con uno de los ocho, el test
    // pasaba sin que la tabla existiera —la constante ya daba el número esperado— y confirmaba
    // el código en vez de la realidad.
    expect(FORMATOS_CONOCIDOS.has(9001)).toBe(false);
    _resetFormatos(new Map([[9001, 30]]));
    tabla({ data: [{ cod_articulo: 9001, kg: 40 }] });
    expect((await formatosDeBolsa()).get(9001)).toBe(40);
  });

  it('🔑 y también le gana a los ocho que estaban escritos en el código', async () => {
    // El SORGO (403) figura en 40 en la constante. Si el proveedor pasa a bolsas de 45, la
    // oficina lo corrige desde la pantalla y ese número es el que vale.
    expect(FORMATOS_CONOCIDOS.get(403)).toBe(40);
    tabla({ data: [{ cod_articulo: 403, kg: 45 }] });
    expect((await formatosDeBolsa()).get(403)).toBe(45);
  });

  it('🔑 sin fila cargada queda lo deducido', async () => {
    _resetFormatos(new Map([[500, 25]]));
    tabla({ data: [] });
    expect((await formatosDeBolsa()).get(500)).toBe(25);
  });

  it('🔴 un artículo sin kilaje en ningún lado NO recibe uno inventado', async () => {
    tabla({ data: [] });
    expect((await formatosDeBolsa()).has(99999)).toBe(false);
  });

  it('🪤 si la tabla no responde quedan los del código, no cero formatos', async () => {
    // Puede pasar entre el despliegue y la migración, o con Supabase caído. Perder los ocho
    // formatos ahí mandaría a fraccionar a mano medio listado.
    tabla({ error: { message: 'relation "formatos_bolsa" does not exist' } });
    const f = await formatosDeBolsa();
    for (const [cod, kg] of FORMATOS_CONOCIDOS) expect(f.get(cod)).toBe(kg);
  });
});
