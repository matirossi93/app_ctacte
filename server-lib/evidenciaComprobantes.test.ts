import { describe, expect, it } from 'vitest';
import { compararPar, proyectarEvidencia, type ParVinculado } from './evidenciaComprobantes.js';

const item = (cod: number, cant: unknown) => ({ cod_articulo: cod, cantidad: cant });
const fa = { id: '20', tipo_comprobante: 'FA', tipo_factura: 'B', numero: 50420, cod_cliente: 1054, cod_empresa: 1, anulada: 'N' };
const re = { id: '30', tipo_comprobante: 'RE', numero: 77397, cod_cliente: 1054, cod_empresa: 1, anulada: 'N' };
const par: ParVinculado = { im_factura_id: '20', im_remito_id: '30', im_factura_numero: 50420, im_factura_tipo: 'FA B', im_remito_numero: 77397, cod_cliente: 1054, cod_empresa: 1 };

const evidencia = (items: Record<string, any[]>, ventas: any[] = [fa, re], pares: ParVinculado[] = [par]) =>
  proyectarEvidencia(new Map(Object.entries(items)), ventas, pares, 1_700_000_000_000);

describe('la evidencia se queda sólo con lo que hace falta', () => {
  it('🔑 descarta los comprobantes que no son de un par vinculado', () => {
    const ev = evidencia({ '20': [item(1, 2)], '30': [item(1, 2)], '99': [item(5, 9)] },
      [fa, re, { id: '99', tipo_comprobante: 'FA', cod_empresa: 2 }]);
    expect([...ev.cabeceras.keys()].sort()).toEqual(['20', '30']);
    expect(ev.renglones.has('99')).toBe(false);
  });

  it('🪤 un par a medias no aporta evidencia: no hay con qué comparar', () => {
    const ev = evidencia({ '20': [item(1, 2)] }, [fa], [{ im_factura_id: '20' }]);
    expect(ev.cabeceras.size).toBe(0);
  });

  it('🪤 conserva la cantidad CRUDA, sin convertir', () => {
    const ev = evidencia({ '20': [item(1, null)], '30': [item(1, 2)] });
    expect(ev.renglones.get('20')![0].cantidad).toBeNull();
  });

  it('🪤 el momento de lectura es el que le pasan, no "ahora"', () => {
    expect(evidencia({}).leidoEn).toBe(1_700_000_000_000);
  });
});

describe('comparar un par', () => {
  it('🔑 el caso Fernández: el remito lleva dos artículos que la factura no', () => {
    const ev = evidencia({ '20': [item(509, 1)], '30': [item(509, 1), item(378, 1), item(379, 1)] });
    const r = compararPar(par, ev);
    expect(r.estado).toBe('diferencias');
    expect(r.diferencias?.map(d => d.cod_articulo)).toEqual([378, 379]);
  });

  it('coinciden cuando coinciden', () => {
    expect(compararPar(par, evidencia({ '20': [item(509, 1)], '30': [item(509, 1)] })).estado).toBe('coinciden');
  });

  it('🔑 sin los dos comprobantes emitidos, no se afirma nada', () => {
    expect(compararPar({ im_factura_id: '20' }, evidencia({})).estado).toBe('no_verificado');
    expect(compararPar({}, evidencia({})).estado).toBe('no_verificado');
  });

  it('🔑 fuera de la cobertura de días: lo dice y ofrece comparar a pedido', () => {
    const r = compararPar(par, evidencia({ '20': [item(1, 1)] }, [fa]));
    expect(r.estado).toBe('no_verificado');
    expect(r.motivo).toContain('a pedido');
  });

  it('🔑 anulado en IM: no se compara', () => {
    const ev = evidencia({ '20': [item(1, 1)], '30': [item(1, 1)] }, [{ ...fa, anulada: 'S' }, re]);
    expect(compararPar(par, ev).motivo).toContain('anulado');
  });

  /** 🔴 `leerComprobante` no devuelve el id: sin contrastar el número se compara otra factura. */
  it('🔑 si el número no coincide con el guardado, no es la misma factura', () => {
    const ev = evidencia({ '20': [item(1, 1)], '30': [item(1, 1)] }, [{ ...fa, numero: 99999 }, re]);
    expect(compararPar(par, ev).motivo).toContain('factura registrada no coincide');
  });

  it('🔑 ni si cambió la letra', () => {
    const ev = evidencia({ '20': [item(1, 1)], '30': [item(1, 1)] }, [{ ...fa, tipo_factura: 'A' }, re]);
    expect(compararPar(par, ev).motivo).toContain('factura registrada no coincide');
  });

  it('🔑 ni si es de otro cliente o de otra empresa', () => {
    for (const cambio of [{ cod_cliente: 999 }, { cod_empresa: 2 }]) {
      const ev = evidencia({ '20': [item(1, 1)], '30': [item(1, 1)] }, [{ ...fa, ...cambio }, re]);
      expect(compararPar(par, ev).estado, JSON.stringify(cambio)).toBe('no_verificado');
    }
  });

  it('🪤 un remito que en IM figura como factura no es el remito', () => {
    const ev = evidencia({ '20': [item(1, 1)], '30': [item(1, 1)] }, [fa, { ...re, tipo_comprobante: 'FA' }]);
    expect(compararPar(par, ev).motivo).toContain('remito registrado no coincide');
  });

  it('sin evidencia en la pantalla, no_verificado', () => {
    expect(compararPar(par, null).estado).toBe('no_verificado');
  });
});

/** Bloqueantes que encontró Astra: lo que FALTA también impide acreditar, no sólo lo que choca. */
describe('identidad incompleta no es identidad', () => {
  const ev = (extra: any = {}) => evidencia({ '20': [item(1, 1)], '30': [item(1, 1)] }, [{ ...fa, ...extra }, re]);

  it('🔑 si el registro no guarda cliente, empresa o número, no se acredita', () => {
    for (const falta of [{ cod_cliente: null }, { cod_empresa: null }, { im_factura_numero: null }, { im_remito_numero: null }]) {
      expect(compararPar({ ...par, ...falta }, ev()).estado, JSON.stringify(falta)).toBe('no_verificado');
    }
  });

  it('🔑 ni con un cliente o número en cero', () => {
    expect(compararPar({ ...par, cod_cliente: 0 }, ev()).estado).toBe('no_verificado');
    expect(compararPar({ ...par, im_factura_numero: 0 }, ev()).estado).toBe('no_verificado');
  });

  it('🔑 la letra de la factura tiene que estar y ser A o B', () => {
    for (const letra of [null, '', 'FA', 'X', 'FA X']) {
      expect(compararPar({ ...par, im_factura_tipo: letra }, ev()).estado, String(letra)).toBe('no_verificado');
    }
  });

  it('🪤 nada de acreditar por coerción', () => {
    expect(compararPar({ ...par, cod_cliente: ['1054'] as any }, ev()).estado).toBe('no_verificado');
    expect(compararPar(par, ev({ numero: ['50420'] })).estado).toBe('no_verificado');
  });
});

/** 🔴 Antes sólo se descartaba `anulada: 'S'`: un null o una 'X' llegaban a "coinciden". */
describe('vigencia: sólo con los dos confirmados', () => {
  it('🔑 una anulación desconocida no habilita a comparar', () => {
    for (const a of [null, undefined, 'X', true, '']) {
      const ev = evidencia({ '20': [item(1, 1)], '30': [item(1, 1)] }, [{ ...fa, anulada: a }, re]);
      expect(compararPar(par, ev).estado, JSON.stringify(a)).toBe('no_verificado');
    }
  });

  it('con los dos en N sí se compara', () => {
    expect(compararPar(par, evidencia({ '20': [item(1, 1)], '30': [item(1, 1)] })).estado).toBe('coinciden');
  });
});
