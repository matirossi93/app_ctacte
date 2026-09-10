import { describe, it, expect } from 'vitest';
import { renglonesQueFaltan } from './remitoSigueALaFactura.js';

/**
 * 🔴 LO QUE SE MANDÓ A FACTURAR CONTRA LO QUE LA FACTURA REALMENTE DICE.
 *
 * Mati (10/09/2026): *"el presupuesto de Urueña Francisco lo editamos y sacamos un producto que
 * no había, pero en la parte de facturación sigue figurando el importe original y en la hoja de
 * ruta tampoco impacta"*.
 *
 * Medido contra IM ese día, el pedido de URUEÑA (cliente 430) tenía:
 *
 *   PR 58286  23 renglones  $1.111.521,00
 *   FA 50444  22 renglones  $1.073.534,08   ← le falta el artículo 1
 *   RE 77442  23 renglones  $1.111.521,00   ← lo lleva igual
 *
 * O sea que **InfoManager emitió la factura sin uno de los renglones que se le mandaron**, sin
 * decir nada, y el remito —que se armaba con los renglones del PRESUPUESTO— salió con 2 BEBE x 25
 * Kg de más: $37.986,92 de mercadería al cliente sin facturar.
 *
 * Que el remito salga de la factura evita la diferencia; esto además la hace visible.
 */
describe('renglonesQueFaltan', () => {
  const r = (cod: number, cantidad = 1) => ({ cod_articulo: cod, cantidad });

  it('🔴 el caso de URUEÑA: avisa del artículo que la factura se comió', () => {
    const mandados = [r(1, 2), r(725, 10), r(458, 20)];
    const enLaFactura = [r(725, 10), r(458, 20)];
    expect(renglonesQueFaltan(mandados, enLaFactura)).toEqual([1]);
  });

  it('cuando la factura dice lo mismo, no hay nada que avisar', () => {
    const rs = [r(1, 2), r(725, 10)];
    expect(renglonesQueFaltan(rs, [...rs])).toEqual([]);
    // Y no importa el orden en que IM los devuelva.
    expect(renglonesQueFaltan(rs, [r(725, 10), r(1, 2)])).toEqual([]);
  });

  /** 🪤 También cuenta como faltante si el renglón quedó con MENOS cantidad de la mandada. */
  it('🪤 una cantidad recortada también se avisa', () => {
    expect(renglonesQueFaltan([r(1, 10)], [r(1, 4)])).toEqual([1]);
  });

  it('una cantidad de MÁS no es un faltante, pero tampoco pasa desapercibida', () => {
    // Que IM agregue no es el problema que esto vigila: el remito sale de la factura igual.
    expect(renglonesQueFaltan([r(1, 2)], [r(1, 5)])).toEqual([]);
  });

  it('🪤 varios faltantes salen ordenados, para que el mensaje sea siempre igual', () => {
    expect(renglonesQueFaltan([r(30), r(10), r(20)], [r(20)])).toEqual([10, 30]);
  });

  /** 🪤 Si no se pudieron leer los renglones de la factura, NO se inventa que faltan todos. */
  it('🪤 sin datos de la factura no se afirma nada', () => {
    expect(renglonesQueFaltan([r(1), r(2)], null)).toEqual([]);
    expect(renglonesQueFaltan([r(1), r(2)], [])).toEqual([]);
  });

  it('los decimales de las cantidades no generan falsos avisos', () => {
    expect(renglonesQueFaltan([r(528, 0.045)], [r(528, 0.045)])).toEqual([]);
  });
});
