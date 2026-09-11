import { describe, expect, it } from 'vitest';
import { clasificarFila, proximoDeLaSerie, type SerieComprobante } from './serieNumeracion.js';

const SERIE: SerieComprobante = { cod_empresa: 1, id_destino: 1, tag: 'S' };
const fila = (extra: any = {}) => ({ tipo_comprobante: 'FA', tipo_factura: 'B', punto_de_venta: 777, cod_empresa: 1, id_destino: 1, tag: 'S', numero: 100, ...extra });
const clasificar = (extra: any) => clasificarFila(fila(extra), SERIE, 'FA', 'B', 777);
const proximo = (filas: any[]) => proximoDeLaSerie(filas, SERIE, 'FA', 'B', 777);

describe('una contradicción legible descarta, aunque falte el resto', () => {
  /**
   * 🔴 El error que corrigió Astra: cortar por un dato ilegible cuando OTRA dimensión ya
   * demuestra que la fila es ajena. Eso bloqueaba la emisión sin motivo.
   */
  it('🔑 tipo distinto y letra ilegible: es ajena, no una duda', () => {
    expect(clasificar({ tipo_comprobante: 'PR', tipo_factura: null })).toBe('ajena');
  });

  it('🔑 empresa distinta y destino ilegible: ajena', () => {
    expect(clasificar({ cod_empresa: 2, id_destino: null })).toBe('ajena');
  });

  it('🔑 y una sola contradicción alcanza, esté donde esté', () => {
    for (const c of [{ tipo_comprobante: 'NC' }, { tipo_factura: 'A' }, { punto_de_venta: 999 }, { cod_empresa: 2 }, { id_destino: 3 }, { tag: 'N' }]) {
      expect(clasificar(c), JSON.stringify(c)).toBe('ajena');
    }
  });

  it('sin contradicciones y sin faltantes, es propia', () => {
    expect(clasificar({})).toBe('propia');
  });

  it('🪤 sin contradicciones pero con un dato ilegible, es una duda real', () => {
    for (const c of [{ tag: null }, { cod_empresa: 'x' }, { id_destino: [1] }, { punto_de_venta: null }, { tipo_factura: '' }, { cod_empresa: 1.5 }, { id_destino: 1e20 }]) {
      expect(clasificar(c), JSON.stringify(c)).toBe('desconocida');
    }
  });

  it('🪤 un tag fuera del contrato no es un tag', () => {
    expect(clasificar({ tag: 'X' })).toBe('desconocida');
  });
});

describe('el próximo número', () => {
  it('sale del máximo de la serie', () => {
    expect(proximo([fila({ numero: 100 }), fila({ numero: 105 }), fila({ numero: 9, cod_empresa: 2 })]))
      .toEqual({ estado: 'ok', numero: 106 });
  });

  it('🔑 una duda real corta: nunca proponer un correlativo ya usado', () => {
    const r = proximo([fila({ numero: 50400 }), fila({ numero: 50999, tag: null })]);
    expect(r.estado).toBe('incierto');
  });

  it('🔑 un número ilegible en una fila PROPIA también corta', () => {
    expect(proximo([fila({ numero: 100 }), fila({ numero: 'abc' })]).estado).toBe('incierto');
  });

  it('🔑 vacío e incierto son cosas distintas', () => {
    expect(proximo([fila({ cod_empresa: 2 })])).toEqual({ estado: 'vacio' });
    expect(proximo([]).estado).toBe('vacio');
    expect(proximo([fila({ tag: null })]).estado).toBe('incierto');
  });

  /** 🪤 Ver sólo ceros NO prueba un talonario sin usar: puede ser que no se haya guardado. */
  it('🔑 con sólo ceros no se arranca en 1', () => {
    const r = proximo([fila({ numero: 0 }), fila({ numero: 0 })]);
    expect(r.estado).toBe('incierto');
    expect(r).not.toEqual({ estado: 'ok', numero: 1 });
  });

  it('un cero junto a positivos no molesta', () => {
    expect(proximo([fila({ numero: 0 }), fila({ numero: 30 })])).toEqual({ estado: 'ok', numero: 31 });
  });

  it('🪤 pasado el entero seguro, no hay siguiente', () => {
    expect(proximo([fila({ numero: Number.MAX_SAFE_INTEGER })]).estado).toBe('incierto');
  });

  it('🔑 una serie pedida incompleta o con tag inválido no consulta nada', () => {
    for (const s of [{ cod_empresa: 0, id_destino: 1, tag: 'S' }, { cod_empresa: 1, id_destino: 1, tag: 'X' }, { cod_empresa: 1.5, id_destino: 1, tag: 'S' }]) {
      expect(proximoDeLaSerie([fila()], s as any, 'FA', 'B', 777).estado, JSON.stringify(s)).toBe('incierto');
    }
  });

  it('🔑 y un punto de venta objetivo ilegible tampoco', () => {
    expect(proximoDeLaSerie([fila()], SERIE, 'FA', 'B', 0).estado).toBe('incierto');
    expect(proximoDeLaSerie([fila()], SERIE, 'FA', 'B', NaN as any).estado).toBe('incierto');
  });
});
