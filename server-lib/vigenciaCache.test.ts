import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });
const { comprobantesVigentes, invalidarVigenciaComprobantes } = await import('./infomanager.js');

/**
 * 🔑 POR QUÉ SE PUEDE CACHEAR ESTA RESPUESTA.
 *
 * El tablero resuelve la vigencia de casi todos los comprobantes con el listado del rango, que
 * YA viene de un cache de 90 s. Los pocos que caen afuera se preguntan de a uno y eso costaba
 * 4 s en cada carga (10 de 68, medido el 16/09/2026): la app gastaba segundos en tener un dato
 * MÁS fresco para esos pocos que el que tiene para los otros 58.
 *
 * 🪤 Un "no se sabe" NO se cachea: es "no pude preguntar", y guardarlo sería convertir una falla
 * de red en una respuesta durante un minuto y medio.
 */
const RANGO = { desde: '2026-09-16', hasta: '2026-09-16', ventas: [{ id: '1', anulada: 'N' as const }] };

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-16T12:00:00Z')); invalidarVigenciaComprobantes(); });
afterEach(() => vi.useRealTimers());

describe('vigencia de los comprobantes que no están en el listado', () => {
  it('🔑 no se vuelve a preguntar dentro de la misma ventana que el listado', async () => {
    const leer = vi.fn(async () => ({ existe: true, anulada: false } as any));
    expect((await comprobantesVigentes(['99'], RANGO, leer)).get('99')).toBe(true);
    expect((await comprobantesVigentes(['99'], RANGO, leer)).get('99')).toBe(true);
    expect(leer).toHaveBeenCalledTimes(1);
  });

  it('🔑 pero sí cuando la ventana venció', async () => {
    const leer = vi.fn(async () => ({ existe: true, anulada: false } as any));
    await comprobantesVigentes(['99'], RANGO, leer);
    vi.setSystemTime(new Date('2026-09-16T12:02:00Z'));
    await comprobantesVigentes(['99'], RANGO, leer);
    expect(leer).toHaveBeenCalledTimes(2);
  });

  it('🔴 y siempre que se pida actualizar: Actualizar tiene que ver lo de IM, no lo guardado', async () => {
    const leer = vi.fn(async () => ({ existe: true, anulada: false } as any));
    await comprobantesVigentes(['99'], RANGO, leer);
    await comprobantesVigentes(['99'], { ...RANGO, actualizar: true }, leer);
    expect(leer).toHaveBeenCalledTimes(2);
  });

  it('🔴 un "no se sabe" NO se guarda: es "no pude preguntar", no una respuesta', async () => {
    const leer = vi.fn(async () => ({ existe: null, anulada: null } as any));
    expect((await comprobantesVigentes(['99'], RANGO, leer)).get('99')).toBeNull();
    expect((await comprobantesVigentes(['99'], RANGO, leer)).get('99')).toBeNull();
    expect(leer).toHaveBeenCalledTimes(2);
  });

  it('🔑 el anulado sí se guarda: esa respuesta ya no cambia', async () => {
    const leer = vi.fn(async () => ({ existe: false, anulada: null } as any));
    expect((await comprobantesVigentes(['99'], RANGO, leer)).get('99')).toBe(false);
    expect((await comprobantesVigentes(['99'], RANGO, leer)).get('99')).toBe(false);
    expect(leer).toHaveBeenCalledTimes(1);
  });

  it('🔴 lo que sale del listado del rango manda sobre lo guardado', async () => {
    const leer = vi.fn(async () => ({ existe: true, anulada: false } as any));
    await comprobantesVigentes(['1'], RANGO, leer);
    // El id 1 está en el listado como vigente: nunca se pregunta de a uno.
    expect(leer).not.toHaveBeenCalled();
  });
});
