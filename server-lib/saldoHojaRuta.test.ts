import { describe, it, expect } from 'vitest';
import { saldoAnteriorDeLaHoja, ajusteDeNotas, type ComprobantePendiente } from './saldoCliente.js';

/**
 * EL SALDO ANTERIOR Y LAS NOTAS EN LA HOJA DE RUTA.
 *
 * Mati (10/09/2026): *"siguen mal los saldos de las facturas adeudadas anteriores: tiene que ir
 * únicamente el saldo anterior a la factura que está yendo en esa hoja de ruta"* y *"si se le
 * hizo la NC a Baca Pablo tiene que impactar en la hoja de ruta, si no al enviar le sigue
 * apareciendo el importe original sin descontar la NC"*.
 *
 * 🔴 Acá se decide cuánta plata le reclama el repartidor a un cliente en la puerta. Un número de
 * más es una discusión, y un número de menos es plata que no se cobra.
 */

const p = (id: string, saldo: number, tipo = 'FA'): ComprobantePendiente =>
  ({ id, saldo, tipo_comprobante: tipo, numero: null, punto_de_venta: null, fecha: null });

describe('saldoAnteriorDeLaHoja', () => {
  /**
   * 🔴 EL CASO REAL DE BUSTOS, RAFAEL (10/09/2026). Sus tres comprobantes impagos suman
   * $2.788.891,38 y coinciden al centavo con `/reportes/saldos_clientes`. La factura 50408 es la
   * que va en la hoja, así que la deuda ANTERIOR es lo otro.
   */
  it('🔴 saca del saldo la factura que va en el camión', () => {
    const pendientes = [
      p('58613614', 1560303.87154),   // FA 49913, vieja
      p('58714129', 0.0028),          // FA 50237, un resto de redondeo
      p('58784786', 1228587.51),      // FA 50408 ← la de esta hoja
    ];
    expect(saldoAnteriorDeLaHoja(pendientes, ['58784786'])).toBeCloseTo(1560303.87, 2);
    // Sin excluir nada es la deuda total, que es lo que cierra contra saldos_clientes.
    expect(saldoAnteriorDeLaHoja(pendientes, [])).toBeCloseTo(2788891.38, 2);
  });

  /**
   * 🔴 EL CASO REAL DE BACA, PABLO (10/09/2026). Le hicieron una NC de $47.436 contra la factura
   * 50451, que es la que va en la hoja. Las dos son de esta entrega: la deuda anterior es CERO.
   */
  it('🔴 la nota de crédito de esta misma entrega tampoco es deuda anterior', () => {
    const pendientes = [p('58798879', -47436, 'NC')];
    expect(saldoAnteriorDeLaHoja(pendientes, ['58796392', '58798879'])).toBe(0);
  });

  /** 🪤 Pero una NC de un pedido ANTERIOR sí baja lo que debe: ya viene en negativo de IM. */
  it('🪤 una nota de crédito vieja baja el saldo anterior', () => {
    expect(saldoAnteriorDeLaHoja([p('1', 100000), p('2', -30000, 'NC')], [])).toBe(70000);
  });

  it('🔴 con dos pedidos del mismo cliente en la hoja saca los dos', () => {
    const pendientes = [p('viejo', 80000), p('a', 30000), p('b', 20000)];
    expect(saldoAnteriorDeLaHoja(pendientes, ['a', 'b'])).toBe(80000);
  });

  it('el cliente al día va en cero, no en blanco', () => {
    expect(saldoAnteriorDeLaHoja([], [])).toBe(0);
    expect(saldoAnteriorDeLaHoja([p('a', 50000)], ['a'])).toBe(0);
  });

  it('un cliente con saldo a favor queda en negativo, no en cero', () => {
    expect(saldoAnteriorDeLaHoja([p('x', -12500.75, 'NC')], [])).toBe(-12500.75);
  });

  it('los ids se comparan como texto: IM los manda como número y como string', () => {
    expect(saldoAnteriorDeLaHoja([{ ...p('58784786', 1000), id: 58784786 as any }], [58784786 as any])).toBe(0);
  });

  it('redondea a centavos: los restos de IM tienen cuatro decimales', () => {
    expect(saldoAnteriorDeLaHoja([p('a', 0.0028), p('b', 1560303.87154)], [])).toBe(1560303.87);
  });
});

describe('ajusteDeNotas — lo que la NC le saca al total del camión', () => {
  it('🔴 la NC de Baca baja el total de la entrega', () => {
    // La factura era de $463.625,92 y la NC de $47.436: el repartidor cobra $416.189,92.
    const ajuste = ajusteDeNotas([{ tipo: 'NC B', total: 47436 }]);
    expect(ajuste).toBe(-47436);
    expect(463625.92 + ajuste).toBeCloseTo(416189.92, 2);
  });

  it('una nota de débito SUBE el total', () => {
    expect(ajusteDeNotas([{ tipo: 'ND B', total: 12000 }])).toBe(12000);
  });

  it('varias notas sobre la misma entrega se suman', () => {
    expect(ajusteDeNotas([
      { tipo: 'NC B', total: 10000 },
      { tipo: 'ND B', total: 2500 },
      { tipo: 'NC A', total: 500 },
    ])).toBe(-8000);
  });

  /** 🪤 El total viene siempre positivo de la tabla; el signo lo pone el tipo. */
  it('🪤 un total cargado en negativo no invierte el signo de la NC', () => {
    expect(ajusteDeNotas([{ tipo: 'NC B', total: -47436 }])).toBe(-47436);
  });

  it('sin notas no cambia nada', () => {
    expect(ajusteDeNotas([])).toBe(0);
  });
});
