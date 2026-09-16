import { describe, expect, it, vi } from 'vitest';

// La marca del remito sale de `facturarIM`, que al cargarse exige el secreto de InfoManager.
// Se importa de ahí a propósito: duplicar el texto de la marca sería que dejen de coincidir.
vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });
const { resolverSinRespuesta, esConciliable } = await import('./conciliarSinRespuesta.js');

/**
 * 🔴 De acá salen ESCRITURAS sobre comprobantes fiscales ya emitidos. Adoptar el comprobante
 * equivocado sería atarle a un cliente la mercadería de otro; adoptar uno que ya está en otro
 * pedido lo contaría dos veces.
 */
const FILA = { im_comprobante_id: '58835613', im_numero: 58537, cod_cliente: 1093, cod_empresa: 1 };
const RE = {
  id: '58840001', numero: 77600, tipo_comprobante: 'RE', tipo_factura: 'X', cod_cliente: 1093,
  cod_empresa: 1, anulada: 'N', observaciones: 'Pedido 58537 [Remito Automático -FA:58839000]',
};
const FA = {
  id: '58839000', numero: 1632, tipo_comprobante: 'FA', tipo_factura: 'A', cod_cliente: 1093,
  cod_empresa: 1, anulada: 'N', observaciones: 'Pedido 58537', cod_compatibilidad: '58835613',
};
const conFactura = { ...FILA, im_factura_id: '58839000' };
const sin = new Set<string>();

describe('el remito que quedó en duda', () => {
  it('🔑 se reconoce por la marca que la app le escribe con la factura', () => {
    expect(resolverSinRespuesta(conFactura, [RE, FA], sin))
      .toEqual({ accion: 'adoptar', que: 'remito', id: '58840001', numero: 77600, tipo: 'RE X' });
  });

  /** 🪤 No se aparea por importe: un remito no valorizado sale en cero y no coincidiría con nada. */
  it('🔑 el importe no entra en la decisión', () => {
    const sinValorizar = { ...RE, total: 0 };
    expect(resolverSinRespuesta(conFactura, [sinValorizar], sin)).toMatchObject({ accion: 'adoptar', que: 'remito' });
  });

  it('🔴 no adopta el remito de OTRA factura, aunque sea del mismo cliente', () => {
    const otro = { ...RE, id: '58840002', observaciones: '[Remito Automático -FA:99999999]' };
    expect(resolverSinRespuesta(conFactura, [otro], sin)).toMatchObject({ accion: 'revisar' });
  });

  it('🔴 ni uno de otro cliente o de otra empresa, ni uno anulado', () => {
    for (const malo of [{ cod_cliente: 777 }, { cod_empresa: 2 }, { anulada: 'S' }]) {
      expect(resolverSinRespuesta(conFactura, [{ ...RE, ...malo }], sin), JSON.stringify(malo))
        .toMatchObject({ accion: 'revisar' });
    }
  });

  /** 🪤 `null`, `''` o `'X'` en `anulada` son "no se sabe", y no se escribe sobre una duda. */
  it('🔴 ni uno cuya vigencia no se pueda confirmar', () => {
    for (const a of [null, undefined, '', 'X', ['N']]) {
      expect(resolverSinRespuesta(conFactura, [{ ...RE, anulada: a }], sin), JSON.stringify(a))
        .toMatchObject({ accion: 'revisar' });
    }
  });

  it('🔴 ni uno que ya está registrado en otro pedido: se contaría dos veces', () => {
    expect(resolverSinRespuesta(conFactura, [RE], new Set(['58840001']))).toMatchObject({ accion: 'revisar' });
  });

  it('🔴 con dos candidatos no elige: avisa', () => {
    const otro = { ...RE, id: '58840003', numero: 77601 };
    const r = resolverSinRespuesta(conFactura, [RE, otro], sin);
    expect(r).toMatchObject({ accion: 'revisar' });
    if (r.accion === 'revisar') expect(r.motivo).toMatch(/2 remitos/);
  });

  it('sin evidencia no destraba nada, y dice qué mirar', () => {
    const r = resolverSinRespuesta(conFactura, [FA], sin);
    expect(r).toMatchObject({ accion: 'revisar' });
    if (r.accion === 'revisar') expect(r.motivo).toMatch(/falta emitirlo/i);
  });
});

describe('la factura que quedó en duda', () => {
  it('🔑 se reconoce por el código del presupuesto que IM guarda', () => {
    expect(resolverSinRespuesta(FILA, [FA], sin))
      .toEqual({ accion: 'adoptar', que: 'factura', id: '58839000', numero: 1632, tipo: 'FA A' });
  });

  it('🔴 no adopta la factura de otro presupuesto', () => {
    expect(resolverSinRespuesta(FILA, [{ ...FA, cod_compatibilidad: '58835699' }], sin))
      .toMatchObject({ accion: 'revisar' });
  });

  /** 🪤 El código son los 8 primeros caracteres: así lo manda la app al emitir. */
  it('compara los 8 caracteres que IM guarda, no el id entero', () => {
    expect(resolverSinRespuesta({ ...FILA, im_comprobante_id: '588356139' }, [{ ...FA, cod_compatibilidad: '58835613' }], sin))
      .toMatchObject({ accion: 'adoptar', que: 'factura' });
  });

  it('🔴 no confunde un remito con una factura', () => {
    expect(resolverSinRespuesta(FILA, [{ ...RE, cod_compatibilidad: '58835613' }], sin))
      .toMatchObject({ accion: 'revisar' });
  });

  it('sin evidencia deja el pedido como está', () => {
    const r = resolverSinRespuesta(FILA, [], sin);
    expect(r).toMatchObject({ accion: 'revisar' });
    if (r.accion === 'revisar') expect(r.motivo).toMatch(/no encontré ninguna factura/i);
  });
});

describe('lo que no toca', () => {
  it('un pedido ya completo', () => {
    expect(resolverSinRespuesta({ ...conFactura, im_remito_id: '58840001' }, [RE, FA], sin))
      .toMatchObject({ accion: 'revisar', motivo: expect.stringMatching(/ya tiene su factura y su remito/) });
  });

  it('🔴 y una entrega sin cliente o sin empresa verificados', () => {
    for (const falta of [{ cod_cliente: null }, { cod_empresa: null }]) {
      expect(resolverSinRespuesta({ ...conFactura, ...falta }, [RE], sin), JSON.stringify(falta))
        .toMatchObject({ accion: 'revisar' });
    }
  });
});

/**
 * 🔴 QUÉ FILAS PUEDE MIRAR LA CONCILIACIÓN.
 *
 * 16/09/2026: PR 58680 (URUEÑA) quedó en `remito_emitiendo` con la factura 50640 ya emitida y el
 * remito colgado. Ese estado no lo miraba nadie: la conciliación sólo buscaba `incierto`, el
 * checkbox estaba deshabilitado y "Liberar" sólo borra `rechazado`. Callejón sin salida.
 *
 * 🪤 Pero un `*_emitiendo` RECIÉN reclamado es alguien emitiendo AHORA MISMO. Tocarlo sería
 * adoptar un comprobante mientras el proceso que lo emitió está por registrarlo.
 */
const VENCE = 5 * 60_000;
const AHORA = Date.parse('2026-09-16T14:40:00Z');
const haceMinutos = (m: number) => new Date(AHORA - m * 60_000).toISOString();

describe('qué filas entran a conciliarse', () => {
  it('🔑 la que quedó en duda por un timeout, siempre', () => {
    expect(esConciliable({ estado_emision: 'incierto', reclamado_at: haceMinutos(0) }, AHORA, VENCE)).toBe(true);
  });

  it('🔑 el remito colgado hace rato: PR 58680, la factura salió y el remito quedó a medias', () => {
    expect(esConciliable({ estado_emision: 'remito_emitiendo', reclamado_at: haceMinutos(14) }, AHORA, VENCE)).toBe(true);
    expect(esConciliable({ estado_emision: 'factura_emitiendo', reclamado_at: haceMinutos(14) }, AHORA, VENCE)).toBe(true);
  });

  it('🔴 pero NO el que se está emitiendo en este momento', () => {
    expect(esConciliable({ estado_emision: 'remito_emitiendo', reclamado_at: haceMinutos(1) }, AHORA, VENCE)).toBe(false);
    expect(esConciliable({ estado_emision: 'factura_emitiendo', reclamado_at: haceMinutos(4) }, AHORA, VENCE)).toBe(false);
  });

  it('🔴 ni un emitiendo sin fecha de reclamo: sin saber de cuándo es, no se toca', () => {
    for (const reclamado_at of [null, undefined, '', 'cualquier cosa']) {
      expect(esConciliable({ estado_emision: 'remito_emitiendo', reclamado_at }, AHORA, VENCE), String(reclamado_at)).toBe(false);
    }
  });

  it('🔴 ni lo que ya está resuelto o anulado', () => {
    for (const estado_emision of ['completo', 'remito_pendiente', 'anulado', 'rechazado', null]) {
      expect(esConciliable({ estado_emision, reclamado_at: haceMinutos(60) }, AHORA, VENCE), String(estado_emision)).toBe(false);
    }
  });
});
