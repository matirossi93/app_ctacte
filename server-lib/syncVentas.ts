import { fetchVentas, type VentaRaw } from './infomanager.js';
import { sb, TENANT_ID, hasSupabase } from './supabase.js';
import { computeVentaNeta, monthKey } from '../src/utils/ventas.js';

export interface SyncResult {
  ok: boolean;
  comprobantes: number;
  clientes: number;
  vendedores: number;
  elapsedMs: number;
  error?: string;
}

function ymdToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function ymdMonthStart(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/**
 * Sync del mes actual: consulta /ventas del 1 al hoy,
 * agrega por cliente+mes y vendedor+mes, upserta en Supabase.
 */
export async function syncVentasMesActual(opts?: { codEmpresa?: number }): Promise<SyncResult> {
  const t0 = Date.now();
  if (!hasSupabase()) {
    return { ok: false, comprobantes: 0, clientes: 0, vendedores: 0, elapsedMs: 0, error: 'Supabase no configurado' };
  }
  try {
    const desde = ymdMonthStart();
    const hasta = ymdToday();
    const ventas = await fetchVentas(desde, hasta, { codEmpresa: opts?.codEmpresa });

    const byCliente = new Map<string, { cod_cliente: number; year: number; month: number; neto: number; num: number }>();
    const byVendedor = new Map<string, { cod_vendedor: number; year: number; month: number; neto: number; num: number }>();

    for (const v of ventas) {
      const neto = computeVentaNeta(v);
      if (neto === 0) continue;
      const k = monthKey(v.fa_fecha ?? v.fecha);
      if (!k) continue;

      if (v.cod_cliente != null) {
        const key = `${v.cod_cliente}-${k.year}-${k.month}`;
        const cur = byCliente.get(key) ?? { cod_cliente: v.cod_cliente, year: k.year, month: k.month, neto: 0, num: 0 };
        cur.neto += neto;
        cur.num += 1;
        byCliente.set(key, cur);
      }
      if (v.cod_vendedor != null && v.cod_vendedor !== 0) {
        const key = `${v.cod_vendedor}-${k.year}-${k.month}`;
        const cur = byVendedor.get(key) ?? { cod_vendedor: v.cod_vendedor, year: k.year, month: k.month, neto: 0, num: 0 };
        cur.neto += neto;
        cur.num += 1;
        byVendedor.set(key, cur);
      }
    }

    const clientRows = Array.from(byCliente.values()).map(r => ({
      tenant_id: TENANT_ID,
      cod_cliente: r.cod_cliente,
      year: r.year,
      month: r.month,
      neto: Number(r.neto.toFixed(2)),
      num_comprobantes: r.num,
      updated_at: new Date().toISOString()
    }));
    const vendorRows = Array.from(byVendedor.values()).map(r => ({
      tenant_id: TENANT_ID,
      cod_vendedor: r.cod_vendedor,
      year: r.year,
      month: r.month,
      neto: Number(r.neto.toFixed(2)),
      num_comprobantes: r.num,
      updated_at: new Date().toISOString()
    }));

    if (clientRows.length) {
      const { error } = await sb()
        .from('client_sales_monthly')
        .upsert(clientRows, { onConflict: 'tenant_id,cod_cliente,year,month' });
      if (error) throw new Error(`upsert client_sales_monthly: ${error.message}`);
    }
    if (vendorRows.length) {
      const { error } = await sb()
        .from('vendor_sales_monthly')
        .upsert(vendorRows, { onConflict: 'tenant_id,cod_vendedor,year,month' });
      if (error) throw new Error(`upsert vendor_sales_monthly: ${error.message}`);
    }

    return {
      ok: true,
      comprobantes: ventas.length,
      clientes: clientRows.length,
      vendedores: vendorRows.length,
      elapsedMs: Date.now() - t0
    };
  } catch (err: any) {
    return { ok: false, comprobantes: 0, clientes: 0, vendedores: 0, elapsedMs: Date.now() - t0, error: err?.message ?? String(err) };
  }
}
