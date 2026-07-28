import { describe, it, expect } from 'vitest';
import { parseMontoUpload } from './recibosShared.js';

/**
 * Bug auditoría 22-jul: el server re-parseaba como formato AR lo que el front
 * (cleanMonto de RecibosApp) ya había normalizado a punto decimal:
 * '1.500,50' → front manda '1500.50' → server borraba el punto → 150050 (×100).
 * El parser debe bancar AMBOS formatos sin romper ninguno.
 */
describe('parseMontoUpload', () => {
  it('formato canónico del front (punto decimal) NO se multiplica ×100', () => {
    expect(parseMontoUpload('1500.50')).toBe(1500.5);
    expect(parseMontoUpload('999.99')).toBe(999.99);
    expect(parseMontoUpload('1.5')).toBe(1.5);
  });

  it('formato argentino crudo (por si algo saltea el cleanMonto del front)', () => {
    expect(parseMontoUpload('1.500,50')).toBe(1500.5);
    expect(parseMontoUpload('1500,50')).toBe(1500.5);
    expect(parseMontoUpload('1.500.000')).toBe(1500000);
  });

  it('punto como separador de miles (el front deja pasar "15.000" crudo)', () => {
    expect(parseMontoUpload('15.000')).toBe(15000);
    expect(parseMontoUpload('1.500')).toBe(1500);
  });

  it('caso front-mangled: "1.500.000" tipeado queda "1.500000" tras cleanMonto', () => {
    // cleanMonto colapsa múltiples puntos a uno ('1' + '.' + '500000').
    // Más de 2 decimales no existe en ARS → son miles.
    expect(parseMontoUpload('1.500000')).toBe(1500000);
  });

  it('enteros y basura', () => {
    expect(parseMontoUpload('1500')).toBe(1500);
    expect(parseMontoUpload('$ 1.500,50')).toBe(1500.5); // por si llega con símbolo
    expect(parseMontoUpload('')).toBeNull();
    expect(parseMontoUpload(undefined)).toBeNull();
    expect(parseMontoUpload(null)).toBeNull();
    expect(parseMontoUpload('abc')).toBeNull();
  });
});
