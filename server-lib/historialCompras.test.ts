import { describe, it, expect } from 'vitest';
import { esLineaTecnica } from './historialCompras.js';

describe('esLineaTecnica', () => {
  it('matchea flete (case insensitive)', () => {
    expect(esLineaTecnica('FLETE EMPRESA TRANSPORTE')).toBe(true);
    expect(esLineaTecnica('Flete CABA')).toBe(true);
    expect(esLineaTecnica('flete')).toBe(true);
  });

  it('matchea descuento, bonif, ajuste, redondeo, percepcion', () => {
    expect(esLineaTecnica('DESCUENTO COMERCIAL')).toBe(true);
    expect(esLineaTecnica('BONIF VOLUMEN')).toBe(true);
    expect(esLineaTecnica('AJUSTE PRECIO')).toBe(true);
    expect(esLineaTecnica('REDONDEO')).toBe(true);
    expect(esLineaTecnica('PERCEPCION IIBB')).toBe(true);
  });

  it('NO matchea productos reales', () => {
    expect(esLineaTecnica('MIX ENERGETICO 25KG')).toBe(false);
    expect(esLineaTecnica('TIERNITOS 25KG')).toBe(false);
    expect(esLineaTecnica('GRAN CAMPEON CARNE 21KG')).toBe(false);
  });

  it('strings vacíos / null tratados como NO técnicos (no descartar línea por dato faltante)', () => {
    expect(esLineaTecnica('')).toBe(false);
    expect(esLineaTecnica(null as any)).toBe(false);
    expect(esLineaTecnica(undefined as any)).toBe(false);
  });
});
