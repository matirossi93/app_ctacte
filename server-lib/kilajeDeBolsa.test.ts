import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Guardar cuántos kilos trae la bolsa de un producto, desde la pantalla de fraccionado.
 *
 * Mati (17/09/2026): *"van cambiando los kilajes de las bolsas, no son siempre iguales...
 * instantánea ahora tiene 20, arrollada por 30 y el sorgo por 40"*. Hasta hoy cada cambio de
 * proveedor pedía un deploy.
 */
vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });
const m = vi.hoisted(() => ({ upsert: vi.fn(), borrar: vi.fn(), invalidar: vi.fn() }));

vi.mock('./supabase.js', () => ({
  TENANT_ID: 't', hasSupabase: () => true,
  sb: () => ({ from: () => ({
    upsert: (fila: any) => { m.upsert(fila); return Promise.resolve({ error: null }); },
    delete: () => { const q: any = { then: (fn: any) => { m.borrar(); return Promise.resolve({ error: null }).then(fn); } }; q.eq = () => q; return q; },
  }) }),
}));
vi.mock('./formatosBolsa.js', () => ({ invalidarFormatosManuales: m.invalidar, formatosDeBolsa: async () => new Map() }));

const { guardarKilajeDeBolsa } = await import('./kilajeDeBolsa.js');

function correr(cod: any, body: any) {
  const res: any = { code: 200, body: null };
  res.status = (c: number) => { res.code = c; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  return guardarKilajeDeBolsa(
    { params: { cod }, body, user: { sub: '10000000-0000-0000-0000-000000000099' } } as any, res,
  ).then(() => res);
}

beforeEach(() => { vi.clearAllMocks(); });

describe('cargar el kilaje de una bolsa', () => {
  it('🔑 guarda el número y hace que el listado lo use enseguida', async () => {
    const res = await correr('403', { kg: 40 });
    expect(res.code).toBe(200);
    expect(res.body).toMatchObject({ ok: true, cod_articulo: 403, kg: 40 });
    expect(m.upsert).toHaveBeenCalledWith(expect.objectContaining({ cod_articulo: 403, kg: 40, tenant_id: 't' }));
    // Sin esto, el que acaba de cargar 40 sigue viendo el listado partido en paquetes de 10.
    expect(m.invalidar).toHaveBeenCalled();
  });

  it('acepta una bolsa con decimales: 22,5 kg es un formato posible', async () => {
    await correr('500', { kg: 22.5 });
    expect(m.upsert).toHaveBeenCalledWith(expect.objectContaining({ kg: 22.5 }));
  });

  it('🔑 borrar el kilaje vuelve a dejar el producto sin formato', async () => {
    const res = await correr('403', { kg: null });
    expect(res.code).toBe(200);
    expect(res.body).toMatchObject({ ok: true, cod_articulo: 403, kg: null });
    expect(m.borrar).toHaveBeenCalled();
    expect(m.upsert).not.toHaveBeenCalled();
  });

  it('🔴 un kilaje imposible no se guarda', async () => {
    for (const kg of [0, -5, 5000, 'treinta', NaN]) {
      const res = await correr('403', { kg });
      expect(res.code, `kg=${kg}`).toBe(400);
    }
    expect(m.upsert).not.toHaveBeenCalled();
  });

  it('🔴 un código de artículo inválido tampoco', async () => {
    for (const cod of ['0', '-3', 'abc']) {
      const res = await correr(cod, { kg: 30 });
      expect(res.code, `cod=${cod}`).toBe(400);
    }
    expect(m.upsert).not.toHaveBeenCalled();
  });
});
