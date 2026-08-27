import { describe, it, expect, vi, afterEach } from 'vitest';
import { fechaArgentina, horaArgentina } from './infomanager.js';

// infomanager.ts corta el proceso al importarse si falta INFOMANAGER_CLIENT_SECRET.
// vi.hoisted corre ANTES de los imports estáticos (mismo patrón que precioLista.test.ts).
vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });

afterEach(() => { vi.useRealTimers(); });

/**
 * El bug: los presupuestos se creaban con `new Date().toISOString()`, o sea UTC. Un pedido
 * cargado a las 21:30 de Tucumán entraba a IM con la fecha del día SIGUIENTE, y el
 * usuario_hora salía 3 horas adelantado. Ventana de 3 h todos los días.
 */
describe('fechaArgentina — la franja de 21:00 a 23:59 es la que rompía', () => {
  it('21:30 de Tucumán sigue siendo el mismo día (en UTC ya era mañana)', () => {
    // 2026-08-28T00:30:00Z = 27/08 21:30 en Tucumán.
    expect(fechaArgentina('2026-08-28T00:30:00.000Z')).toBe('2026-08-27');
  });

  it('un pedido del mediodía no cambia de día', () => {
    expect(fechaArgentina('2026-08-27T15:00:00.000Z')).toBe('2026-08-27');
  });

  it('00:30 de Tucumán ya es el día nuevo', () => {
    // 2026-08-27T03:30:00Z = 27/08 00:30 en Tucumán.
    expect(fechaArgentina('2026-08-27T03:30:00.000Z')).toBe('2026-08-27');
  });

  it('sin argumento usa el reloj de ahora', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T01:15:00.000Z'));
    expect(fechaArgentina()).toBe('2026-08-27');
  });

  it('acepta un Date y un timestamp, no sólo el string de Supabase', () => {
    const d = new Date('2026-08-28T00:30:00.000Z');
    expect(fechaArgentina(d)).toBe('2026-08-27');
    expect(fechaArgentina(d.getTime())).toBe('2026-08-27');
  });
});

describe('horaArgentina', () => {
  it('devuelve la hora local, no la UTC', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T00:30:00.000Z'));
    expect(horaArgentina()).toBe('21:30:00');
  });
});
