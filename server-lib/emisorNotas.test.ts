import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * POR DÓNDE SALE CADA NOTA: la API nueva o la de siempre.
 *
 * Mati (21/09/2026), sobre conectar la v2: *"me parece bien, hagamos así. Cualquier cosa lo
 * cambiamos, pero una vez que esté funcionando bien, ya lo sacamos el botón y listo"*.
 *
 * 🔑 El interruptor existe para poder VOLVER ATRÁS en un minuto sin esperar un despliegue, no
 * para tener dos caminos para siempre. Cuando lleve un par de semanas sin sobresaltos se saca.
 */
const m = vi.hoisted(() => ({ v2: vi.fn(), nc: vi.fn(), nd: vi.fn(), configurada: vi.fn(() => true) }));
vi.mock('./emitirNotaV2.js', () => ({ emitirNotaV2: m.v2 }));
vi.mock('./facturarIM.js', () => ({ emitirNotaCredito: m.nc, emitirNotaDebito: m.nd, letraDeFactura: (c: string) => (c === 'RI' ? 'A' : 'B') }));
vi.mock('./imApiV2.js', () => ({ imV2Configurada: m.configurada }));

const { emitirComponente } = await import('./emisorNotas.js');

const DATOS = {
  cod_empresa: 1, cod_cliente: 763, cod_vendedor: 6, categoria_iva: 'CF',
  cod_lista_precios: 12, usuario: 'jorgelina', observaciones: 'SEGUN FACTURA 50497',
  total: 1210, cod_deposito: 1,
  items: [{ cod_articulo: 13818, cantidad: 1, precio: 1000, iva_por: 21 }],
};
const OP = { id: 'op-77', indice: 0, im_factura_id: '58802657' };
const comp = (extra: any = {}) => ({ tipo: 'NC' as const, datos: DATOS as any, ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.IM_NOTAS_V2 = '1';
  m.configurada.mockReturnValue(true);
  m.v2.mockResolvedValue({ ok: true, im_id: '58924169', numero: 30117 });
  m.nc.mockResolvedValue({ ok: true, id: '999', numero: 5, tipo: 'NC B' });
  m.nd.mockResolvedValue({ ok: true, id: '888', numero: 6, tipo: 'ND B' });
});

describe('cuándo sale por la API nueva', () => {
  it('🔑 con el interruptor puesto y el subtipo calculado, va por v2', async () => {
    const r = await emitirComponente(OP as any, comp({ subtipo: 'FI' }) as any);
    expect(m.v2).toHaveBeenCalledTimes(1);
    expect(m.nc).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, id: '58924169', numero: 30117, tipo: 'NC B' });
  });

  it('🔑 le pasa la factura que acredita y el subtipo', async () => {
    await emitirComponente(OP as any, comp({ subtipo: 'DE' }) as any);
    expect(m.v2.mock.calls[0][0]).toMatchObject({
      tipo: 'NC', tipo_nc: 'DE', letra: 'B', cod_cliente: 763, cod_empresa: 1,
      factura: { im_id: '58802657' },
    });
  });

  it('🔴 la clave de idempotencia es la operación y el paso: un reintento no duplica la nota', async () => {
    await emitirComponente(OP as any, comp({ subtipo: 'FI' }) as any);
    await emitirComponente(OP as any, comp({ subtipo: 'FI' }) as any);
    const claves = m.v2.mock.calls.map(c => c[0].idempotencyKey);
    expect(claves[0]).toBe('op-77:0');
    expect(claves[1]).toBe(claves[0]);
  });

  it('🔴 y cambia con el paso: dos notas de la misma operación no comparten clave', async () => {
    await emitirComponente(OP as any, comp({ subtipo: 'FI' }) as any);
    await emitirComponente({ ...OP, indice: 1 } as any, { tipo: 'ND', datos: DATOS } as any);
    expect(m.v2.mock.calls[1][0].idempotencyKey).toBe('op-77:1');
  });

  it('una nota de débito no lleva subtipo: es sólo de la NC', async () => {
    await emitirComponente({ ...OP, indice: 1 } as any, { tipo: 'ND', datos: DATOS } as any);
    expect(m.v2.mock.calls[0][0].tipo_nc).toBeUndefined();
    expect(m.v2.mock.calls[0][0].tipo).toBe('ND');
  });
});

describe('cuándo sale por la de siempre', () => {
  it('🔑 con el interruptor apagado', async () => {
    process.env.IM_NOTAS_V2 = '0';
    await emitirComponente(OP as any, comp({ subtipo: 'FI' }) as any);
    expect(m.nc).toHaveBeenCalledTimes(1);
    expect(m.v2).not.toHaveBeenCalled();
  });

  it('🔴 sin credenciales de la API nueva: no se cae, sale por donde salía', async () => {
    m.configurada.mockReturnValue(false);
    await emitirComponente(OP as any, comp({ subtipo: 'FI' }) as any);
    expect(m.nc).toHaveBeenCalledTimes(1);
  });

  it('🔴 una NC sin subtipo calculado —de una operación anterior al cambio— sigue por v1', async () => {
    // Adivinarle el subtipo a una corrección que ya estaba en curso sería inventar qué pasó.
    await emitirComponente(OP as any, comp() as any);
    expect(m.nc).toHaveBeenCalledTimes(1);
    expect(m.v2).not.toHaveBeenCalled();
  });

  it('🔴 sin id de factura tampoco se puede atar nada: va por v1', async () => {
    await emitirComponente({ ...OP, im_factura_id: '' } as any, comp({ subtipo: 'FI' }) as any);
    expect(m.nc).toHaveBeenCalledTimes(1);
  });
});

describe('el resultado', () => {
  it('🔑 un rechazo de v2 vuelve con el shape que espera el journal', async () => {
    m.v2.mockResolvedValue({ ok: false, error: 'InfoManager v2 400: el cliente no existe' });
    const r: any = await emitirComponente(OP as any, comp({ subtipo: 'FI' }) as any);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/el cliente no existe/);
  });

  it('🔴 si se pierde la respuesta queda marcado sinRespuesta, igual que en v1', async () => {
    m.v2.mockRejectedValue(new Error('socket hang up'));
    const r: any = await emitirComponente(OP as any, comp({ subtipo: 'FI' }) as any);
    expect(r.ok).toBe(false);
    expect(r.sinRespuesta).toBe(true);
  });
});
