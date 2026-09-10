import { describe, it, expect, vi } from 'vitest';

/**
 * El rango de la pantalla de hojas de ruta.
 *
 * Mati (09/09/2026): *"en la parte de hoja de ruta también el selector de fecha tiene que ser por
 * rango"*. Hasta ese día esta pantalla iba por DÍA (`?fecha=`) con un `?dias=N` para estirar
 * hacia atrás, mientras las otras tres etapas ya trabajaban por rango.
 */
vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });
vi.mock('./supabase.js', () => ({ sb: vi.fn(), TENANT_ID: 't', hasSupabase: () => true }));
vi.mock('./vistaRemitos.js', () => ({ vistaRemitos: vi.fn(), invalidarRemitos: vi.fn() }));
vi.mock('./infomanager.js', async (orig) => ({
  ...(await orig<any>()),
  fetchVentas: vi.fn(), fetchVentasItems: vi.fn(), fetchArticulosCatalogo: vi.fn(),
  fetchClientesIMCached: vi.fn(),
}));

const { rangoPedido } = await import('./hojasRuta.js');
const req = (query: any) => ({ query } as any);

describe('rangoPedido', () => {
  it('🔴 toma el rango que mandó la pantalla', () => {
    expect(rangoPedido(req({ desde: '2026-09-01', hasta: '2026-09-09' })))
      .toEqual({ desde: '2026-09-01', hasta: '2026-09-09' });
  });

  it('sin desde, es un solo día', () => {
    expect(rangoPedido(req({ hasta: '2026-09-09' })))
      .toEqual({ desde: '2026-09-09', hasta: '2026-09-09' });
  });

  it('🪤 sigue entendiendo el ?fecha=&dias= de antes: una pantalla vieja no se rompe', () => {
    expect(rangoPedido(req({ fecha: '2026-09-09', dias: 3 })))
      .toEqual({ desde: '2026-09-06', hasta: '2026-09-09' });
  });

  it('un rango dado vuelta no invierte la consulta', () => {
    const r = rangoPedido(req({ desde: '2026-09-20', hasta: '2026-09-09' }));
    expect(r.desde <= r.hasta).toBe(true);
  });

  it('🔴 un rango enorme se recorta: cada día es una consulta más contra IM', () => {
    const r = rangoPedido(req({ desde: '2020-01-01', hasta: '2026-09-09' }));
    const dias = (Date.parse(r.hasta) - Date.parse(r.desde)) / 864e5;
    expect(dias).toBeLessThanOrEqual(31);
    expect(r.hasta).toBe('2026-09-09');   // se recorta por atrás, no por adelante
  });

  it('fechas basura no llegan a InfoManager', () => {
    const r = rangoPedido(req({ desde: 'ayer', hasta: '9/9/26' }));
    expect(r.desde).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.hasta).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

/**
 * 🔑 LA FECHA DE LA HOJA. Mati (10/09/2026): *"las hojas de ruta tienen que poder relacionarse a
 * una fecha, porque muchas veces armamos hojas de ruta para días siguientes"*.
 *
 * Se elige al crearla y se puede mover después: la hoja de mañana se arma hoy, y a veces hay que
 * correrla un día.
 */
describe('editarHoja — la fecha de reparto', () => {
  const llamar = async (body: any) => {
    const { editarHoja } = await import('./hojasRuta.js');
    let status = 200, json: any = null;
    const res: any = { status(c: number) { status = c; return res; }, json(j: any) { json = j; return res; } };
    await editarHoja({ body, params: { id: 'h1' }, query: {}, user: { rol: 'administrativo' } } as any, res);
    return { status, json };
  };

  it('🔴 una fecha inventada no llega a la base', async () => {
    for (const f of ['mañana', '10/09/2026', '2026-13-45x', '']) {
      const r = await llamar({ fecha: f });
      expect(r.status).toBe(400);
      expect(String(r.json?.error)).toMatch(/fecha/i);
    }
  });

  it('sin nada para cambiar, avisa en vez de escribir', async () => {
    const r = await llamar({});
    expect(r.status).toBe(400);
  });
});
