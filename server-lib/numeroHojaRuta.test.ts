import { describe, it, expect } from 'vitest';
import { proximoNumeroHoja, NUMERO_MINIMO_HOJA } from './numeroHojaRuta.js';

/**
 * EL NÚMERO DE LA HOJA DE RUTA.
 *
 * 🔑 Es la misma serie que la oficina venía llevando a mano en InfoManager, para que puedan
 * decir "la 3402" sin traducir entre dos numeraciones.
 *
 * Mati (10/09/2026): *"al nº de hoja de ruta deberíamos subirle 2 números, para que sea
 * correlativo con las que veníamos haciendo hasta ahora con el panel de IM"*. La última del panel
 * era la 3399 y la siguiente iba a salir 3400, pero en IM ya habían usado dos más.
 */
describe('proximoNumeroHoja', () => {
  it('🔴 sigue al último: es una serie, no un contador propio', () => {
    expect(proximoNumeroHoja(3405)).toBe(3406);
  });

  /**
   * 🔴 EL SALTO QUE PIDIÓ MATI. El piso alcanza a la serie una sola vez: con la última en 3399
   * la próxima sale 3402 en vez de 3400.
   */
  it('🔴 salta hasta el piso cuando la serie quedó atrás', () => {
    expect(proximoNumeroHoja(3399)).toBe(NUMERO_MINIMO_HOJA);
    expect(NUMERO_MINIMO_HOJA).toBe(3402);
  });

  /**
   * 🪤 Y DESPUÉS DEJA DE MOLESTAR. Un piso que se aplicara siempre sumaría el salto a cada hoja
   * nueva y la serie nunca avanzaría de a uno: 3402, 3402, 3402…
   */
  it('🪤 una vez que la serie lo pasa, el piso no vuelve a tocar nada', () => {
    expect(proximoNumeroHoja(3402)).toBe(3403);
    expect(proximoNumeroHoja(3403)).toBe(3404);
    expect(proximoNumeroHoja(3500)).toBe(3501);
  });

  it('sin ninguna hoja todavía arranca donde quedó InfoManager', () => {
    expect(proximoNumeroHoja(null)).toBe(NUMERO_MINIMO_HOJA);
    expect(proximoNumeroHoja(undefined)).toBe(NUMERO_MINIMO_HOJA);
  });

  /** 🪤 Una hoja con número basura no puede hacer retroceder la serie ni tirar NaN. */
  it('🪤 un número inválido no rompe la serie', () => {
    expect(proximoNumeroHoja(NaN)).toBe(NUMERO_MINIMO_HOJA);
    expect(proximoNumeroHoja('3405' as any)).toBe(3406);
    expect(proximoNumeroHoja(-7)).toBe(NUMERO_MINIMO_HOJA);
  });

  it('se puede correr el piso sin tocar código', () => {
    expect(proximoNumeroHoja(3399, { minimo: 3410 })).toBe(3410);
    expect(proximoNumeroHoja(3420, { minimo: 3410 })).toBe(3421);
  });
});
