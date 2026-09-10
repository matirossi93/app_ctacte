import { describe, it, expect } from 'vitest';

/**
 * EL ORDEN DE LOS CLIENTES EN LA HOJA IMPRESA.
 *
 * Mati (10/09/2026): *"a la hora de imprimir las hojas de ruta deberían ordenarse por orden
 * alfabético también"*. En el papel se busca por apellido; el orden en que se cargaron los
 * pedidos no ayuda a encontrar a nadie.
 */

/** El mismo criterio que usa `impresionHoja`. */
const ordenar = (cs: Array<{ cliente_nombre: string | null }>) =>
  [...cs].sort((a, b) =>
    String(a.cliente_nombre ?? '').localeCompare(String(b.cliente_nombre ?? ''), 'es', { sensitivity: 'base' }));

const nombres = (cs: Array<{ cliente_nombre: string | null }>) => ordenar(cs).map(c => c.cliente_nombre);

describe('el orden alfabético de la hoja impresa', () => {
  it('🔴 ordena por apellido, no por cómo se cargaron', () => {
    expect(nombres([
      { cliente_nombre: 'PASTERIS, Luis' },
      { cliente_nombre: 'BACA, Pablo' },
      { cliente_nombre: 'MERCADO, Osvaldo' },
    ])).toEqual(['BACA, Pablo', 'MERCADO, Osvaldo', 'PASTERIS, Luis']);
  });

  /**
   * 🪤 EL ACENTO. Con un `sort` común, "ÁVILA" se va DESPUÉS de "ZARATE" porque compara códigos
   * de carácter. En un padrón lleno de apellidos con tilde, eso es media hoja fuera de lugar.
   */
  it('🪤 los acentos van donde corresponde, no al final', () => {
    expect(nombres([
      { cliente_nombre: 'ZARATE, Juan' },
      { cliente_nombre: 'ÁVILA, Sergio' },
      { cliente_nombre: 'IBAÑEZ, Nancy' },
    ])).toEqual(['ÁVILA, Sergio', 'IBAÑEZ, Nancy', 'ZARATE, Juan']);
  });

  /** 🪤 La ñ va entre la n y la o, que es donde la busca una persona. */
  it('🪤 la ñ queda en su lugar del abecedario', () => {
    expect(nombres([
      { cliente_nombre: 'ORTIZ' }, { cliente_nombre: 'PEÑA' }, { cliente_nombre: 'NUÑEZ' },
    ])).toEqual(['NUÑEZ', 'ORTIZ', 'PEÑA']);
  });

  it('mayúsculas y minúsculas no separan a dos clientes parecidos', () => {
    expect(nombres([
      { cliente_nombre: 'diaz, alfredo' }, { cliente_nombre: 'DIAZ, Ariel' },
    ])).toEqual(['diaz, alfredo', 'DIAZ, Ariel']);
  });

  it('🪤 un cliente sin nombre no rompe el orden ni desaparece', () => {
    const r = ordenar([{ cliente_nombre: 'BACA' }, { cliente_nombre: null }, { cliente_nombre: 'AVILA' }]);
    expect(r).toHaveLength(3);
    expect(r[0].cliente_nombre).toBeNull();
  });
});
