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

    // Map cliente→vendedor basado en las ventas del batch con cod_vendedor != 0.
    // Se usa para reasignar comprobantes con cod_vendedor=0 (ventas mostrador)
    // al vendedor real del cliente. Replica la lógica de server.ts (Cobranzas).
    const clientToVendor = new Map<number, number>();
    for (const v of ventas) {
      if (v.cod_cliente != null && v.cod_vendedor != null && v.cod_vendedor !== 0) {
        if (!clientToVendor.has(v.cod_cliente)) clientToVendor.set(v.cod_cliente, v.cod_vendedor);
      }
    }

    // Diagnóstico: contar por tipo (para saber si FA/NC/ND y tipos no reconocidos).
    const byTipo = new Map<string, { count: number; sumTotal: number; sumNeto: number }>();
    let comprobantesCero = 0;
    let reasignados = 0;

    for (const v of ventas) {
      const tipo = String((v as any).tipo ?? (v as any).tipo_comprobante ?? '').toUpperCase();
      const neto = computeVentaNeta(v);
      const total = Number(v.fa_total ?? v.total ?? 0) || 0;
      const t = byTipo.get(tipo) ?? { count: 0, sumTotal: 0, sumNeto: 0 };
      t.count++;
      t.sumTotal += total;
      t.sumNeto += neto;
      byTipo.set(tipo, t);

      if (neto === 0) { comprobantesCero++; continue; }
      const k = monthKey(v.fa_fecha ?? v.fecha);
      if (!k) continue;

      if (v.cod_cliente != null) {
        const key = `${v.cod_cliente}-${k.year}-${k.month}`;
        const cur = byCliente.get(key) ?? { cod_cliente: v.cod_cliente, year: k.year, month: k.month, neto: 0, num: 0 };
        cur.neto += neto;
        cur.num += 1;
        byCliente.set(key, cur);
      }
      // Vendedor efectivo: el del comprobante, o fallback al del cliente.
      let codVend = v.cod_vendedor != null && v.cod_vendedor !== 0 ? v.cod_vendedor : null;
      if (codVend == null && v.cod_cliente != null) {
        const fallback = clientToVendor.get(v.cod_cliente);
        if (fallback != null) { codVend = fallback; reasignados++; }
      }
      if (codVend != null) {
        const key = `${codVend}-${k.year}-${k.month}`;
        const cur = byVendedor.get(key) ?? { cod_vendedor: codVend, year: k.year, month: k.month, neto: 0, num: 0 };
        cur.neto += neto;
        cur.num += 1;
        byVendedor.set(key, cur);
      }
    }

    // Log del breakdown — útil para auditar discrepancias en el avance.
    const tipoSummary = Array.from(byTipo.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .map(([t, s]) => `${t || '(vacío)'}: ${s.count} comp, $${Math.round(s.sumTotal).toLocaleString('es-AR')} total, $${Math.round(s.sumNeto).toLocaleString('es-AR')} neto`)
      .join(' | ');
    console.log(`[syncVentas] Breakdown por tipo: ${tipoSummary}`);
    console.log(`[syncVentas] Comprobantes c/neto=0 (ND/RC/RE/PR/anuladas): ${comprobantesCero}. Reasignados cod_vendedor=0→cliente: ${reasignados}`);

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
