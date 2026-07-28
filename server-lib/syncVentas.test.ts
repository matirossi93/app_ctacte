import { describe, it, expect, vi, beforeEach } from 'vitest';

// Aislamos syncVentas.ts de sus dependencias pesadas para poder probar el
// cableado de invalidación de caches sin tocar IM / Supabase / snapshotCache.
vi.mock('./goalsResponseCache.js', () => ({ invalidateByPrefix: vi.fn() }));
vi.mock('./snapshotCache.js', () => ({ invalidateMonth: vi.fn(), invalidateItemsMonth: vi.fn() }));
vi.mock('./notificacionesAlertas.js', () => ({ invalidateAlertasVendedor: vi.fn() }));
vi.mock('./historialCompras.js', () => ({ invalidateHistorialCache: vi.fn() }));
vi.mock('./infomanager.js', () => ({ fetchVentas: vi.fn(), fetchVentasItems: vi.fn() }));
vi.mock('./supabase.js', () => ({ sb: vi.fn(), TENANT_ID: 'test', hasSupabase: () => false }));
vi.mock('./comisionesShared.js', () => ({ COD_EMPRESA_CASA_CENTRAL: 1, COD_CLIENTES_INTERNOS: new Set() }));
vi.mock('./comisionOverrides.js', () => ({ loadVendedorOverrides: vi.fn(), resolveCodVendedor: vi.fn() }));
vi.mock('../src/utils/ventas.js', () => ({ computeVentaNeta: vi.fn(), monthKey: vi.fn() }));

import { invalidateMonthCaches } from './syncVentas.js';
import { invalidateByPrefix } from './goalsResponseCache.js';
import { invalidateMonth, invalidateItemsMonth } from './snapshotCache.js';
import { invalidateAlertasVendedor } from './notificacionesAlertas.js';
import { invalidateHistorialCache } from './historialCompras.js';

describe('invalidateMonthCaches', () => {
  beforeEach(() => vi.clearAllMocks());

  it('invalida los caches ya existentes del mes (goals, clientes, snapshot, items)', () => {
    invalidateMonthCaches(2026, 7);
    expect(invalidateByPrefix).toHaveBeenCalledWith('goals:2026-07:');
    expect(invalidateByPrefix).toHaveBeenCalledWith('clientes:2026-07:');
    expect(invalidateMonth).toHaveBeenCalledWith(2026, 7, undefined);
    expect(invalidateItemsMonth).toHaveBeenCalledWith(2026, 7, undefined);
  });

  it('invalida TAMBIÉN los caches de alertas (campana + historial): una venta nueva no puede dejar alertas rancias', () => {
    invalidateMonthCaches(2026, 7);
    // Sin argumentos = clear total: el sync no sabe qué vendedor/cliente cambió.
    expect(invalidateAlertasVendedor).toHaveBeenCalled();
    expect(invalidateHistorialCache).toHaveBeenCalled();
  });
});
