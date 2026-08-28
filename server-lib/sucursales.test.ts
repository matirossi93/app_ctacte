import { describe, it, expect } from 'vitest';
import { SUCURSALES, sucursalDe, esEmpresaValida, CASA_CENTRAL } from './sucursales.js';

/**
 * Los códigos de cada unidad. Son datos, no lógica, pero se testean porque un número mal puesto
 * acá crea el presupuesto en la empresa equivocada y nadie se entera hasta que lo factura otro.
 * Todos verificados contra IM el 28/08/2026.
 */

describe('sucursales', () => {
  it('🪤 la empresa y el depósito NO son el mismo número', () => {
    // El caso que rompía: Jujuy es empresa 4 y depósito 6. En el código había una lista blanca
    // {1,2,3,6} que era la de DEPÓSITOS: dejaba pasar una empresa 6 inexistente y rechazaba la 4.
    expect(SUCURSALES[4].cod_deposito).toBe(6);
    expect(esEmpresaValida(6)).toBe(false);
    expect(esEmpresaValida(4)).toBe(true);
  });

  it('cada unidad tiene su depósito', () => {
    expect(Object.values(SUCURSALES).map(s => [s.cod_empresa, s.cod_deposito]))
      .toEqual([[1, 1], [2, 2], [3, 3], [4, 6]]);
  });

  it('🔑 el punto de venta de cada unidad puede emitir presupuestos', () => {
    // Verificado contra /puntos-de-venta: sólo los pv con el tipo de comprobante 10 pueden.
    // El 1414 de BRS y el 8 de SJ NO lo tienen, y el pv 14 de Jujuy tampoco.
    expect(SUCURSALES[1].punto_de_venta).toBe(1);     // el que ya usa casa central
    expect(SUCURSALES[2].punto_de_venta).toBe(14);
    expect(SUCURSALES[3].punto_de_venta).toBe(14);
    expect(SUCURSALES[4].punto_de_venta).toBe(888);   // único posible en Jujuy
  });

  it('un usuario sin unidad cargada sigue siendo casa central', () => {
    // Los usuarios que ya existen tienen cod_empresa NULL: tienen que andar igual que antes.
    for (const v of [null, undefined, 0, '', 'brs', 99, NaN]) {
      expect(sucursalDe(v).cod_empresa).toBe(CASA_CENTRAL);
    }
  });

  it('acepta el código como número o como string (viene de la base y del body)', () => {
    expect(sucursalDe(2).nombre).toBe('BRS');
    expect(sucursalDe('3').nombre).toBe('San Juan');
  });
});
