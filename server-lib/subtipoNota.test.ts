import { describe, it, expect } from 'vitest';
import { subtipoDeCorreccion } from './subtipoNota.js';

/**
 * QUÉ SUBTIPO DE NOTA DE CRÉDITO CORRESPONDE. Mati (21/09/2026):
 *
 *   *"DE es hay que cambiar la cantidad o algún producto... financiera si es sólo por un tema de
 *   precios! dc es por dif en el tipo de cambio"*.
 *
 * InfoManager lo exige en la API v2 y no existía en la v1, así que no se puede deducir de lo ya
 * emitido. Pero tampoco hace falta preguntárselo a nadie: el propio cálculo de la corrección ya
 * distingue las dos causas —la cantidad y el precio— así que el subtipo sale del diff.
 *
 * 🪤 DC no se contempla: el circuito factura en pesos. Si algún día se vende en dólares, esto
 * tiene que volver a mirarse y NO alcanza con agregar un valor al tipo.
 */
const r = (cod: number, cantidad: number, precio: number, descuento_porc?: number) =>
  ({ cod_articulo: cod, cantidad, precio, ...(descuento_porc != null ? { descuento_porc } : {}) });

describe('el subtipo sale de qué cambió', () => {
  it('🔑 sólo el precio → FINANCIERA', () => {
    expect(subtipoDeCorreccion([r(320, 10, 1000)], [r(320, 10, 900)])).toBe('FI');
  });

  it('🔑 cambia la cantidad → DEVOLUCIÓN', () => {
    expect(subtipoDeCorreccion([r(320, 10, 1000)], [r(320, 7, 1000)])).toBe('DE');
  });

  it('🔑 se saca un producto entero → DEVOLUCIÓN', () => {
    expect(subtipoDeCorreccion([r(320, 10, 1000), r(400, 2, 500)], [r(320, 10, 1000)])).toBe('DE');
  });

  it('🔑 se agrega un producto que no estaba → DEVOLUCIÓN', () => {
    expect(subtipoDeCorreccion([r(320, 10, 1000)], [r(320, 10, 1000), r(400, 2, 500)])).toBe('DE');
  });

  it('🔴 cambian los dos → DEVOLUCIÓN: manda la mercadería, que es la que se mueve', () => {
    // Si saliera FI, InfoManager no esperaría movimiento de stock y la nota quedaría mintiendo
    // sobre lo que pasó con los 3 bultos que volvieron.
    expect(subtipoDeCorreccion([r(320, 10, 1000)], [r(320, 7, 900)])).toBe('DE');
  });

  it('🔑 sólo el descuento es un tema de precio → FINANCIERA', () => {
    expect(subtipoDeCorreccion([r(320, 10, 1000, 0)], [r(320, 10, 1000, 15)])).toBe('FI');
  });

  it('🪤 el mismo artículo en dos renglones se suma antes de comparar', () => {
    // 6 + 4 = 10 es la MISMA cantidad que el renglón único de 10: no hay devolución.
    expect(subtipoDeCorreccion([r(320, 10, 1000)], [r(320, 6, 900), r(320, 4, 900)])).toBe('FI');
  });

  it('🔑 si no cambió nada, no hay nota que emitir', () => {
    expect(subtipoDeCorreccion([r(320, 10, 1000)], [r(320, 10, 1000)])).toBeNull();
  });

  it('🪤 una diferencia de centavos en la cantidad cuenta como cantidad, no se redondea a cero', () => {
    // Los graneles se facturan con decimales: 10,5 kg a 10 kg ES una devolución de medio kilo.
    expect(subtipoDeCorreccion([r(320, 10.5, 1000)], [r(320, 10, 1000)])).toBe('DE');
  });
});
