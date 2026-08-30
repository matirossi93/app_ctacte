import { describe, it, expect, vi, beforeEach } from 'vitest';

// Aislamos syncVentas.ts de sus dependencias pesadas para poder probar el
// cableado de invalidación de caches sin tocar IM / Supabase / snapshotCache.
vi.mock('./goalsResponseCache.js', () => ({ invalidateByPrefix: vi.fn() }));
vi.mock('./snapshotCache.js', () => ({
  invalidateMonth: vi.fn(),
  invalidateItemsMonth: vi.fn(),
  getMonthlyVentasRaw: vi.fn().mockResolvedValue({ ventas: [], cached: false, cacheAge: 0 }),
  getMonthlyItemsRaw: vi.fn().mockResolvedValue({ items: [], cached: false, cacheAge: 0 }),
}));
vi.mock('./notificacionesAlertas.js', () => ({ invalidateAlertasVendedor: vi.fn() }));
vi.mock('./historialCompras.js', () => ({ invalidateHistorialCache: vi.fn() }));
vi.mock('./infomanager.js', () => ({ fetchVentas: vi.fn(), fetchVentasItems: vi.fn() }));
vi.mock('./supabase.js', () => ({ sb: vi.fn(), TENANT_ID: 'test', hasSupabase: () => true }));
vi.mock('./comisionesShared.js', () => ({ COD_EMPRESA_CASA_CENTRAL: 1, COD_CLIENTES_INTERNOS: new Set() }));
vi.mock('./comisionOverrides.js', () => ({ loadVendedorOverrides: vi.fn().mockResolvedValue(new Map()), resolveCodVendedor: vi.fn() }));
vi.mock('../src/utils/ventas.js', () => ({ computeVentaNeta: vi.fn(), monthKey: vi.fn() }));

import { invalidateMonthCaches, syncVentasMesActual } from './syncVentas.js';
import { invalidateByPrefix } from './goalsResponseCache.js';
import { invalidateMonth, invalidateItemsMonth, getMonthlyVentasRaw, getMonthlyItemsRaw } from './snapshotCache.js';
import { invalidateAlertasVendedor } from './notificacionesAlertas.js';
import { invalidateHistorialCache } from './historialCompras.js';
import { fetchVentas, fetchVentasItems } from './infomanager.js';

describe('invalidateMonthCaches', () => {
  beforeEach(() => vi.clearAllMocks());

  it('invalida los caches derivados del mes (goals, clientes)', () => {
    invalidateMonthCaches(2026, 7);
    expect(invalidateByPrefix).toHaveBeenCalledWith('goals:2026-07:');
    expect(invalidateByPrefix).toHaveBeenCalledWith('clientes:2026-07:');
  });

  it('NO invalida el crudo del snapshotCache: el sync ahora lo ESCRIBE (force), borrarlo tiraría el dato recién bajado de IM', () => {
    invalidateMonthCaches(2026, 7);
    expect(invalidateMonth).not.toHaveBeenCalled();
    expect(invalidateItemsMonth).not.toHaveBeenCalled();
  });

  it('invalida TAMBIÉN los caches de alertas (campana + historial): una venta nueva no puede dejar alertas rancias', () => {
    invalidateMonthCaches(2026, 7);
    // Sin argumentos = clear total: el sync no sabe qué vendedor/cliente cambió.
    expect(invalidateAlertasVendedor).toHaveBeenCalled();
    expect(invalidateHistorialCache).toHaveBeenCalled();
  });
});

describe('syncVentasMesActual — una sola descarga del mes, compartida con el snapshotCache', () => {
  beforeEach(() => vi.clearAllMocks());

  it('baja el mes VÍA snapshotCache con force (queda cacheado para goals/comisiones) y NO llama a fetchVentas directo', async () => {
    const r = await syncVentasMesActual();
    expect(r.ok).toBe(true);

    const now = new Date();
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth() + 1;
    // Sin codEmpresa: la key del cache debe ser la misma `empall` que usan el
    // prewarm y todos los consumidores (IM ignora codEmpresa en /ventas igual;
    // el filtro por empresa se hace en código, sobre el crudo compartido).
    expect(getMonthlyVentasRaw).toHaveBeenCalledWith(y, m, { force: true });
    expect(getMonthlyItemsRaw).toHaveBeenCalledWith(y, m, { force: true });
    // El camino viejo (descarga paralela por fuera del cache) no debe existir más.
    expect(fetchVentas).not.toHaveBeenCalled();
    expect(fetchVentasItems).not.toHaveBeenCalled();
  });
});
