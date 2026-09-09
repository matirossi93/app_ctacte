import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

/**
 * 🔑 Un cliente dado de alta hace un rato tiene que aparecer YA.
 *
 * El maestro de clientes se cachea 30 minutos. Mati (09/09/2026): *"uno de los chicos cargó un
 * presupuesto con un cliente genérico, creamos el cliente nuevo y lo cambiamos en el presupuesto,
 * pero no sale el nombre, figura como cliente número 1347"*. Y lo que no se veía: sin el cliente
 * en la lista tampoco se sabe su condición de IVA, así que no se podía facturar hasta que
 * venciera el cache.
 */

vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });
vi.mock('axios', () => ({ default: { post: vi.fn(), create: vi.fn() } }));

const { fetchClientesIMCon, invalidateImToken } = await import('./infomanager.js');

/** Cada llamada al maestro devuelve la lista siguiente: así se ve si fue a buscar de nuevo. */
function mockMaestro(...respuestas: Array<Array<{ cod_cliente: number; razon_social: string }>>) {
  let i = 0;
  const get = vi.fn(async (url: string) => {
    if (!url.includes('/clientes')) return { data: {} };
    const lista = respuestas[Math.min(i, respuestas.length - 1)];
    i += 1;
    return { data: { results: lista, nextPage: null } };
  });
  vi.mocked(axios.create).mockReturnValue({
    get, post: vi.fn(), put: vi.fn(), interceptors: { request: { use: vi.fn() } },
  } as any);
  vi.mocked(axios.post).mockResolvedValue({ data: { token: 'tok' } } as any);
  return get;
}

const VIEJOS = [{ cod_cliente: 7, razon_social: 'FORRAJERIA EL SOL' }];
const CON_NUEVO = [...VIEJOS, { cod_cliente: 1347, razon_social: 'LEAL, Paulina (Este)' }];

beforeEach(() => { vi.clearAllMocks(); invalidateImToken(); });

describe('fetchClientesIMCon', () => {
  it('🔑 si falta un código, va a buscar el maestro de nuevo y lo encuentra', async () => {
    mockMaestro(VIEJOS, CON_NUEVO);
    const cs = await fetchClientesIMCon([7, 1347]);
    expect(cs.find((c: any) => Number(c.cod_cliente) === 1347)?.razon_social).toBe('LEAL, Paulina (Este)');
  });

  it('si están todos, no le pide nada a InfoManager de más', async () => {
    const get = mockMaestro(CON_NUEVO);
    await fetchClientesIMCon([7, 1347]);
    const antes = get.mock.calls.length;
    await fetchClientesIMCon([7, 1347]);
    expect(get.mock.calls.length).toBe(antes);
  });

  /**
   * 🪤 Un `cod_cliente` que de verdad no existe —un comprobante viejo, un dato mal cargado— no
   * puede hacer que se refresque el maestro entero en CADA request: son 1.340 clientes por página.
   */
  it('🪤 un código inexistente se busca UNA vez, no en cada llamada', async () => {
    const get = mockMaestro(VIEJOS);
    await fetchClientesIMCon([99999]);
    const despuesDelPrimero = get.mock.calls.length;
    await fetchClientesIMCon([99999]);
    await fetchClientesIMCon([99999]);
    expect(get.mock.calls.length).toBe(despuesDelPrimero);
  });

  it('los códigos vacíos o inválidos no disparan nada', async () => {
    const get = mockMaestro(VIEJOS);
    await fetchClientesIMCon([7]);
    const antes = get.mock.calls.length;
    await fetchClientesIMCon([0, NaN, -1]);
    expect(get.mock.calls.length).toBe(antes);
  });
});
