import { describe, it, expect } from 'vitest';
import { hastaConAdelanto, recortarHasta } from './rangoConAdelanto.js';

/**
 * 🔴 22/09/2026. La pantalla de facturación tardaba 10 a 20 segundos y Mati: *"la velocidad de la
 * sección de facturación es lentísima, nos está haciendo perder mucho tiempo"*.
 *
 * Medido contra producción ese día: de 160 comprobantes a verificar, 26 no estaban en el listado
 * del día y se leían **de a uno** — 7,8 segundos de la carga. Los 26 eran del DÍA SIGUIENTE: 14
 * facturas y 12 remitos emitidos con fecha adelantada (se puede facturar hasta 7 días antes).
 *
 * Traerlos en el listado sale gratis, medido el mismo día:
 *
 *     sólo hoy    1.873 filas  1.010 ms
 *     hasta +7 d  1.979 filas    653 ms
 *
 * 106 filas más y ni un milisegundo de más, contra 7,8 segundos de consultas sueltas.
 */
describe('hasta dónde mirar para encontrar los comprobantes adelantados', () => {
  it('🔑 estira el final del rango tantos días como se permita facturar por adelantado', () => {
    expect(hastaConAdelanto('2026-09-21', 7)).toBe('2026-09-28');
  });

  it('cruza el fin de mes sin romperse', () => {
    expect(hastaConAdelanto('2026-09-28', 7)).toBe('2026-10-05');
    expect(hastaConAdelanto('2026-12-30', 7)).toBe('2027-01-06');
  });

  it('🪤 sin adelanto permitido devuelve el mismo día: no se pide un rango de más porque sí', () => {
    expect(hastaConAdelanto('2026-09-21', 0)).toBe('2026-09-21');
  });

  it('🪤 una fecha ilegible se devuelve tal cual: mejor el rango de siempre que uno inventado', () => {
    expect(hastaConAdelanto('', 7)).toBe('');
    expect(hastaConAdelanto('mañana', 7)).toBe('mañana');
  });

  it('🔴 no se estira más allá del tope: el rango largo deja de cachearse y sale carísimo', () => {
    // `/ventas` cachea hasta 10 días; más que eso son lecturas completas cada vez.
    expect(hastaConAdelanto('2026-09-21', 90)).toBe('2026-10-21');
  });
});

describe('el recorte para la vista', () => {
  const v = (id: number, fecha: string) => ({ id, fecha });
  it('🔑 deja fuera lo que se emitió con fecha adelantada', () => {
    const todo = [v(1, '2026-09-21'), v(2, '2026-09-22'), v(3, '2026-09-28')];
    expect(recortarHasta(todo, '2026-09-21').map(x => x.id)).toEqual([1]);
  });

  it('🪤 una fecha con hora se compara igual: IM las manda de las dos formas', () => {
    expect(recortarHasta([{ id: 1, fecha: '2026-09-21T14:03:00' }], '2026-09-21')).toHaveLength(1);
  });

  it('🔴 una fila SIN fecha legible entra igual: esconder un pedido es peor que mostrarlo de más', () => {
    // Sin fecha no se sabe si es de hoy o de mañana. Dejarla afuera la borra de la pantalla y
    // nadie la factura; dejarla adentro, en el peor caso, muestra un pedido de más y se ve.
    expect(recortarHasta([{ id: 1, fecha: null }, { id: 2 }], '2026-09-21')).toHaveLength(2);
  });

  it('🪤 con un `hasta` ilegible devuelve todo: mejor de más que una pantalla vacía', () => {
    expect(recortarHasta([{ id: 1, fecha: '2026-09-21' }], '')).toHaveLength(1);
  });
});
