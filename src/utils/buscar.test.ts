import { describe, it, expect } from 'vitest';
import { coincide, normalizar } from './buscar';

/**
 * El buscador de las listas del panel. Lo que importa es que la oficina encuentre al cliente
 * escribiendo como habla, sin acordarse de acentos ni del orden del nombre.
 */
describe('buscar', () => {
  it('🔴 encuentra sin acentos: nadie escribe "DÍAZ" con tilde', () => {
    expect(coincide('diaz', ['DÍAZ, Alfredo (Este)'])).toBe(true);
    expect(coincide('DÍAZ', ['diaz alfredo'])).toBe(true);
  });

  /**
   * 🪤 Sacar los diacríticos a lo bruto convierte "PEÑA" en "pena", y entonces buscar "peña" no
   * encuentra a Peña. La ñ se protege aparte.
   */
  it('🔴 la ñ no se come: PEÑA se encuentra escribiendo peña', () => {
    expect(coincide('peña', ['PEÑA, Ramón'])).toBe(true);
    expect(coincide('pena', ['PEÑA, Ramón'])).toBe(false);
    expect(normalizar('PEÑA')).toBe('peña');
  });

  it('las palabras pueden ir en cualquier orden', () => {
    expect(coincide('alfredo diaz', ['DIAZ, Alfredo (Este)'])).toBe(true);
    expect(coincide('diaz alfredo', ['DIAZ, Alfredo (Este)'])).toBe(true);
  });

  it('busca también por número de comprobante', () => {
    expect(coincide('58314', ['DIAZ, Alfredo', 58314, 50406])).toBe(true);
    expect(coincide('50406', ['DIAZ, Alfredo', 58314, 50406])).toBe(true);
  });

  it('🔴 una palabra que no está descarta la fila: si no, el buscador no filtra nada', () => {
    expect(coincide('diaz bustos', ['DIAZ, Alfredo'])).toBe(false);
  });

  it('sin búsqueda pasan todas', () => {
    expect(coincide('', ['lo que sea'])).toBe(true);
    expect(coincide('   ', ['lo que sea'])).toBe(true);
  });

  it('un campo vacío o nulo no rompe nada', () => {
    expect(coincide('diaz', [null, undefined, 'DIAZ'])).toBe(true);
  });

  /** Dos campos distintos no se pegan: "diaz 58314" no puede matchear cruzando el borde. */
  it('no matchea a caballo de dos campos', () => {
    expect(coincide('alfredo58314', ['DIAZ, Alfredo', 58314])).toBe(false);
  });
});
