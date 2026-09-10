import { describe, it, expect } from 'vitest';
import { totalDeRenglones } from './totalFacturado.js';

/**
 * EL IMPORTE QUE SE MUESTRA DESPUÉS DE FACTURAR.
 *
 * Mati (10/09/2026): *"el presupuesto de Urueña lo editamos y sacamos un producto que no había,
 * pero en la parte de facturación sigue figurando el importe original y en la hoja de ruta
 * tampoco impacta"*.
 *
 * El panel mostraba el total del PRESUPUESTO aunque la factura hubiera salido por otra cosa. En
 * URUEÑA el presupuesto decía $1.111.521,00 y la factura $1.073.534,08: el repartidor iba a
 * cobrar por el papel equivocado.
 *
 * Una vez emitida, la factura es la verdad: es el comprobante fiscal y lo que el cliente paga.
 */
describe('totalDeRenglones', () => {
  it('🔴 el caso de URUEÑA: los renglones que quedaron dan el total de la factura', () => {
    // 22 renglones sin el BEBE, resumidos en los tres que mueven la diferencia.
    expect(totalDeRenglones([
      { cantidad: 10, precio: 1170.45 },
      { cantidad: 20, precio: 1872 },
      { cantidad: 5, precio: 3580.08 },
    ])).toBeCloseTo(11704.5 + 37440 + 17900.4, 2);
  });

  it('🔴 aplica el descuento del renglón: es lo que la factura cobra de verdad', () => {
    expect(totalDeRenglones([{ cantidad: 4, precio: 22473.6745, descuento_porc: 35 }]))
      .toBeCloseTo(4 * 14607.888425, 2);
  });

  it('redondea a centavos, como el total de la cabecera en IM', () => {
    expect(totalDeRenglones([{ cantidad: 3, precio: 1000.00004 }])).toBe(3000);
  });

  it('🪤 sin renglones devuelve null, no 0: un cero diría "esta factura no vale nada"', () => {
    expect(totalDeRenglones([])).toBeNull();
    expect(totalDeRenglones(null)).toBeNull();
  });

  it('las cantidades fraccionarias del granel no se redondean', () => {
    expect(totalDeRenglones([{ cantidad: 0.045, precio: 19008 }])).toBeCloseTo(855.36, 2);
  });
});
