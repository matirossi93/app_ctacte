import { describe, it, expect } from 'vitest';
import { resolveCodVendedor } from './comisionOverrides.js';

describe('resolveCodVendedor', () => {
  const overrides = new Map<number, number>([[57546720, 12]]);

  it('sin override devuelve el vendedor crudo', () => {
    expect(resolveCodVendedor(3, 999, overrides)).toBe(3);
  });

  it('con override gana el override (caso ADRIAN: FA 57546720 de 3 → 12)', () => {
    expect(resolveCodVendedor(3, 57546720, overrides)).toBe(12);
  });

  it('override gana incluso sobre mostrador (raw 0)', () => {
    const ov = new Map<number, number>([[123, 4]]);
    expect(resolveCodVendedor(0, 123, ov, { mostradorEsNull: true })).toBe(4);
  });

  it('mostrador (raw 0) con mostradorEsNull → null', () => {
    expect(resolveCodVendedor(0, 999, overrides, { mostradorEsNull: true })).toBeNull();
  });

  it('mostrador (raw 0) sin la flag → 0 (comportamiento de comisiones.ts)', () => {
    expect(resolveCodVendedor(0, 999, overrides)).toBe(0);
  });

  it('undefined / NaN sin override → null (Number(undefined)=NaN)', () => {
    expect(resolveCodVendedor(undefined, 999, overrides)).toBeNull();
    expect(resolveCodVendedor(NaN, 999, overrides)).toBeNull();
  });

  it('null sin flag → 0 (Number(null)=0, preserva comisiones.ts); con flag → null', () => {
    expect(resolveCodVendedor(null, 999, overrides)).toBe(0);
    expect(resolveCodVendedor(null, 999, overrides, { mostradorEsNull: true })).toBeNull();
  });

  it('raw no numérico con override → override', () => {
    expect(resolveCodVendedor(null, 57546720, overrides)).toBe(12);
  });

  it('map vacío es no-op', () => {
    expect(resolveCodVendedor(3, 57546720, new Map())).toBe(3);
  });
});
