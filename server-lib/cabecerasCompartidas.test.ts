import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });
vi.mock('./infomanager.js', () => ({ cabeceraComprobante: vi.fn() }));
import { cabecerasCompartidas } from './cabecerasCompartidas.js';

const cab = (extra: any = {}) => ({ existe: true, anulada: false, total: 100, ...extra });

describe('cabecerasCompartidas', () => {
  it('🔑 dos consumidores del mismo id son UN solo GET', async () => {
    const leer = vi.fn(async () => cab() as any);
    const leerCabecera = cabecerasCompartidas(leer);
    const [a, b] = await Promise.all([leerCabecera('20'), leerCabecera('20')]);
    expect(leer).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('ids distintos son lecturas distintas', async () => {
    const leer = vi.fn(async (id: string) => cab({ id }) as any);
    const leerCabecera = cabecerasCompartidas(leer);
    await Promise.all([leerCabecera('20'), leerCabecera('21')]);
    expect(leer).toHaveBeenCalledTimes(2);
  });

  it('también comparte cuando el segundo llega después de resuelto el primero', async () => {
    const leer = vi.fn(async () => cab() as any);
    const leerCabecera = cabecerasCompartidas(leer);
    await leerCabecera('20');
    await leerCabecera('20');
    expect(leer).toHaveBeenCalledTimes(1);
  });

  // 🔴 El error tiene que llegarles a los dos, no quedar en uno solo ni perderse.
  it('🔑 el rechazo se propaga a todos los que esperan, y no se repite el GET', async () => {
    const leer = vi.fn(async () => { throw new Error('IM sin respuesta'); });
    const leerCabecera = cabecerasCompartidas(leer as any);
    await expect(leerCabecera('20')).rejects.toThrow('IM sin respuesta');
    await expect(leerCabecera('20')).rejects.toThrow('IM sin respuesta');
    expect(leer).toHaveBeenCalledTimes(1);
  });

  it('🪤 `existe: null` viaja tal cual: "no sé" no es "no existe"', async () => {
    const leer = vi.fn(async () => ({ existe: null, anulada: null } as any));
    const r = await cabecerasCompartidas(leer)('20');
    expect(r.existe).toBeNull();
    expect(r.anulada).toBeNull();
  });

  it('un id numérico y su string son la misma lectura', async () => {
    const leer = vi.fn(async () => cab() as any);
    const leerCabecera = cabecerasCompartidas(leer);
    await Promise.all([leerCabecera('20'), leerCabecera(20 as any)]);
    expect(leer).toHaveBeenCalledTimes(1);
  });
});
