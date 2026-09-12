import { describe, expect, it } from 'vitest';
import { verificarNota } from './notaVinculable.js';

const ENTREGA = { cod_cliente: 1039, cod_empresa: 1 };
const NOTA = {
  id: '58900001', tipo_comprobante: 'NC', tipo_factura: 'B', numero: 30078,
  cod_cliente: 1039, cod_empresa: 1, anulada: 'N', total: 24648.45,
};
const ver = (extra: any = {}, pedida = '58900001') => verificarNota({ ...NOTA, ...extra }, pedida, ENTREGA, 1);

describe('una nota vinculable', () => {
  it('🔑 la NC resta y la ND suma: el signo sale del TIPO verificado en IM', () => {
    const nc = ver();
    expect(nc.ok && nc.signo).toBe(-1);
    const nd = ver({ tipo_comprobante: 'ND' });
    expect(nd.ok && nd.signo).toBe(1);
  });

  it('el importe sale de la nota, en valor absoluto', () => {
    expect(ver({ total: -24648.45 })).toMatchObject({ ok: true, importe: 24648.45 });
    expect(ver({ total: '24648.45' })).toMatchObject({ ok: true, importe: 24648.45 });
  });

  it('y devuelve letra y número para poder mostrarlos antes de confirmar', () => {
    expect(ver()).toMatchObject({ ok: true, tipo: 'NC', letra: 'B', numero: 30078 });
  });

  it('🔑 devuelve el id CANÓNICO, que es el que hay que grabar', () => {
    // Quien graba no tiene que reconstruirlo: los ceros a la izquierda y el número suelto
    // son el mismo comprobante, y la fila tiene que quedar con una sola forma.
    expect(ver({ id: '0058900001' })).toMatchObject({ ok: true, id: '58900001' });
    expect(ver({ id: 58900001 })).toMatchObject({ ok: true, id: '58900001' });
    expect(ver({ id: '0058900001' }, '58900001')).toMatchObject({ ok: true });
  });
});

describe('lo que RECHAZA', () => {
  it('🔑 un comprobante distinto del pedido', () => {
    expect(ver({}, '99999')).toMatchObject({ ok: false });
    expect((ver({}, '99999') as any).error).toMatch(/distinto/i);
  });

  /**
   * 🔴 Esto ESCRIBE un vínculo, no compara de sólo lectura: una respuesta que no acredita QUÉ
   * comprobante contestó no alcanza para atarle plata a una hoja de ruta. Y si pasara, la fila
   * terminaría grabando el id que el llamador tuviera a mano.
   */
  it('🔑 una respuesta que no acredita su id', () => {
    for (const id of [null, undefined, '', '  ', true, {}, [], ['58900001'], 1.5, 0, '0', 'abc', -1]) {
      expect(ver({ id }).ok, JSON.stringify(id)).toBe(false);
    }
    expect((ver({ id: null }) as any).error).toMatch(/no acreditó/i);
  });

  it('🔑 un id pedido que no es un id', () => {
    for (const p of [null, undefined, '', 'abc', 0, 1.5, true]) {
      expect(verificarNota(NOTA, p, ENTREGA, 1).ok, JSON.stringify(p)).toBe(false);
    }
  });

  it('🔑 sin número no se puede confirmar el comprobante en pantalla', () => {
    for (const n of [null, undefined, '', 0, '0', -5, 1.5, true, [30078], 'abc', 2_147_483_648]) {
      expect(ver({ numero: n }).ok, JSON.stringify(n)).toBe(false);
    }
    expect(ver({ numero: '30078' })).toMatchObject({ ok: true, numero: 30078 });
  });

  it('🔑 lo que no es una nota', () => {
    for (const t of ['FA', 'RE', 'PR', '', null, 'nc ']) {
      const r = ver({ tipo_comprobante: t });
      if (t === 'nc ') { expect(r.ok, String(t)).toBe(true); continue; }  // se normaliza
      expect(r.ok, JSON.stringify(t)).toBe(false);
    }
  });

  it('🔑 una vigencia que no se puede CONFIRMAR, no sólo la anulada', () => {
    // 'S' y `true` son anulaciones EXPLÍCITAS; el resto es 'no se sabe'.
    for (const a of ['S', true]) expect(ver({ anulada: a }).ok, JSON.stringify(a)).toBe(false);
    for (const a of [null, undefined, '', 'X', ['N'], 0, 1]) {
      const r = ver({ anulada: a });
      expect(r.ok, JSON.stringify(a)).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/no se pudo confirmar/i);
    }
  });

  it('🔑 sin letra legible', () => {
    for (const l of [null, '', '  ', 'FA B', 12]) expect(ver({ tipo_factura: l }).ok, JSON.stringify(l)).toBe(false);
  });

  it('🔑 de otro cliente o de otra empresa', () => {
    expect(ver({ cod_cliente: 777 }).ok).toBe(false);
    expect(ver({ cod_empresa: 2 }).ok).toBe(false);
    expect(verificarNota(NOTA, '58900001', { cod_cliente: 1039, cod_empresa: 2 }, 1).ok).toBe(false);
  });

  it('🔑 con la entrega sin cliente o empresa verificados', () => {
    expect(verificarNota(NOTA, '58900001', { cod_cliente: null, cod_empresa: 1 }, 1).ok).toBe(false);
    expect(verificarNota(NOTA, '58900001', { cod_cliente: 1039, cod_empresa: 0 }, 1).ok).toBe(false);
  });

  /** 🪤 `Number(true)` es 1 y `Number(["5"])` es 5: coincidir por coerción no es coincidir. */
  it('🔑 un importe que no es un número legible', () => {
    for (const t of [null, undefined, '', '   ', true, [24648], {}, NaN, Infinity, 'abc']) {
      expect(ver({ total: t }).ok, JSON.stringify(t)).toBe(false);
    }
  });

  it('🔑 importe cero', () => {
    expect(ver({ total: 0 }).ok).toBe(false);
    expect(ver({ total: '0' }).ok).toBe(false);
  });

  it('y una nota que no existe', () => {
    expect(verificarNota(null, '1', ENTREGA, 1).ok).toBe(false);
  });
});
