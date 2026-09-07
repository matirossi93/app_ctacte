import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

/**
 * Cómo se le pregunta a IM "¿creaste este presupuesto?" después de un timeout.
 *
 * Va por `GET /ventas/cod_compatibilidad`, el endpoint dedicado. Antes esta búsqueda barría
 * TODAS las ventas del rango de fechas —miles de filas para encontrar una— y además podía
 * errarle si la oficina le movía la fecha al comprobante para reordenar el despacho.
 *
 * Verificado contra IM el 07/09/2026:
 *   lo encuentra           -> 200 {"id": 58698612}
 *   no existe              -> 200 null
 *   empresa equivocada     -> 200 null   ⚠️ igual que "no existe"
 *   sin cod_compatibilidad -> 400
 */

vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });
vi.mock('axios', () => ({ default: { post: vi.fn(), create: vi.fn() } }));

const { buscarPresupuestoPorCompatibilidad } = await import('./infomanager.js');

/** `respuestas` mapea url -> data. Devuelve el mock de get para poder inspeccionar params. */
function mockIM(respuestas: Record<string, any>, fallar?: () => never) {
  const get = vi.fn(async (url: string) => {
    if (fallar && url === '/ventas/cod_compatibilidad') fallar();
    if (url in respuestas) return { data: respuestas[url] };
    throw Object.assign(new Error('404'), { response: { status: 404 } });
  });
  vi.mocked(axios.create).mockReturnValue({
    get, post: vi.fn(), put: vi.fn(), interceptors: { request: { use: vi.fn() } },
  } as any);
  vi.mocked(axios.post).mockResolvedValue({ data: { token: 'tok' } } as any);
  return get;
}

beforeEach(() => { vi.clearAllMocks(); });

describe('buscarPresupuestoPorCompatibilidad', () => {
  it('🔴 lo encuentra: devuelve id, número y fecha', async () => {
    mockIM({
      '/ventas/cod_compatibilidad': { id: 58698612 },
      '/ventas/58698612': { numero: 58042, fecha: '2026-09-04', anulada: 'N' },
    });
    const r = await buscarPresupuestoPorCompatibilidad('f1144c7e', 1);
    expect(r.busquedaOk).toBe(true);
    expect(r.encontrado).toEqual({ id: '58698612', numero: 58042, fecha: '2026-09-04' });
  });

  it('🔴 manda el cod_empresa: con otra, IM contesta igual que si no existiera', async () => {
    // Si esto se pierde, la reconciliación da por no-creado un presupuesto vivo y el pedido
    // se destraba mal. Es el peor error posible de esta función.
    const get = mockIM({
      '/ventas/cod_compatibilidad': { id: 1 },
      '/ventas/1': { numero: 5, fecha: '2026-09-04' },
    });
    await buscarPresupuestoPorCompatibilidad('abc12345', 3);
    const params = (get.mock.calls[0] as any[])[1].params;
    expect(params).toEqual({ cod_compatibilidad: 'abc12345', cod_empresa: 3 });
  });

  it('🔴 NO existe: IM contesta 200 con null y eso es "lo busqué y no está"', async () => {
    mockIM({ '/ventas/cod_compatibilidad': null });
    const r = await buscarPresupuestoPorCompatibilidad('zzzz9999', 1);
    expect(r.busquedaOk).toBe(true);
    expect(r.encontrado).toBeNull();
  });

  it('🔴 si IM falla, busquedaOk:false — "no pude preguntar" NO es "no está"', async () => {
    mockIM({}, () => { throw Object.assign(new Error('boom'), { response: { status: 400, data: {} } }); });
    const r = await buscarPresupuestoPorCompatibilidad('abc12345', 1);
    expect(r.busquedaOk).toBe(false);
    expect(r.encontrado).toBeNull();
  });

  it('sin código no se pregunta nada', async () => {
    const get = mockIM({});
    const r = await buscarPresupuestoPorCompatibilidad('  ', 1);
    expect(r.busquedaOk).toBe(false);
    expect(get).not.toHaveBeenCalled();
  });

  it('si no se puede leer el número, el id alcanza para adoptarlo', async () => {
    mockIM({ '/ventas/cod_compatibilidad': { id: 999 } });   // el GET de la cabecera tira 404
    const r = await buscarPresupuestoPorCompatibilidad('abc12345', 1);
    expect(r.busquedaOk).toBe(true);
    expect(r.encontrado?.id).toBe('999');
    expect(r.encontrado?.numero).toBeNull();
  });
});
