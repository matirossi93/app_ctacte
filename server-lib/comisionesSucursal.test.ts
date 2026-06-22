import { describe, it, expect } from 'vitest';
import {
  excluirClientesDe,
  EXCLUIR_CLIENTES_COMISION_SUCURSAL,
  COD_EMPRESA_SAN_MARTIN,
  NOMBRE_EMPRESA,
} from './comisionesShared.js';

/**
 * Estos tests blindan la DECISIÓN DE NEGOCIO de excluir al cliente 17 (BRUNO,
 * Mayra) de la comisión de San Martín de mayo 2026: si alguien edita la config
 * por error, el cálculo de comisiones de sucursal cambiaría y se pagaría de más.
 */
describe('comisiones sucursal — exclusión de clientes por negocio', () => {
  it('excluye al cliente 17 SOLO en mayo 2026', () => {
    expect(excluirClientesDe('2026-05').has(17)).toBe(true);
  });

  it('NO excluye a nadie en abril 2026 (Bruno no compró en SM)', () => {
    expect(excluirClientesDe('2026-04').size).toBe(0);
  });

  it('un periodo sin reglas devuelve un set vacío (no rompe)', () => {
    expect(excluirClientesDe('2026-09').size).toBe(0);
    expect(excluirClientesDe('').size).toBe(0);
  });

  it('cada llamada devuelve un set NUEVO (mutarlo no contamina la config)', () => {
    const a = excluirClientesDe('2026-05');
    a.add(999);
    expect(excluirClientesDe('2026-05').has(999)).toBe(false);
    // La config original sigue intacta.
    expect(EXCLUIR_CLIENTES_COMISION_SUCURSAL['2026-05']).toEqual([17]);
  });

  it('San Martín es la empresa 2 y tiene nombre legible', () => {
    expect(COD_EMPRESA_SAN_MARTIN).toBe(2);
    expect(NOMBRE_EMPRESA[2]).toMatch(/San Martín/);
  });
});
