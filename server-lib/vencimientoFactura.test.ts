import { describe, expect, it } from 'vitest';
import { diasDeCuentaCorriente, vencimientoDeFactura } from './vencimientoFactura.js';

/**
 * 🔴 Esto se IMPRIME en la factura que ve el cliente. Una fecha equivocada es peor que ninguna:
 * o le reclamamos antes de tiempo, o le damos plazo de más.
 */
describe('los días pactados', () => {
  it('🔑 salen de la columna VISITA, y sólo en cuenta corriente', () => {
    expect(diasDeCuentaCorriente({ visita: '15', cond_pago: 'cc' })).toBe(15);
    expect(diasDeCuentaCorriente({ visita: '7', cond_pago: 'cc' })).toBe(7);
    expect(diasDeCuentaCorriente({ visita: 15, cond_pago: 'CC' })).toBe(15);
  });

  it('🔴 un cliente de contado no tiene vencimiento', () => {
    for (const cond of ['CONTADO', 'Efectivo', '', null, undefined]) {
      expect(diasDeCuentaCorriente({ visita: '15', cond_pago: cond }), String(cond)).toBeNull();
    }
  });

  /** 🪤 Medido en la base: 64 clientes en cuenta corriente no tienen plazo cargado. */
  it('🔴 en cuenta corriente sin plazo cargado, tampoco', () => {
    for (const v of ['', null, undefined, '  ']) {
      expect(diasDeCuentaCorriente({ visita: v, cond_pago: 'cc' }), String(v)).toBeNull();
    }
  });

  /**
   * 🪤 "Frecuencia" es otra columna del mismo maestro y también tiene números; el script de
   * cobranzas avisa de no confundirlas. Por eso sólo se aceptan 7 y 15: cualquier otro valor
   * es una columna equivocada o un dato que no se entiende.
   */
  it('🔴 un número que no es 7 ni 15 no es un plazo', () => {
    for (const v of ['30', '1', '0', '21', 'quincenal', '7 dias', true, ['15']]) {
      expect(diasDeCuentaCorriente({ visita: v, cond_pago: 'cc' }), JSON.stringify(v)).toBeNull();
    }
  });
});

describe('la fecha de vencimiento', () => {
  it('🔑 son días calendario sobre la fecha del comprobante', () => {
    expect(vencimientoDeFactura('2026-09-16', { visita: '15', cond_pago: 'cc' })).toEqual({ fecha: '2026-10-01', dias: 15 });
    expect(vencimientoDeFactura('2026-09-16', { visita: '7', cond_pago: 'cc' })).toEqual({ fecha: '2026-09-23', dias: 7 });
  });

  it('cruza fin de mes y año sin corrimientos', () => {
    expect(vencimientoDeFactura('2026-12-28', { visita: '7', cond_pago: 'cc' })?.fecha).toBe('2027-01-04');
    expect(vencimientoDeFactura('2026-02-20', { visita: '15', cond_pago: 'cc' })?.fecha).toBe('2026-03-07');
  });

  it('🪤 una fecha con hora se recorta, no se rompe', () => {
    expect(vencimientoDeFactura('2026-09-16T10:30:00Z', { visita: '15', cond_pago: 'cc' })?.fecha).toBe('2026-10-01');
  });

  it('🔴 sin fecha legible no se imprime nada', () => {
    for (const f of [null, undefined, '', 'mañana', '16/09/2026', 123]) {
      expect(vencimientoDeFactura(f, { visita: '15', cond_pago: 'cc' }), JSON.stringify(f)).toBeNull();
    }
  });

  it('🔴 y sin plazo tampoco, aunque la fecha esté bien', () => {
    expect(vencimientoDeFactura('2026-09-16', { visita: '', cond_pago: 'cc' })).toBeNull();
    expect(vencimientoDeFactura('2026-09-16', null)).toBeNull();
  });
});
