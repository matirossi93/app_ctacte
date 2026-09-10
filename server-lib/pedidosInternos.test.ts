import { describe, it, expect } from 'vitest';
import { esPedidoInternoDeSucursal, VENDEDOR_SUCURSAL } from './pedidosInternos.js';

/**
 * LOS PEDIDOS INTERNOS ENTRE SUCURSALES.
 *
 * Mati (10/09/2026): *"deberíamos poder filtrar los pedidos internos de las sucursales, que hoy
 * nos están apareciendo en la aplicación también y no hay forma de sacarlos"*.
 *
 * No son ventas: son mercadería que Casa Central le manda a una sucursal. No llevan hoja de ruta
 * ni pasan por el circuito de facturación del panel, así que sólo ensucian la lista.
 *
 * 🔑 Se reconocen por el VENDEDOR. Medido contra IM el 10/09/2026, los tres del rango eran del
 * vendedor 7, cargados por el usuario `susana`, con observaciones *"Pedido P-0027 · Sucursal
 * Banda del Río Salí"*, y cada sucursal es un cliente distinto (652 San Juan, 861 Avenida Jujuy,
 * 666 Banda del Río Salí). Mati confirmó que **el vendedor 7 se usa sólo para esto**.
 */
describe('esPedidoInternoDeSucursal', () => {
  it('🔴 el vendedor de sucursales marca el pedido como interno', () => {
    expect(esPedidoInternoDeSucursal({ cod_vendedor: VENDEDOR_SUCURSAL })).toBe(true);
    expect(esPedidoInternoDeSucursal({ cod_vendedor: 7 })).toBe(true);
  });

  it('🔴 un pedido de un vendedor de verdad NO se esconde', () => {
    // Lo peor que puede hacer este filtro es tragarse una venta real.
    for (const v of [1, 2, 3, 12, 0, null, undefined]) {
      expect(esPedidoInternoDeSucursal({ cod_vendedor: v as any })).toBe(false);
    }
  });

  it('IM manda el vendedor como texto según el endpoint', () => {
    expect(esPedidoInternoDeSucursal({ cod_vendedor: '7' as any })).toBe(true);
    expect(esPedidoInternoDeSucursal({ cod_vendedor: '3' as any })).toBe(false);
  });

  /**
   * 🪤 NO alcanza con mirar las observaciones. Un vendedor puede escribir "sucursal" en un pedido
   * real —"dejar en la sucursal de Monteros"— y ese pedido desaparecería de la lista sin que
   * nadie sepa por qué.
   */
  it('🪤 la palabra "sucursal" en las observaciones no esconde nada por sí sola', () => {
    expect(esPedidoInternoDeSucursal({
      cod_vendedor: 3, observaciones: 'entregar en la sucursal de Monteros',
    })).toBe(false);
  });

  it('un pedido sin datos no explota ni se esconde', () => {
    expect(esPedidoInternoDeSucursal({})).toBe(false);
    expect(esPedidoInternoDeSucursal(null as any)).toBe(false);
  });
});
