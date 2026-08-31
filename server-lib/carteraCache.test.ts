import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Los dos caches que hacen que la cartera no se haga esperar.
 *
 * Medido el 31/08/2026 contra producción (código real adentro del contenedor):
 *   · saldo de HOY con el dato ya traído ......  292 ms
 *   · saldo de HOY con el cache vencido ...... 6.377 ms  ← la llamada a InfoManager
 *   · corte a una fecha pasada ............... 1.168 ms, SIEMPRE (no se cacheaba nada)
 * y de ese último, 753 ms eran volver a bajar de Supabase una foto que ya no puede cambiar.
 *
 * 🔑 La condición de Mati fue "optimizar cuidando la cuota de InfoManager". Ninguno de los
 * dos caches agrega una sola llamada a IM: el de la foto no lo toca (Supabase), y el
 * stale-while-revalidate hace LA MISMA llamada, sólo que sin nadie esperándola.
 */

vi.mock('./infomanager.js', () => ({
  fetchComprobPendientes: vi.fn(),
  fetchClientesIMCached: vi.fn(),
  fetchVendedores: vi.fn(),
}));
vi.mock('./supabase.js', () => ({
  sb: vi.fn(),
  TENANT_ID: 'test-tenant',
  hasSupabase: () => true,
}));

import {
  getSnapshotConciliacion, invalidateSnapshotCache,
  fetchPendientesCached, invalidatePendientesCache,
  hoyISOArgentina,
} from './conciliacion.js';
import { sb } from './supabase.js';
import { fetchComprobPendientes } from './infomanager.js';

/** Un `sb()` que cuenta cuántas veces se consultó de verdad la tabla. */
function fakeSb(filaPorFecha: Record<string, unknown>) {
  const llamadas = { n: 0 };
  (sb as any).mockImplementation(() => ({
    from: () => {
      let fecha = '';
      const q: any = {
        select: () => q,
        eq: (col: string, val: any) => { if (col === 'fecha') fecha = String(val); return q; },
        maybeSingle: async () => {
          llamadas.n++;
          return { data: filaPorFecha[fecha] ?? null, error: null };
        },
      };
      return q;
    },
  }));
  return llamadas;
}

const FOTO = {
  rows: [{ cod_cliente: 100, cod_vendedor: 2, nombre: 'X', tipo_comprobante: 'FA', saldo: 1000 }],
  maestro: { '100': { cod_vendedor: 2, nombre: 'X' } },
  created_at: '2026-07-31T23:50:00.000Z',
};

describe('cache de la foto histórica — 753 ms que se pagaban en cada consulta', () => {
  beforeEach(() => { invalidateSnapshotCache(); vi.clearAllMocks(); });

  it('una fecha pasada se baja UNA vez: la foto de un día que ya pasó no cambia nunca', async () => {
    const llamadas = fakeSb({ '2026-07-31': FOTO });

    const a = await getSnapshotConciliacion(1, '2026-07-31');
    const b = await getSnapshotConciliacion(1, '2026-07-31');

    expect(a?.rows).toHaveLength(1);
    expect(b).toEqual(a);
    expect(llamadas.n).toBe(1);
  });

  // 🪤 La foto de HOY sí se mueve: el cron la re-guarda con upsert y `guardarSnapshotConciliacion`
  // pisa el created_at a propósito para que "foto de hoy a las HH:MM" sea veraz. Cachearla
  // serviría un saldo viejo como si fuera el del cierre.
  it('la de HOY NO se cachea: el cron la vuelve a pisar durante el día', async () => {
    const hoy = hoyISOArgentina();
    const llamadas = fakeSb({ [hoy]: FOTO });

    await getSnapshotConciliacion(1, hoy);
    await getSnapshotConciliacion(1, hoy);

    expect(llamadas.n).toBe(2);
  });

  // Si el 12/07 no tiene foto hoy, puede tenerla mañana (se rellenó a mano). Cachear el
  // "no hay" dejaría la app diciendo que no hay dato después de que apareció.
  it('el "no hay foto" no se cachea: mañana puede existir', async () => {
    const llamadas = fakeSb({});

    expect(await getSnapshotConciliacion(1, '2026-07-12')).toBeNull();
    expect(await getSnapshotConciliacion(1, '2026-07-12')).toBeNull();

    expect(llamadas.n).toBe(2);
  });

  it('cada empresa tiene su propia foto: BRS no puede comerse la de Casa Central', async () => {
    const llamadas = fakeSb({ '2026-07-31': FOTO });

    await getSnapshotConciliacion(1, '2026-07-31');
    await getSnapshotConciliacion(2, '2026-07-31');

    expect(llamadas.n).toBe(2);
  });
});

describe('stale-while-revalidate — que nadie espere los 6,4 s de InfoManager', () => {
  beforeEach(() => { invalidatePendientesCache(); vi.clearAllMocks(); });

  it('la primera vez SÍ se espera: no hay nada viejo que mostrar', async () => {
    (fetchComprobPendientes as any).mockResolvedValue([{ cod_cliente: 1 }]);

    const r = await fetchPendientesCached(9, false);

    expect(r.rows).toHaveLength(1);
    expect(fetchComprobPendientes).toHaveBeenCalledTimes(1);
  });

  it('con el cache vencido devuelve lo viejo AL TOQUE y busca lo nuevo por atrás', async () => {
    (fetchComprobPendientes as any).mockResolvedValue([{ cod_cliente: 1 }]);
    await fetchPendientesCached(9, false);

    // Envejecer el cache más allá del TTL de 10 min, sin tocar el reloj global.
    const t0 = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 11 * 60 * 1000);

    let resolverIM: (v: any) => void = () => {};
    (fetchComprobPendientes as any).mockImplementation(() => new Promise(res => { resolverIM = res; }));

    // 🔑 Esto es lo que se prueba: responde SIN esperar a que IM conteste.
    const r = await fetchPendientesCached(9, false);
    expect(r.rows).toEqual([{ cod_cliente: 1 }]);
    expect(r.stale).toBe(true);
    expect(fetchComprobPendientes).toHaveBeenCalledTimes(2);   // el refresh salió, nadie lo esperó

    resolverIM([{ cod_cliente: 2 }]);
    await new Promise(r => setImmediate(r));
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 11 * 60 * 1000 + 10);

    // La siguiente consulta ya ve lo nuevo, y sin llamar de vuelta.
    const r2 = await fetchPendientesCached(9, false);
    expect(r2.rows).toEqual([{ cod_cliente: 2 }]);
    expect(r2.stale).toBe(false);
    expect(fetchComprobPendientes).toHaveBeenCalledTimes(2);

    vi.mocked(Date.now).mockRestore();
  });

  // 🪤 Un dato de anteayer no es "un poco viejo": es otro número. Pasado el tope se espera,
  // aunque duela, porque mostrar el saldo de otro día como si fuera el de hoy es justo lo
  // que la regla de Mati prohíbe.
  it('si lo viejo es DEMASIADO viejo se espera el dato fresco', async () => {
    (fetchComprobPendientes as any).mockResolvedValue([{ cod_cliente: 1 }]);
    await fetchPendientesCached(9, false);

    const t0 = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 3 * 60 * 60 * 1000);   // 3 horas
    (fetchComprobPendientes as any).mockResolvedValue([{ cod_cliente: 2 }]);

    const r = await fetchPendientesCached(9, false);

    expect(r.rows).toEqual([{ cod_cliente: 2 }]);   // el fresco, no el de hace 3 h
    expect(r.stale).toBe(false);

    vi.mocked(Date.now).mockRestore();
  });

  it('refresh=1 sigue esperando el dato nuevo: es el botón de "traeme lo de ahora"', async () => {
    (fetchComprobPendientes as any).mockResolvedValue([{ cod_cliente: 1 }]);
    await fetchPendientesCached(9, false);

    (fetchComprobPendientes as any).mockResolvedValue([{ cod_cliente: 2 }]);
    const r = await fetchPendientesCached(9, true);

    expect(r.rows).toEqual([{ cod_cliente: 2 }]);
  });
});
