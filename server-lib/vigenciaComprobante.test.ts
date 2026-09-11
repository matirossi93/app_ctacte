import { describe, expect, it } from 'vitest';
import { parsearAnulada, vigenciaDeCabecera, vigenciaSegunAnulada } from './vigenciaComprobante.js';

describe('vigenciaSegunAnulada', () => {
  it('los valores explícitos de IM', () => {
    expect(vigenciaSegunAnulada('S')).toBe(false);
    expect(vigenciaSegunAnulada('s')).toBe(false);
    expect(vigenciaSegunAnulada(' N ')).toBe(true);
    expect(vigenciaSegunAnulada(true)).toBe(false);
    expect(vigenciaSegunAnulada(false)).toBe(true);
  });

  // 🔴 El que importa: un "no sé" que se lee como "anulado" borra el vínculo PR↔FA.
  it('🔑 lo ausente o ilegible es null, NUNCA false', () => {
    for (const v of [null, undefined, '', '   ', 'X', 0, 1, {}]) {
      expect(vigenciaSegunAnulada(v as any), String(v)).toBeNull();
    }
  });
});

describe('vigenciaDeCabecera', () => {
  it('`existe: false` es anulado/inexistente, y manda sobre el resto', () => {
    expect(vigenciaDeCabecera({ existe: false, anulada: false })).toBe(false);
  });

  it('sin poder preguntar, null', () => {
    expect(vigenciaDeCabecera({ existe: null, anulada: false })).toBeNull();
    expect(vigenciaDeCabecera({} as any)).toBeNull();
  });

  /**
   * 🔴 EL CASO QUE MOTIVÓ ESTO. Existe, pero IM no dijo si está anulada. La versión anterior
   * calculaba `c.anulada === false` y devolvía FALSE: sincronizarAnulados borraba el registro de
   * una factura viva, o limpiaba el remito de un pedido ya despachado.
   */
  it('🔑 existe pero sin `anulada`: no se sabe, no "anulada"', () => {
    expect(vigenciaDeCabecera({ existe: true, anulada: null })).toBeNull();
    expect(vigenciaDeCabecera({ existe: true })).toBeNull();
  });

  it('existe y con dato: se responde', () => {
    expect(vigenciaDeCabecera({ existe: true, anulada: false })).toBe(true);
    expect(vigenciaDeCabecera({ existe: true, anulada: true })).toBe(false);
    expect(vigenciaDeCabecera({ existe: true, anulada: 'S' })).toBe(false);
  });
});

/**
 * 🪤 La incertidumbre se pierde en el PARSEO si no se cuida ahí: `String(a) === 'S'` convierte
 * 'X' o '' en `false` = vigente, y después ningún helper puede recuperarla.
 */
describe('parsearAnulada', () => {
  it('los valores del contrato', () => {
    expect(parsearAnulada('S')).toBe(true);
    expect(parsearAnulada(' s ')).toBe(true);
    expect(parsearAnulada('N')).toBe(false);
    expect(parsearAnulada(true)).toBe(true);
    expect(parsearAnulada(false)).toBe(false);
  });

  it('🔑 cualquier otro valor es null, no false', () => {
    for (const v of [null, undefined, '', '  ', 'X', 'SI', 'NO', 0, 1, {}]) {
      expect(parsearAnulada(v as any), JSON.stringify(v)).toBeNull();
    }
  });

  it('y encadenado con la vigencia, un valor ilegible no da vigente ni anulado', () => {
    expect(vigenciaDeCabecera({ existe: true, anulada: parsearAnulada('X') })).toBeNull();
    expect(vigenciaDeCabecera({ existe: true, anulada: parsearAnulada('N') })).toBe(true);
    expect(vigenciaDeCabecera({ existe: true, anulada: parsearAnulada('S') })).toBe(false);
  });
});

/**
 * 🔴 La coerción a string convierte un dato ilegible en una respuesta definitiva:
 * `String(["S"])` es `"S"`, y un array pasaba como "anulado" — con eso el flujo real limpia el
 * remito de un pedido despachado. Encontrado por Astra en revisión.
 */
describe('sólo texto o booleano deciden', () => {
  it('🔑 un array que se coerce a "S" NO es anulado', () => {
    expect(parsearAnulada(['S'])).toBeNull();
    expect(vigenciaSegunAnulada(['S'])).toBeNull();
    expect(vigenciaDeCabecera({ existe: true, anulada: parsearAnulada(['S']) })).toBeNull();
  });

  it('🔑 ni un array que se coerce a "N" es vigente', () => {
    expect(parsearAnulada(['N'])).toBeNull();
    expect(vigenciaSegunAnulada(['N'])).toBeNull();
  });

  it('objetos, números y anidados tampoco', () => {
    for (const v of [{ toString: () => 'S' }, [['S']], 0, 1, new String('S')]) {
      expect(parsearAnulada(v as any), JSON.stringify(v)).toBeNull();
    }
  });
});
