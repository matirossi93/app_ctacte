import { describe, it, expect } from 'vitest';
import { computeVentaNeta, tipoComprobante, isAnulada, monthKey } from './ventas';

describe('computeVentaNeta', () => {
  it('FA suma positivo', () => {
    expect(computeVentaNeta({ tipo: 'FA', fa_total: 100000 })).toBe(100000);
  });

  it('NC resta (viene positivo, se niega)', () => {
    expect(computeVentaNeta({ tipo: 'NC', fa_total: 25000 })).toBe(-25000);
  });

  it('ND se excluye del avance (intereses por mora, no venta)', () => {
    expect(computeVentaNeta({ tipo: 'ND', fa_total: 5000 })).toBe(0);
  });

  it('RC / RE / otros NO suman al neto de ventas', () => {
    expect(computeVentaNeta({ tipo: 'RC', fa_total: 50000 })).toBe(0);
    expect(computeVentaNeta({ tipo: 'RE', fa_total: 50000 })).toBe(0);
    expect(computeVentaNeta({ tipo: 'PR', fa_total: 50000 })).toBe(0);
  });

  it('FA anulada = 0', () => {
    expect(computeVentaNeta({ tipo: 'FA', fa_total: 100000, anulada: 'S' })).toBe(0);
  });

  it('acepta campo total como alias de fa_total', () => {
    expect(computeVentaNeta({ tipo: 'FA', total: 42000 })).toBe(42000);
  });

  it('acepta tipo_comprobante como alias de tipo', () => {
    expect(computeVentaNeta({ tipo_comprobante: 'NC', fa_total: 10000 })).toBe(-10000);
  });

  it('tolera strings con formato argentino (miles con punto)', () => {
    expect(computeVentaNeta({ tipo: 'FA', fa_total: '1.234.567' as any })).toBe(1234567);
  });

  it('null / undefined / NaN → 0', () => {
    expect(computeVentaNeta({ tipo: 'FA', fa_total: null })).toBe(0);
    expect(computeVentaNeta({ tipo: 'FA', fa_total: undefined })).toBe(0);
    expect(computeVentaNeta({ tipo: 'FA', fa_total: 'abc' as any })).toBe(0);
  });
});

describe('helpers', () => {
  it('tipoComprobante normaliza a upper', () => {
    expect(tipoComprobante({ tipo: 'fa' })).toBe('FA');
    expect(tipoComprobante({ tipo_comprobante: 'nc' })).toBe('NC');
  });
  it('isAnulada detecta S', () => {
    expect(isAnulada({ anulada: 'S' })).toBe(true);
    expect(isAnulada({ anulada: 'N' })).toBe(false);
    expect(isAnulada({})).toBe(false);
  });
  it('monthKey parsea ISO', () => {
    expect(monthKey('2026-04-15')).toEqual({ year: 2026, month: 4 });
    expect(monthKey('2026-12-31T23:59:59Z')).toEqual({ year: 2026, month: 12 });
    expect(monthKey(undefined)).toBeNull();
    expect(monthKey('basura')).toBeNull();
  });
});
