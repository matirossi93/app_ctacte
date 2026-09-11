import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });

const m = vi.hoisted(() => ({ sbMock: vi.fn(), leerComprobante: vi.fn() }));
vi.mock('./supabase.js', () => ({ sb: m.sbMock, TENANT_ID: 'test-tenant', hasSupabase: () => true }));
vi.mock('./infomanager.js', () => ({ leerComprobante: m.leerComprobante }));
const { compararFacturaConRemito } = await import('./compararComprobantes.js');

const PAR = {
  im_comprobante_id: '10', im_factura_id: '20', im_factura_numero: 50420, im_factura_tipo: 'FA B',
  im_remito_id: '30', im_remito_numero: 77397, cod_cliente: 1054, cod_empresa: 1,
};
const comprobante = (extra: any, crudos: any[]) => ({
  cabecera: { tipo_comprobante: 'FA', tipo_factura: 'B', numero: 50420, cod_cliente: 1054, cod_empresa: 1, anulada: false, ...extra },
  items: [], crudos,
});

let filaPar: any, filaRelectura: any, errorRelectura: any, escrituras: string[];
function fakeSb() {
  let vuelta = 0;
  m.sbMock.mockImplementation(() => ({
    from: (t: string) => {
      const q: any = {
        maybeSingle: () => Promise.resolve(vuelta++ === 0
          ? { data: filaPar, error: null }
          : { data: filaRelectura, error: errorRelectura }),
        then: (r: any) => Promise.resolve({ data: filaPar, error: null }).then(r),
      };
      for (const k of ['select', 'eq', 'in', 'is', 'not', 'order', 'limit']) q[k] = () => q;
      for (const k of ['insert', 'update', 'upsert', 'delete']) q[k] = () => { escrituras.push(`${t}.${k}`); return q; };
      return q;
    },
  }));
}
const llamar = (params: any, user: any = { rol: 'administrativo', sub: 'u1' }) => {
  let status = 200, body: any;
  const res: any = { status: (s: number) => { status = s; return res; }, json: (b: any) => { body = b; } };
  return compararFacturaConRemito({ user, params, query: {}, body: {} } as any, res).then(() => ({ status, body }));
};

beforeEach(() => {
  vi.clearAllMocks(); escrituras = []; errorRelectura = null;
  filaPar = { ...PAR }; filaRelectura = { ...PAR };
  fakeSb();
  m.leerComprobante.mockImplementation(async (id: string) => id === '20'
    ? comprobante({}, [{ cod_articulo: 509, cantidad: 1 }])
    : comprobante({ tipo_comprobante: 'RE', tipo_factura: null, numero: 77397 }, [{ cod_articulo: 509, cantidad: 1 }, { cod_articulo: 378, cantidad: 1 }]));
});

describe('comparar a pedido', () => {
  it('🔑 dos lecturas, cero escrituras, y el caso Fernández', async () => {
    const r = await llamar({ imComprobanteId: '10' });
    expect(r.status).toBe(200);
    expect(r.body.control.estado).toBe('diferencias');
    expect(r.body.control.diferencias).toEqual([{ cod_articulo: 378, factura: 0, remito: 1 }]);
    expect(m.leerComprobante).toHaveBeenCalledTimes(2);
    expect(escrituras).toEqual([]);
    expect(r.body.checked_at).toMatch(/^\d{4}-/);
  });

  it('🔑 si el vínculo cambió mientras se consultaba, 409 y sin resultado', async () => {
    filaRelectura = { ...PAR, im_remito_id: '99' };
    const r = await llamar({ imComprobanteId: '10' });
    expect(r.status).toBe(409);
    expect(r.body.control).toBeUndefined();
  });

  it('🔑 y también si cambió la identidad, no sólo los ids', async () => {
    for (const cambio of [{ im_factura_numero: 99 }, { im_factura_tipo: 'FA A' }, { cod_cliente: 7 }, { cod_empresa: 2 }]) {
      fakeSb();   // el contador de lecturas arranca de cero en cada caso
      filaRelectura = { ...PAR, ...cambio };
      expect((await llamar({ imComprobanteId: '10' })).status, JSON.stringify(cambio)).toBe(409);
    }
  });

  it('🔑 no poder releer es 502, no 409: son cosas distintas', async () => {
    errorRelectura = { message: 'sin conexión' };
    const r = await llamar({ imComprobanteId: '10' });
    expect(r.status).toBe(502);
    expect(r.body.control).toBeUndefined();
  });

  it('🪤 ids ilegibles no gastan los dos GET', async () => {
    filaPar = { ...PAR, im_remito_id: 'abc' };
    const r = await llamar({ imComprobanteId: '10' });
    expect(r.status).toBe(409);
    expect(m.leerComprobante).not.toHaveBeenCalled();
  });

  it('sin los dos comprobantes, 409', async () => {
    filaPar = { ...PAR, im_remito_id: null };
    expect((await llamar({ imComprobanteId: '10' })).status).toBe(409);
    expect(m.leerComprobante).not.toHaveBeenCalled();
  });

  it('un id que no es un número se rechaza antes de tocar la base', async () => {
    expect((await llamar({ imComprobanteId: '../../etc' })).status).toBe(400);
    expect(m.sbMock).not.toHaveBeenCalled();
  });

  it('🔑 un rol que no puede facturar no puede comparar', async () => {
    const r = await llamar({ imComprobanteId: '10' }, { rol: 'repartidor', sub: 'u9' });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(m.leerComprobante).not.toHaveBeenCalled();
  });

  it('si IM no contesta, 502 y ninguna afirmación', async () => {
    m.leerComprobante.mockRejectedValue(new Error('sin respuesta'));
    const r = await llamar({ imComprobanteId: '10' });
    expect(r.status).toBe(502);
    expect(r.body.control).toBeUndefined();
  });

  it('🪤 la anulación desconocida de un comprobante no se convierte en vigente', async () => {
    m.leerComprobante.mockImplementation(async (id: string) => id === '20'
      ? comprobante({ anulada: null }, [{ cod_articulo: 509, cantidad: 1 }])
      : comprobante({ tipo_comprobante: 'RE', numero: 77397 }, [{ cod_articulo: 509, cantidad: 1 }]));
    const r = await llamar({ imComprobanteId: '10' });
    expect(r.body.control.estado).toBe('no_verificado');
  });
});

/**
 * 🔴 `parsearCabeceraComprobante` no conserva el id, así que el endpoint le inyecta el que pidió.
 * Si IM contestara el cuerpo de otro comprobante, se compararía ése dándolo por bueno.
 */
it('🔑 si IM devuelve un comprobante distinto del pedido, no se compara', async () => {
  m.leerComprobante.mockImplementation(async (id: string) => ({
    ...(id === '20'
      ? comprobante({}, [{ cod_articulo: 509, cantidad: 1 }])
      : comprobante({ tipo_comprobante: 'RE', numero: 77397 }, [{ cod_articulo: 509, cantidad: 1 }])),
    idDevuelto: id === '20' ? '999' : id,
  }));
  const r = await llamar({ imComprobanteId: '10' });
  expect(r.status).toBe(502);
  expect(r.body.control).toBeUndefined();
});

it('🪤 una respuesta sin id no contradice nada: alcanza la identidad', async () => {
  m.leerComprobante.mockImplementation(async (id: string) => ({
    ...(id === '20'
      ? comprobante({}, [{ cod_articulo: 509, cantidad: 1 }])
      : comprobante({ tipo_comprobante: 'RE', numero: 77397 }, [{ cod_articulo: 509, cantidad: 1 }])),
    idDevuelto: null,
  }));
  expect((await llamar({ imComprobanteId: '10' })).body.control.estado).toBe('coinciden');
});
