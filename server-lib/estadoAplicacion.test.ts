import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
vi.mock('node:fs', () => ({ default: { readFileSync: () => { throw new Error('sin metadata'); } } }));
vi.mock('./supabase.js', () => ({ hasSupabase: () => false, sb: vi.fn() }));
import { crearComprobadorEsquema, estadoPreparacion, exigirEsquemaReparto, saludProceso } from './estadoAplicacion.js';

describe('preparación de reparto', () => {
  it('comparte ocho verificaciones concurrentes y revalida tras TTL', async () => {
    let now = 1000;
    let finish!: (v: { listo: boolean; version: number }) => void;
    const query = vi.fn(() => new Promise<{ listo: boolean; version: number }>(resolve => { finish = resolve; }));
    const ready = crearComprobadorEsquema(query, () => now);
    const pending = Array.from({ length: 8 }, () => ready());
    await Promise.resolve();
    expect(query).toHaveBeenCalledTimes(1);
    finish({ listo: true, version: 41 });
    expect((await Promise.all(pending)).every(x => x.listo)).toBe(true);
    expect((await ready()).listo).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    now += 30_001;
    query.mockResolvedValueOnce({ listo: true, version: 41 });
    expect((await ready()).listo).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
  });
  it('error y versión anterior bloquean; se recupera con esquema completo', async () => {
    let now = 1000;
    const query = vi.fn().mockRejectedValueOnce(new Error('sin conexión'))
      .mockResolvedValueOnce({ listo: true, version: 40 })
      .mockResolvedValue({ listo: true, version: 41 });
    const ready = crearComprobadorEsquema(query, () => now);
    expect((await ready()).listo).toBe(false);
    expect((await ready()).listo).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
    now += 3001;
    expect((await ready()).listo).toBe(false);
    now += 3001;
    expect((await ready()).listo).toBe(true);
  });
});

describe('rutas Express sin esquema ni credenciales', () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server!.close(e => e ? reject(e) : resolve()));
    }
    server = null;
  });
  it('salud200, preparación503, escritura no llega al handler y GET sigue disponible', async () => {
    const app = express();
    const writes = vi.fn((_req, res) => res.json({ escrito: true }));
    app.get('/healthz', saludProceso);
    app.get('/readyz', estadoPreparacion);
    app.use('/api/hojas-ruta', exigirEsquemaReparto);
    app.post('/api/hojas-ruta', writes);
    app.get('/api/hojas-ruta', (_req, res) => res.json({ hojas: [] }));
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server!.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Servidor local sin puerto');
    const url = 'http://127.0.0.1:' + address.port;
    expect((await fetch(url + '/healthz')).status).toBe(200);
    const ready = await fetch(url + '/readyz');
    expect(ready.status).toBe(503);
    expect(ready.headers.get('cache-control')).toBe('no-store');
    expect((await ready.json()).listo).toBe(false);
    expect((await fetch(url + '/api/hojas-ruta', { method: 'POST' })).status).toBe(503);
    expect(writes).not.toHaveBeenCalled();
    expect((await fetch(url + '/api/hojas-ruta')).status).toBe(200);
  });
});
