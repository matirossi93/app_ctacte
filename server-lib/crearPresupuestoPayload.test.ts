import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });
vi.mock('axios', () => ({ default: { post: vi.fn(), create: vi.fn() } }));

const { crearPresupuesto, invalidateImToken } = await import('./infomanager.js');

/**
 * Lo que le mandamos a IM al crear un presupuesto. Verificado el 28/08/2026 contra dos
 * presupuestos REALES (nº 57877 y 57878, los dos anulados después):
 *
 * 🔑 Va por `/presupuestos/UnidadDeVenta`, NO por `/presupuestos`. La cabecera de los dos
 *    schemas es idéntica, pero el renglón del endpoint viejo tiene 8 campos y NO incluye
 *    `cod_lista_precios` ⇒ IM le estampaba a todos los renglones la lista de la cabecera.
 *    Mati lo vio del lado de IM: "el precio sí cambia pero la lista sigue figurando 1".
 *
 * 🔑 `precio` va BRUTO. IM le aplica el `descuento_porc` encima y devuelve `precio_orig` (el
 *    de lista) y `precio` (el neto que calculó). Mandar el precio ya rebajado lo descuenta
 *    DOS VECES: probado, 21.141,16 con 25% terminó en 11.891,90 en vez de 15.855,87.
 *    (En el endpoint viejo el `descuento_porc` se guardaba en CERO y se facturaba entero.)
 */

/** Devuelve el body del POST que crearPresupuesto le manda a IM. */
async function postDe(items: any[], codListaCabecera = 12) {
  const post = vi.fn().mockResolvedValue({ data: { isCreated: true, venta: { id: 1, numero: 2 } } });
  vi.mocked(axios.create).mockReturnValue({
    post, get: vi.fn(), put: vi.fn(),
    interceptors: { request: { use: vi.fn() } },
  } as any);
  vi.mocked(axios.post).mockResolvedValue({ data: { token: 'tok' } } as any);

  const r = await crearPresupuesto({
    cod_empresa: 1, cod_cliente: 34, cod_vendedor: 4,
    cod_lista_precios: codListaCabecera, usuario: 'susana', items,
  });
  expect(r.ok).toBe(true);
  return { url: post.mock.calls[0][0] as string, body: post.mock.calls[0][1] as any };
}

beforeEach(() => { vi.clearAllMocks(); invalidateImToken(); });

describe('crearPresupuesto — el payload que ve InfoManager', () => {
  it('🔴 va por /presupuestos/UnidadDeVenta: es el único que acepta la lista por renglón', async () => {
    const { url } = await postDe([{ cod_articulo: 400, cantidad: 5, precio: 1303.16, cod_lista_precios: 14 }]);
    expect(url).toBe('/presupuestos/UnidadDeVenta');
  });

  it('🔴 cada renglón lleva SU lista, aunque la cabecera diga otra', async () => {
    // Es el caso real: cabecera en L1 y un renglón que corresponde a L3. Sin esto el
    // presupuesto sale con todo en lista 1 y el control de listas queda invisible en IM.
    const { body } = await postDe([
      { cod_articulo: 400, cantidad: 5, precio: 1303.16, cod_lista_precios: 14 },
      { cod_articulo: 1, cantidad: 3, precio: 21141.16, cod_lista_precios: 12 },
    ], 12);
    expect(body.cod_lista_precios).toBe(12);              // la cabecera no cambia
    expect(body.items[0].cod_lista_precios).toBe(14);     // y el renglón manda la suya
    expect(body.items[1].cod_lista_precios).toBe(12);
  });

  it('🔴 el precio va BRUTO y numérico, con el descuento aparte: IM lo aplica él', async () => {
    // Si acá saliera el precio ya rebajado, IM le aplicaría el 25% OTRA VEZ.
    const { body } = await postDe([
      { cod_articulo: 1, cantidad: 3, precio: 21141.16, descuento_porc: 25, cod_lista_precios: 12 },
    ]);
    const it = body.items[0];
    expect(it.precio).toBe(21141.16);
    expect(it.precio_orig).toBe(21141.16);
    expect(it.descuento_porc).toBe(25);
    expect(typeof it.precio).toBe('number');   // el schema de este endpoint lo pide número
  });

  it('un renglón sin lista propia no rompe: se omite y queda la de la cabecera', async () => {
    const { body } = await postDe([{ cod_articulo: 400, cantidad: 5, precio: 1303.16 }]);
    expect('cod_lista_precios' in body.items[0]).toBe(false);
  });

  it('la cuenta contable va como número (este endpoint la tipa entera)', async () => {
    const { body } = await postDe([{ cod_articulo: 400, cantidad: 5, precio: 1303.16 }]);
    expect(body.items[0].cod_cuenta).toBe(4100002);
  });
});
