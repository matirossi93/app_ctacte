import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * De este reporte sale un PAGO: a los choferes se les paga por lo que entregan (Mati,
 * 08/09/2026). Lo que se prueba acá es que no se le acredite a nadie lo que no entregó y que no
 * se liquide una hoja que todavía puede cambiar.
 */

vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });

const m = vi.hoisted(() => ({ sbMock: vi.fn() }));
vi.mock('./infomanager.js', () => ({
  // El cache de /ventas se limpia junto con las vistas (10/09/2026).
  invalidarCacheVentas: vi.fn(),
  invalidarCacheItems: vi.fn(), fechaArgentina: () => '2026-09-08' }));
vi.mock('./supabase.js', () => ({ sb: m.sbMock, TENANT_ID: 'test-tenant', hasSupabase: () => true }));

const { liquidacionMensual, listarChoferes, limitesDelMes } = await import('./liquidacionChoferes.js');

let tablas: Record<string, any> = {};

function fakeSb() {
  m.sbMock.mockImplementation(() => ({
    from: (t: string) => {
      const res = tablas[t] ?? { data: null, error: null };
      const q: any = { then: (r: any, j: any) => Promise.resolve(res).then(r, j), maybeSingle: () => Promise.resolve(res) };
      for (const k of ['select', 'eq', 'in', 'gte', 'lte', 'order', 'limit']) q[k] = () => q;
      return q;
    },
  }));
}

function llamar(fn: any, { rol = 'administrativo', query = {} } = {}) {
  let status = 200; let out: any;
  const req: any = { user: { rol, sub: 'u1' }, params: {}, body: {}, query };
  const res: any = { status: (s: number) => { status = s; return res; }, json: (b: any) => { out = b; } };
  return fn(req, res).then(() => ({ status, body: out }));
}

function hoja(over: Record<string, any> = {}) {
  return {
    id: 'h1', numero: 3395, fecha: '2026-09-08', estado: 'cerrada',
    chofer_id: 'c-nino', choferes: { nombre: 'NIÑO' },
    hojas_ruta_pedidos: [
      { cod_cliente: 1, total: 100000, bultos: 10, kg: 400 },
      { cod_cliente: 2, total: 50000, bultos: 5, kg: 200 },
    ],
    ...over,
  };
}

beforeEach(() => { tablas = {}; vi.clearAllMocks(); fakeSb(); });

describe('liquidación mensual', () => {
  it('🔴 suma por chofer lo que entregó: hojas, pedidos, clientes, kilos e importe', async () => {
    tablas['hojas_ruta'] = {
      data: [
        hoja(),
        hoja({ id: 'h2', numero: 3396, hojas_ruta_pedidos: [{ cod_cliente: 1, total: 20000, bultos: 2, kg: 80 }] }),
        hoja({ id: 'h3', numero: 3397, chofer_id: 'c-victor', choferes: { nombre: 'VICTOR' }, hojas_ruta_pedidos: [{ cod_cliente: 9, total: 500000, bultos: 50, kg: 2000 }] }),
      ],
      error: null,
    };
    const r = await llamar(liquidacionMensual, { query: { mes: '2026-09' } });

    // VICTOR primero: se ordena por importe, que es de lo que depende el pago.
    expect(r.body.choferes[0]).toMatchObject({ chofer: 'VICTOR', hojas: 1, importe: 500000 });
    expect(r.body.choferes[1]).toMatchObject({ chofer: 'NIÑO', hojas: 2, pedidos: 3, clientes: 2, kg: 680, importe: 170000 });
    expect(r.body.totales).toMatchObject({ hojas: 3, pedidos: 4, importe: 670000 });
  });

  it('🔴 una hoja ABIERTA no se liquida: todavía puede cambiar', async () => {
    tablas['hojas_ruta'] = { data: [hoja({ estado: 'abierta' })], error: null };
    const r = await llamar(liquidacionMensual, { query: { mes: '2026-09' } });
    expect(r.body.choferes).toHaveLength(0);
    expect(r.body.sin_cerrar).toMatchObject({ hojas: 1, importe: 150000 });
  });

  it('🔴 una hoja VACÍA no se cuenta como "falta cerrar": hay que borrarla, no cerrarla', async () => {
    tablas['hojas_ruta'] = { data: [hoja({ estado: 'abierta', hojas_ruta_pedidos: [] })], error: null };
    const r = await llamar(liquidacionMensual, { query: { mes: '2026-09' } });
    expect(r.body.sin_cerrar).toMatchObject({ hojas: 0, importe: 0 });
  });

  it('🔴 una hoja ANULADA no se liquida ni se cuenta como pendiente', async () => {
    tablas['hojas_ruta'] = { data: [hoja({ estado: 'anulada' })], error: null };
    const r = await llamar(liquidacionMensual, { query: { mes: '2026-09' } });
    expect(r.body.choferes).toHaveLength(0);
    expect(r.body.sin_cerrar.hojas).toBe(0);
  });

  it('🔴 una hoja SIN chofer no se reparte entre los demás: va en su propio grupo', async () => {
    // Si se repartiera, alguien cobraría de más y otro de menos.
    tablas['hojas_ruta'] = { data: [hoja(), hoja({ id: 'h9', chofer_id: null, choferes: null })], error: null };
    const r = await llamar(liquidacionMensual, { query: { mes: '2026-09' } });
    const sinChofer = r.body.choferes.find((c: any) => c.chofer_id === null);
    expect(sinChofer).toMatchObject({ chofer: 'Sin chofer asignado', importe: 150000 });
    expect(r.body.choferes.find((c: any) => c.chofer === 'NIÑO').importe).toBe(150000);
  });

  it('🔴 el importe DESCUENTA las notas de crédito emitidas', async () => {
    // Es lo que se le paga: lo que entregó, no lo que se llevó.
    tablas['hojas_ruta'] = {
      data: [hoja({ hojas_ruta_ajustes: [{ tipo: 'nc', importe: 30000, emitido_at: 'x' }] })],
      error: null,
    };
    const r = await llamar(liquidacionMensual, { query: { mes: '2026-09' } });
    expect(r.body.choferes[0]).toMatchObject({ despachado: 150000, notas_credito: 30000, importe: 120000 });
    expect(r.body.incluye_ajustes).toBe(true);
  });

  it('🔴 una NC cargada pero NO emitida no descuenta: no bajó ninguna cuenta corriente', async () => {
    tablas['hojas_ruta'] = {
      data: [hoja({ hojas_ruta_ajustes: [{ tipo: 'nc', importe: 30000, emitido_at: null }] })],
      error: null,
    };
    const r = await llamar(liquidacionMensual, { query: { mes: '2026-09' } });
    expect(r.body.choferes[0].importe).toBe(150000);
  });

  it('🔴 un vendedor no ve la liquidación', async () => {
    expect((await llamar(liquidacionMensual, { rol: 'vendedor' })).status).toBe(403);
  });

  it('sin mes toma el actual', async () => {
    tablas['hojas_ruta'] = { data: [], error: null };
    const r = await llamar(liquidacionMensual, {});
    expect(r.body.mes).toBe('2026-09');
  });
});

describe('limitesDelMes', () => {
  it('🔴 cierra el mes en su último día, febrero incluido', async () => {
    expect(limitesDelMes('2026-02')).toEqual({ desde: '2026-02-01', hasta: '2026-02-28' });
    expect(limitesDelMes('2028-02')).toEqual({ desde: '2028-02-01', hasta: '2028-02-29' });   // bisiesto
    expect(limitesDelMes('2026-04')).toEqual({ desde: '2026-04-01', hasta: '2026-04-30' });
    expect(limitesDelMes('2026-12')).toEqual({ desde: '2026-12-01', hasta: '2026-12-31' });
  });
});

describe('lista de choferes', () => {
  it('devuelve los activos para el selector de la hoja', async () => {
    tablas['choferes'] = { data: [{ id: '1', nombre: 'NIÑO', activo: true }], error: null };
    const r = await llamar(listarChoferes, {});
    expect(r.body.choferes).toHaveLength(1);
  });
});
