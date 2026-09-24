import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { imClient, imGetRetry, imToken, invalidateImToken } from './infomanager.js';

// infomanager.ts corta el proceso (process.exit(1)) al importarse si falta
// INFOMANAGER_CLIENT_SECRET. vi.hoisted corre ANTES de los imports estáticos,
// así el módulo carga con una credencial dummy.
vi.hoisted(() => {
  process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret';
});

// Mock completo de axios: controla el login (axios.post) y la creación de
// instancias (axios.create) sin tocar la red.
vi.mock('axios', () => ({
  default: {
    post: vi.fn(),
    create: vi.fn(),
  },
}));

/** Error estilo axios: con response.status (HTTP) o con code (error de red). */
function httpError(status?: number, code?: string): Error {
  const err: any = new Error(`HTTP ${status ?? code}`);
  if (status !== undefined) err.response = { status };
  if (code !== undefined) err.code = code;
  return err;
}

/** El 500 con el que IM avisa que un comprobante fue borrado (verificado el 10/09/2026). */
function sinDatos(id: number): Error {
  const err: any = new Error('HTTP 500');
  err.response = { status: 500, data: { mensaje: 'Ocurrió un error al obtener información.', detalles: `No se encontraron datos para el id: ${id}` } };
  return err;
}

beforeEach(() => {
  vi.useFakeTimers();   // evita esperar los backoffs reales de 1s/2s
  vi.resetAllMocks();   // limpia implementaciones y colas *Once entre tests
  invalidateImToken();  // el token cacheado es estado de módulo compartido
});

afterEach(() => {
  vi.useRealTimers();
});

describe('imGetRetry', () => {
  it('reintenta ante 500 y resuelve si el 2º intento anda', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(httpError(500))
      .mockResolvedValueOnce('ok');
    const p = imGetRetry(fn, 'test-500');
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('reintenta ante 401 (IM mata sesiones server-side antes del exp del JWT)', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(httpError(401))
      .mockResolvedValueOnce('ok');
    const p = imGetRetry(fn, 'test-401');
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('ante 400 NO reintenta: falla al primer intento', async () => {
    const fn = vi.fn().mockRejectedValue(httpError(400));
    await expect(imGetRetry(fn, 'test-400')).rejects.toThrow('HTTP 400');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('agota los reintentos y propaga el último error', async () => {
    const fn = vi.fn().mockRejectedValue(httpError(500));
    const p = imGetRetry(fn, 'test-agotado');
    const rechazo = expect(p).rejects.toThrow('HTTP 500');
    await vi.runAllTimersAsync();
    await rechazo;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  /**
   * 🔴 Mati (10/09/2026): *"sigo sin poder sacar a Bianconi, sigue diciendo que le falta el
   * remito cuando no es así"*. La factura estaba BORRADA en IM, y IM avisa eso con un 500:
   * `{"detalles":"No se encontraron datos para el id: 58779252"}`. Reintentarlo son 3 s de
   * espera al pedo en cada carga de la pantalla, y el error final se lee como "no pude
   * preguntar" en vez de "no está".
   */
  it('ante el 500 de "no se encontraron datos" NO reintenta: el comprobante no existe', async () => {
    const fn = vi.fn().mockRejectedValue(sinDatos(58779252));
    await expect(imGetRetry(fn, 'test-borrado')).rejects.toThrow('HTTP 500');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('invalidación del token IM (incidente 06-07/07/2026)', () => {
  it('tras un 500 se invalida el token: el próximo imToken() re-loguea', async () => {
    vi.mocked(axios.post)
      .mockResolvedValueOnce({ data: { token: 'tok-1' } } as any)
      .mockResolvedValueOnce({ data: { token: 'tok-2' } } as any);

    expect(await imToken()).toBe('tok-1');
    expect(await imToken()).toBe('tok-1'); // cache 23h: no re-loguea
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(vi.mocked(axios.post).mock.calls[0][0]).toContain('/auth/login');

    const fn = vi.fn()
      .mockRejectedValueOnce(httpError(500))
      .mockResolvedValueOnce('ok');
    const p = imGetRetry(fn, 'test-invalidate-500');
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');

    expect(await imToken()).toBe('tok-2'); // re-login tras el 500
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  it('tras un 401 también se invalida el token', async () => {
    vi.mocked(axios.post)
      .mockResolvedValueOnce({ data: { token: 'tok-1' } } as any)
      .mockResolvedValueOnce({ data: { token: 'tok-2' } } as any);

    expect(await imToken()).toBe('tok-1');

    const fn = vi.fn()
      .mockRejectedValueOnce(httpError(401))
      .mockResolvedValueOnce('ok');
    const p = imGetRetry(fn, 'test-invalidate-401');
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');

    expect(await imToken()).toBe('tok-2');
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  it('un error de red (sin status) reintenta pero NO invalida el token', async () => {
    vi.mocked(axios.post).mockResolvedValueOnce({ data: { token: 'tok-1' } } as any);
    expect(await imToken()).toBe('tok-1');

    const fn = vi.fn()
      .mockRejectedValueOnce(httpError(undefined, 'ECONNRESET'))
      .mockResolvedValueOnce('ok');
    const p = imGetRetry(fn, 'test-red');
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');

    expect(await imToken()).toBe('tok-1'); // sigue cacheado
    expect(axios.post).toHaveBeenCalledTimes(1);
  });
});

describe('imClient', () => {
  it('resuelve el token POR REQUEST: una instancia vieja toma el token nuevo tras invalidar', async () => {
    vi.mocked(axios.post)
      .mockResolvedValueOnce({ data: { token: 'tok-viejo' } } as any)
      .mockResolvedValueOnce({ data: { token: 'tok-nuevo' } } as any);

    // Capturamos el interceptor de request que imClient registra en la instancia.
    let onRequest: ((config: any) => Promise<any>) | undefined;
    vi.mocked(axios.create).mockReturnValue({
      interceptors: { request: { use: (h: any) => { onRequest = h; } } },
    } as any);

    const cli = await imClient();
    expect(cli).toBeDefined();
    expect(onRequest).toBeDefined();

    const cfg1 = await onRequest!({ headers: {} });
    expect(cfg1.headers.Authorization).toBe('Bearer tok-viejo');

    invalidateImToken(); // lo que hace imGetRetry tras un 500/401
    const cfg2 = await onRequest!({ headers: {} });
    expect(cfg2.headers.Authorization).toBe('Bearer tok-nuevo');
  });
});

it('429 respeta Retry-After segundos y fecha HTTP, sin repetir ni esperar una hora por request',async()=>{
  vi.setSystemTime(new Date('2026-09-11T10:00:00Z'));
  for (const retryAfter of ['3600','Fri, 11 Sep 2026 12:00:00 GMT']) {
    const error:any=httpError(429);error.response.headers={'retry-after':retryAfter};
    const primera=vi.fn().mockRejectedValue(error);await expect(imGetRetry(primera,'cuota')).rejects.toBe(error);expect(primera).toHaveBeenCalledTimes(1);
    const siguiente=vi.fn();await expect(imGetRetry(siguiente,'durante pausa')).rejects.toMatchObject({retryable:false});expect(siguiente).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3600_000);
  }
});

/**
 * 🔑 24/09/2026: InfoManager cortó con 429 en plena facturación y en el log no quedó NADA: ni qué
 * consulta chocó ni cuánto pidió esperar. No hubo forma de saber quién gastó la cuota.
 *
 * 🪤 IM dice cuánto esperar en el CUERPO (`reintentarEnSegundos`, visto el 31/07/2026). Sin
 * Retry-After se usaban 30 s, y a los 30 s se le volvía a preguntar en plena veda.
 */
it('429 sin Retry-After respeta el reintentarEnSegundos del cuerpo y queda en el log',async()=>{
  // Después de la pausa que dejó el test anterior (11/09 12:00) y antes de cualquier reloj real.
  vi.setSystemTime(new Date('2026-09-12T10:00:00Z'));
  const aviso=vi.spyOn(console,'warn').mockImplementation(()=>{});
  const error:any=httpError(429);
  error.response.data={mensaje:'Se superó el límite de solicitudes por hora para este cliente',reintentarEnSegundos:1316};
  await expect(imGetRetry(vi.fn().mockRejectedValue(error),'/ventas 2026-09')).rejects.toBe(error);
  expect(aviso.mock.calls.flat().join(' ')).toMatch(/429.*\/ventas 2026-09.*1316/);
  await vi.advanceTimersByTimeAsync(60_000);
  const siguiente=vi.fn();
  await expect(imGetRetry(siguiente,'durante pausa')).rejects.toMatchObject({retryable:false});
  expect(siguiente).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1316_000);
  aviso.mockRestore();
});
