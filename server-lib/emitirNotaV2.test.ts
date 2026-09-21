import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * EMITIR UNA NOTA DE CRÉDITO O DÉBITO POR LA API NUEVA.
 *
 * 🔴 ES LO ÚNICO IRREVERSIBLE DEL CIRCUITO: consume numeración fiscal y toca la cuenta corriente
 * del cliente. Lo que se prueba acá es que **falle del lado seguro** — que no emita cuando falta
 * algo, no que emita bien cuando está todo.
 *
 * Lo que la v2 agrega y la v1 no tiene (verificado contra el spec y en vivo el 21/09/2026):
 *   · `id_comp_asoc` — la factura que la nota acredita, atada en InfoManager y no en un texto.
 *   · `id_item_origen` — qué renglón de la factura corrige cada línea. Con él, un `precio` en 0
 *     hace que IM tome el precio del renglón original, en vez de recalcularlo nosotros.
 *   · `numero: 0` — lo numera el sistema. Era el choque de serie de la NC B 30079 (11/09/2026).
 */
const m = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('./imApiV2.js', () => ({
  postV2: m.post,
  imV2Configurada: () => true,
  ErrorV2: class ErrorV2 extends Error {},
}));

const { emitirNotaV2 } = await import('./emitirNotaV2.js');

const BASE = {
  tipo: 'NC' as const,
  letra: 'B',
  cod_cliente: 763,
  cod_empresa: 1,
  observaciones: 'Corrección de precio',
  tipo_nc: 'FI' as const,
  factura: { im_id: '58893294' },
  items: [{ cod_articulo: 320, cantidad: 2, precio: 1000 }],
  idempotencyKey: 'corr-1-v1',
};
const okIM = { isCreated: true, venta: { id: 58999001, numero: 30120 } };

beforeEach(() => { vi.clearAllMocks(); m.post.mockResolvedValue(okIM); });
const cuerpo = () => m.post.mock.calls[0][1] as any;

describe('lo que se le manda a InfoManager', () => {
  it('🔑 el número va en 0: lo asigna el sistema, que era el choque de serie que nos frenó', async () => {
    await emitirNotaV2(BASE);
    expect(cuerpo().numero).toBe(0);
  });

  it('🔑 la factura asociada viaja por id, que es el vínculo nativo', async () => {
    await emitirNotaV2(BASE);
    expect(cuerpo()).toMatchObject({ id_comp_asoc: 58893294, tipo_comp_asoc: 'FA' });
  });

  it('🔑 sin id, la factura se identifica por punto de venta + número', async () => {
    await emitirNotaV2({ ...BASE, factura: { punto_de_venta: 777, numero: 50727 } });
    expect(cuerpo()).toMatchObject({ pto_vta_comp_asoc: 777, num_comp_asoc: 50727, tipo_comp_asoc: 'FA' });
    expect(cuerpo().id_comp_asoc).toBeUndefined();
  });

  it('🔑 el renglón lleva el de origen: con eso IM usa el precio de la factura', async () => {
    await emitirNotaV2({ ...BASE, items: [{ cod_articulo: 320, cantidad: 2, id_item_origen: 4411 }] });
    expect(cuerpo().items[0]).toMatchObject({ cod_articulo: 320, cantidad: 2, id_item_origen: 4411 });
  });

  it('va a /notas-credito o /notas-debito según el tipo, con su clave de idempotencia', async () => {
    await emitirNotaV2(BASE);
    expect(m.post.mock.calls[0][0]).toBe('/api/v2/notas-credito');
    expect(m.post.mock.calls[0][2]).toBe('corr-1-v1');
    vi.clearAllMocks(); m.post.mockResolvedValue(okIM);
    await emitirNotaV2({ ...BASE, tipo: 'ND', tipo_nc: undefined });
    expect(m.post.mock.calls[0][0]).toBe('/api/v2/notas-debito');
    expect(cuerpo().tipo_nc).toBeUndefined();
  });
});

describe('lo que NO se emite', () => {
  const rechaza = async (cambio: any, texto: RegExp) => {
    const r = await emitirNotaV2({ ...BASE, ...cambio });
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(texto);
    expect(m.post).not.toHaveBeenCalled();
  };

  it('🔴 sin identificar la factura: el vínculo ES el motivo de usar v2', async () => {
    await rechaza({ factura: {} }, /factura/i);
  });

  it('🔴 una NC sin subtipo: InfoManager lo exige y adivinarlo cambia qué hace la nota', async () => {
    await rechaza({ tipo_nc: undefined }, /subtipo|tipo_nc/i);
  });

  it('🔴 sin renglones', async () => {
    await rechaza({ items: [] }, /rengl/i);
  });

  it('🔴 reingresar stock con un subtipo que no es devolución', async () => {
    // `genero_re_auto: S` sólo vale con tipo_nc DE y cod_control C_RE. Mandarlo con FI reingresa
    // —o no— mercadería que nadie devolvió, y el stock no se arregla desde acá.
    await rechaza({ genero_re_auto: true, tipo_nc: 'FI' }, /devoluci|C_RE/i);
  });

  it('🔴 una cantidad que no es un número positivo', async () => {
    await rechaza({ items: [{ cod_articulo: 320, cantidad: 0 }] }, /cantidad/i);
  });
});

describe('la respuesta', () => {
  it('🔑 éxito es isCreated true, no "vino un 200"', async () => {
    const r = await emitirNotaV2(BASE);
    expect(r).toMatchObject({ ok: true, im_id: '58999001', numero: 30120 });
  });

  it('🔴 isCreated false NO es éxito aunque venga un id adentro', async () => {
    // Mismo patrón que crearPresupuesto en v1: IM contesta 200 con la nota que YA existía.
    m.post.mockResolvedValue({ isCreated: false, venta: { id: 58999001, numero: 30120 } });
    const r = await emitirNotaV2(BASE);
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/no la cre|isCreated/i);
  });

  it('🔑 si generó la recepción por devolución, se informa: es stock que volvió', async () => {
    m.post.mockResolvedValue({ ...okIM, recepcion: { id: 58999002, numero: 8123 } });
    const r: any = await emitirNotaV2({ ...BASE, tipo_nc: 'DE', cod_control: 'C_RE', genero_re_auto: true });
    expect(r.recepcion).toMatchObject({ im_id: '58999002', numero: 8123 });
  });

  it('🔴 un error de InfoManager no se traga: vuelve con su mensaje', async () => {
    m.post.mockRejectedValue(Object.assign(new Error('InfoManager v2 400 VALIDACION: el cliente no existe · traceId x-1'), { traceId: 'x-1' }));
    const r: any = await emitirNotaV2(BASE);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/el cliente no existe/);
  });
});

/**
 * 🪤 21/09/2026: la primera emisión de prueba rebotó con *"El usuario 'api_servicio' no tiene un
 * depósito predeterminado asignado. Ingrese un cod_deposito válido."* — el usuario con el que
 * entra la API no tiene depósito, así que el campo no es opcional para nosotros aunque el spec
 * lo marque así. Va el Depósito General, el mismo que usa el emisor v1.
 */
describe('el depósito', () => {
  it('🔴 siempre viaja: el usuario de la API no tiene uno predeterminado', async () => {
    await emitirNotaV2(BASE);
    expect(cuerpo().cod_deposito).toBe(1);
  });

  it('se puede pedir otro', async () => {
    await emitirNotaV2({ ...BASE, cod_deposito: 3 });
    expect(cuerpo().cod_deposito).toBe(3);
  });
});

/**
 * 🔴 22/09/2026 — LO QUE LE FALTÓ A LA PRIMERA NOTA EMITIDA POR v2.
 *
 * Mati: *"al emitir, querer imprimir esa NC en IM te llevaba a la impresora fiscal cuando en
 * realidad era una NC manual no fiscal"*. Comparada la NC B 30117 (emitida por v2 el 21/09)
 * contra la NC B 30116 (de la oficina, misma serie), la diferencia eran los campos de AFIP:
 *
 *     afip_comprobantes_fe   null  vs  ""
 *     afip_conceptos_fe      0     vs  1
 *
 * El emisor v1 ya los mandaba, con este comentario al lado: *"🔴 LOS CAMPOS AFIP DE LA NOTA. Sin
 * ellos IM la manda al CONTROLADOR FISCAL"* — el mismo problema que Mati reportó el 10/09/2026 y
 * que se había resuelto ahí. El emisor v2 nació sin ellos y lo repitió.
 */
describe('los campos de AFIP', () => {
  it('🔴 van SIEMPRE: sin ellos InfoManager manda la nota al controlador fiscal', async () => {
    await emitirNotaV2(BASE);
    expect(cuerpo()).toMatchObject({
      afip_comprobantes_fe: '', afip_tipdoc_fe: 0, afip_cond_vta: 0,
    });
  });

  it('🔑 conceptos_fe es 1 en la NC y 0 en la ND, como las que emite la oficina', async () => {
    await emitirNotaV2(BASE);
    expect(cuerpo().afip_conceptos_fe).toBe(1);
    vi.clearAllMocks(); m.post.mockResolvedValue(okIM);
    await emitirNotaV2({ ...BASE, tipo: 'ND', tipo_nc: undefined });
    expect(cuerpo().afip_conceptos_fe).toBe(0);
  });
});
