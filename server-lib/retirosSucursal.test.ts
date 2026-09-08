import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Retiro en sucursal: los pedidos que el cliente pasa a buscar y no salen en el camión.
 * Lo que se prueba acá es que no se dupliquen con la hoja de ruta y que el acumulado del mes
 * —que es para lo que se guarda— dé bien.
 */

vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });

const m = vi.hoisted(() => ({ sbMock: vi.fn() }));
vi.mock('./infomanager.js', () => ({ fechaArgentina: () => '2026-09-08' }));
vi.mock('./vistaPresupuestos.js', () => ({ invalidarVista: vi.fn(), vistaDeRango: vi.fn() }));
vi.mock('./supabase.js', () => ({ sb: m.sbMock, TENANT_ID: 'test-tenant', hasSupabase: () => true }));

const { marcarRetiro, quitarRetiro, listarRetiros, resumenRetiros } = await import('./retirosSucursal.js');

let tablas: Record<string, any> = {};
let escrituras: Array<{ tabla: string; op: string; valor: any }> = [];

function fakeSb() {
  m.sbMock.mockImplementation(() => ({
    from: (t: string) => {
      const res = tablas[t] ?? { data: null, error: null };
      const q: any = {
        then: (r: any, j: any) => Promise.resolve(res).then(r, j),
        maybeSingle: () => Promise.resolve(res),
        upsert: (v: any) => { escrituras.push({ tabla: t, op: 'upsert', valor: v }); return q; },
        update: (v: any) => { escrituras.push({ tabla: t, op: 'update', valor: v }); return q; },
        delete: () => { escrituras.push({ tabla: t, op: 'delete', valor: null }); return q; },
      };
      for (const k of ['select', 'eq', 'in', 'gte', 'lte', 'order', 'limit']) q[k] = () => q;
      return q;
    },
  }));
}

function llamar(fn: any, { rol = 'administrativo', params = {}, body = {}, query = {} } = {}) {
  let status = 200; let out: any;
  const req: any = { user: { rol, sub: 'u1' }, params, body, query };
  const res: any = { status: (s: number) => { status = s; return res; }, json: (b: any) => { out = b; } };
  return fn(req, res).then(() => ({ status, body: out }));
}

const PEDIDO = {
  im_comprobante_id: '10', im_numero: 58050, cod_cliente: 1093,
  cliente_nombre: 'ARON, Jorge', fecha: '2026-09-08', total: 29771.58, bultos: 12, kg: 480,
};

beforeEach(() => {
  tablas = {}; escrituras = [];
  vi.clearAllMocks();
  fakeSb();
});

describe('marcar un pedido como retiro', () => {
  it('🔴 uno que YA está en una hoja de ruta se rechaza', async () => {
    // Si estuviera en los dos, se cargaría en el camión mercadería que el cliente vino a buscar.
    tablas['hojas_ruta_pedidos'] = { data: [{ im_comprobante_id: '10', im_numero: 58050 }], error: null };
    const r = await llamar(marcarRetiro, { body: { pedidos: [PEDIDO] } });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('58050');
    expect(escrituras.filter(e => e.tabla === 'retiros_sucursal')).toHaveLength(0);
  });

  it('🔴 se le copian la factura y el remito ya emitidos: es lo que se lleva el cliente', async () => {
    tablas['hojas_ruta_pedidos'] = { data: [], error: null };
    tablas['presupuestos_facturados'] = {
      data: [{ im_comprobante_id: '10', im_factura_id: 'f1', im_factura_numero: 50360, im_remito_id: 'r1', im_remito_numero: 77291 }],
      error: null,
    };
    const r = await llamar(marcarRetiro, { body: { pedidos: [PEDIDO] } });
    expect(r.status).toBe(200);
    const fila = escrituras.find(e => e.tabla === 'retiros_sucursal')!.valor[0];
    expect(fila).toMatchObject({ im_factura_numero: 50360, im_remito_numero: 77291, cod_cliente: 1093 });
    expect(r.body.sin_facturar).toBe(0);
  });

  it('sin facturar todavía, entra igual y se avisa', async () => {
    // El circuito normal factura antes, pero no se bloquea: la marca de retiro es organizativa.
    tablas['hojas_ruta_pedidos'] = { data: [], error: null };
    tablas['presupuestos_facturados'] = { data: [], error: null };
    const r = await llamar(marcarRetiro, { body: { pedidos: [PEDIDO] } });
    expect(r.body.sin_facturar).toBe(1);
  });

  it('sin pedidos contesta 400, no un 500', async () => {
    expect((await llamar(marcarRetiro, { body: {} })).status).toBe(400);
  });

  it('🔴 un vendedor no marca retiros', async () => {
    expect((await llamar(marcarRetiro, { rol: 'vendedor', body: { pedidos: [PEDIDO] } })).status).toBe(403);
  });
});

describe('sacar de retiros', () => {
  it('🔴 lo que el cliente YA retiró no se borra del registro del mes', async () => {
    tablas['retiros_sucursal'] = { data: { retirado_at: '2026-09-08T15:00:00Z', im_numero: 58050 }, error: null };
    const r = await llamar(quitarRetiro, { params: { comprobanteId: '10' } });
    expect(r.status).toBe(409);
    expect(escrituras.some(e => e.op === 'delete')).toBe(false);
  });

  it('lo que todavía no se retiró sí', async () => {
    tablas['retiros_sucursal'] = { data: { retirado_at: null, im_numero: 58050 }, error: null };
    const r = await llamar(quitarRetiro, { params: { comprobanteId: '10' } });
    expect(r.status).toBe(200);
    expect(escrituras.some(e => e.op === 'delete')).toBe(true);
  });
});

describe('el acumulado del mes', () => {
  const RETIROS = [
    { cod_cliente: 1, cliente_nombre: 'UNO', total: 100000, kg: 500, bultos: 10, fecha: '2026-09-02', retirado_at: 'x' },
    { cod_cliente: 1, cliente_nombre: 'UNO', total: 50000, kg: 200, bultos: 4, fecha: '2026-09-05', retirado_at: null },
    { cod_cliente: 2, cliente_nombre: 'DOS', total: 300000, kg: 1200, bultos: 30, fecha: '2026-09-07', retirado_at: 'x' },
  ];

  it('🔴 agrupa por cliente y ordena por importe: se ve quién retira siempre', async () => {
    tablas['retiros_sucursal'] = { data: RETIROS, error: null };
    const r = await llamar(resumenRetiros, { query: { mes: '2026-09' } });
    expect(r.body.clientes[0]).toMatchObject({ cod_cliente: 2, importe: 300000, pedidos: 1 });
    expect(r.body.clientes[1]).toMatchObject({ cod_cliente: 1, importe: 150000, pedidos: 2, kg: 700 });
    expect(r.body.totales).toMatchObject({ pedidos: 3, clientes: 2, importe: 450000, kg: 1900 });
  });

  it('🔴 cuenta los que todavía no pasaron a buscar: es mercadería ocupando lugar', async () => {
    tablas['retiros_sucursal'] = { data: RETIROS, error: null };
    const r = await llamar(resumenRetiros, { query: { mes: '2026-09' } });
    expect(r.body.totales.sin_retirar).toBe(1);
  });

  it('🔴 el rango del mes termina el último día, sin importar cuántos tenga', async () => {
    tablas['retiros_sucursal'] = { data: [], error: null };
    expect((await llamar(resumenRetiros, { query: { mes: '2026-02' } })).body.hasta).toBe('2026-02-28');
    expect((await llamar(resumenRetiros, { query: { mes: '2026-04' } })).body.hasta).toBe('2026-04-30');
    expect((await llamar(resumenRetiros, { query: { mes: '2026-12' } })).body.hasta).toBe('2026-12-31');
  });

  it('sin mes, toma el actual', async () => {
    tablas['retiros_sucursal'] = { data: [], error: null };
    expect((await llamar(resumenRetiros, {})).body.mes).toBe('2026-09');
  });
});

describe('listar los del rango', () => {
  it('suma importes, kilos y bultos, y cuenta los pendientes', async () => {
    tablas['retiros_sucursal'] = {
      data: [
        { cod_cliente: 1, total: 1000, kg: 10, bultos: 1, retirado_at: null },
        { cod_cliente: 2, total: 2000.5, kg: 20.25, bultos: 2, retirado_at: 'x' },
      ],
      error: null,
    };
    const r = await llamar(listarRetiros, { query: { desde: '2026-09-01', hasta: '2026-09-08' } });
    expect(r.body.totales).toMatchObject({ pedidos: 2, pendientes: 1, clientes: 2, importe: 3000.5, kg: 30.25 });
  });
});
