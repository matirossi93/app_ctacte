import { describe, it, expect } from 'vitest';

/**
 * EL SALDO ANTERIOR QUE SALE IMPRESO EN LA HOJA DE RUTA.
 *
 * Mati (10/09/2026): *"los saldos de los clientes que tira en la hoja de ruta no son correctos"*.
 * Eran dos problemas encimados:
 *
 *  1. El número se congelaba al meter el pedido en la hoja. Medido contra IM con hojas del día
 *     anterior: MERCADO $732.783,68 guardado contra $1.223.064,96 real; AVILA $1.761.968,80
 *     contra $1.355.626,77.
 *  2. "Saldo anterior" es lo que el cliente debía ANTES de esta entrega, y la factura de este
 *     pedido YA está en su cuenta corriente al imprimir —la hoja se arma con remitos, que salen
 *     después de facturar—. Sin restarla, el repartidor suma dos veces lo que lleva en el camión.
 */

/** La misma cuenta que hace `impresionHoja`, aislada para poder probarla. */
function saldoAnterior(
  saldoIM: number,
  comprobantes: Array<{ total: number; facturado: boolean }>,
): number {
  const enLaHoja = comprobantes.filter(c => c.facturado).reduce((s, c) => s + c.total, 0);
  return Math.round((saldoIM - enLaHoja) * 100) / 100;
}

describe('saldo anterior de la hoja de ruta', () => {
  it('🔴 descuenta lo que se está entregando: ya está en la cuenta corriente', () => {
    // Debía 100.000, se le factura este pedido de 30.000 → IM dice 130.000.
    expect(saldoAnterior(130000, [{ total: 30000, facturado: true }])).toBe(100000);
  });

  it('🔴 con DOS pedidos en la misma hoja descuenta los dos', () => {
    expect(saldoAnterior(130000, [
      { total: 30000, facturado: true },
      { total: 20000, facturado: true },
    ])).toBe(80000);
  });

  /** Un remito sin factura todavía no tocó la cuenta corriente: no hay nada que restar. */
  it('🔴 lo NO facturado no se descuenta', () => {
    expect(saldoAnterior(100000, [{ total: 30000, facturado: false }])).toBe(100000);
  });

  it('un cliente al día queda en cero, no en negativo', () => {
    expect(saldoAnterior(30000, [{ total: 30000, facturado: true }])).toBe(0);
  });

  it('un cliente con saldo a favor sigue a favor', () => {
    expect(saldoAnterior(-4504.71, [])).toBe(-4504.71);
  });

  it('redondea a centavos: IM devuelve cuatro decimales', () => {
    expect(saldoAnterior(115107.801, [])).toBe(115107.8);
    expect(saldoAnterior(1.3233, [])).toBe(1.32);
  });
});
