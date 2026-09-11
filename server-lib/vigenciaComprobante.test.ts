import { describe, expect, it } from 'vitest';
import { vigenciaDeCabecera, vigenciaSegunAnulada } from './vigenciaComprobante.js';

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
