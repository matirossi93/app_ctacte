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
/** Lo que la base sabe de la factura que se está acreditando. `null` = no salió de la app. */
let filaFacturada: any = { im_remito_id: 're-1' };
let errorAlLeer: any = null;
vi.mock('./emitirNotaV2.js', () => ({ emitirNotaV2: m.v2 }));
vi.mock('./facturarIM.js', () => ({ emitirNotaCredito: m.nc, emitirNotaDebito: m.nd, letraDeFactura: (c: string) => (c === 'RI' ? 'A' : 'B') }));
// `claveIdempotente` va de VERDAD: es la regla de formato que InfoManager impone, y lo que
// se quiere probar acá es que la clave que manda el emisor la cumpla.
vi.mock('./imApiV2.js', async original => ({ ...(await original<any>()), imV2Configurada: m.configurada }));
vi.mock('./supabase.js', () => ({
  TENANT_ID: 't',
  sb: () => ({ from: () => { const q: any = {}; for (const k of ['select','eq']) q[k] = () => q;
    q.maybeSingle = async () => ({ data: errorAlLeer ? null : filaFacturada, error: errorAlLeer }); return q; } }),
}));

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
  filaFacturada = { im_remito_id: 're-1' }; errorAlLeer = null;
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
    expect(claves[0]).toBe('op-77-0-');   // el guión final es el relleno hasta los 8 que pide IM
    expect(claves[1]).toBe(claves[0]);
  });

  /**
   * 🔴 22/09/2026, la primera NC real desde la pantalla de corrección (ARRIETA, factura B 50844).
   * Esta prueba decía `'op-77:1'` — o sea afirmaba el formato ROTO— y por eso el bug llegó a
   * producción: InfoManager acepta 8 a 128 caracteres `[A-Za-z0-9_-]` y los dos puntos no entran.
   * El rechazo volvía como `IDEMPOTENCY_KEY_INVALID`, que no dice nada de la corrección.
   */
  it('🔴 y cambia con el paso: dos notas de la misma operación no comparten clave', async () => {
    await emitirComponente(OP as any, comp({ subtipo: 'FI' }) as any);
    await emitirComponente({ ...OP, indice: 1 } as any, { tipo: 'ND', datos: DATOS } as any);
    expect(m.v2.mock.calls[1][0].idempotencyKey).toBe('op-77-1-');
  });

  it('🔴 y sale SIEMPRE con el formato que acepta InfoManager, venga como venga el id', async () => {
    for (const id of ['op:77', 'a', 'operación con acentos y espacios']) {
      await emitirComponente({ ...OP, id } as any, comp({ subtipo: 'FI' }) as any);
    }
    for (const c of m.v2.mock.calls) {
      expect(c[0].idempotencyKey).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    }
  });

  /**
   * 🔴 22/09/2026, la segunda cosa que rechazó InfoManager en la primera NC real por v2:
   * *"Elegí los ítems de la factura con «Ítems remitidos» o «Ítems sin remitir» antes de grabar"*.
   * Es `cod_control`, y el spec avisa que no tiene default: *"Decide contra qué disponible se
   * controla cada cantidad, así que no se asume"*.
   */
  it('🔴 la NC de devolución dice de qué cubeta salen los ítems', async () => {
    filaFacturada = { im_remito_id: 're-1' };          // la factura tiene su remito
    await emitirComponente(OP as any, comp({ subtipo: 'DE' }) as any);
    expect(m.v2.mock.calls[0][0]).toMatchObject({ tipo_nc: 'DE', cod_control: 'C_RE' });
  });

  it('🔴 sin remito la cubeta es "sin remitir", no la otra', async () => {
    filaFacturada = { im_remito_id: null };            // factura emitida sin remito
    await emitirComponente(OP as any, comp({ subtipo: 'DE' }) as any);
    expect(m.v2.mock.calls[0][0]).toMatchObject({ cod_control: 'S_RE' });
  });

  /**
   * 🪤 Sin registro nuestro de esa factura no hay con qué decidir la cubeta, y mandar la
   * equivocada hace que IM controle las cantidades contra un disponible que no es el de esta
   * mercadería. Se va por v1, que no la pide.
   */
  it('🪤 si la factura no salió de la app, la NC se va por la API vieja', async () => {
    filaFacturada = null;
    const r = await emitirComponente(OP as any, comp({ subtipo: 'DE' }) as any);
    expect(m.v2).not.toHaveBeenCalled();
    expect(m.nc).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: true, tipo: 'NC B' });
  });

  it('🪤 y tampoco adivina si la base no contestó', async () => {
    errorAlLeer = { message: 'timeout' };
    await emitirComponente(OP as any, comp({ subtipo: 'DE' }) as any);
    expect(m.v2).not.toHaveBeenCalled();
    expect(m.nc).toHaveBeenCalledTimes(1);
  });

  /**
   * 🔑 Mati (22/09/2026): *"lo ideal es que esa nc sí reingrese stock, sería lo correcto"*. El
   * remito ya lo descontó; la devolución dice que esa mercadería no salió.
   */
  it('🔑 la devolución de mercadería remitida REINGRESA el stock', async () => {
    filaFacturada = { im_remito_id: 're-1' };
    await emitirComponente(OP as any, comp({ subtipo: 'DE' }) as any);
    expect(m.v2.mock.calls[0][0]).toMatchObject({ cod_control: 'C_RE', genero_re_auto: true });
  });

  it('🪤 pero sin remito no reingresa nada: nunca se descontó', async () => {
    filaFacturada = { im_remito_id: null };
    await emitirComponente(OP as any, comp({ subtipo: 'DE' }) as any);
    expect(m.v2.mock.calls[0][0].genero_re_auto).toBeUndefined();
  });

  it('🪤 la financiera no lleva cubeta ni toca stock: no mueve mercadería', async () => {
    await emitirComponente(OP as any, comp({ subtipo: 'FI' }) as any);
    const payload = m.v2.mock.calls[0][0];
    expect(payload.cod_control).toBeUndefined();
    expect(payload.genero_re_auto).toBeUndefined();
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
