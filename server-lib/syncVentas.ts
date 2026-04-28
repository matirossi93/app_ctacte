import { fetchVentas } from './infomanager.js';
import { sb, TENANT_ID, hasSupabase } from './supabase.js';
import { computeVentaNeta, monthKey } from '../src/utils/ventas.js';
import { invalidateAll as invalidateGoalsCache } from './goalsResponseCache.js';

export interface SyncResult {
  ok: boolean;
  comprobantes: number;
  clientes: number;
  vendedores: number;
  elapsedMs: number;
  desde?: string;
  hasta?: string;
  label?: string;
  error?: string;
}

function ymdToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function ymdMonthStart(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function ymdMonthEnd(year: number, month: number): string {
  const lastDay = new Date(year, month, 0).getDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

/**
 * Sync de ventas para un rango arbitrario de fechas.
 * Consulta /ventas, agrega por cliente+mes y vendedor+mes, upsertea en Supabase.
 *
 * El UPSERT por PK (tenant, cod, year, month) hace seguro re-correr para captar
 * NCs tardías o backfills históricos: sobrescribe el row existente, no duplica.
 */
async function syncVentasRango(opts: {
  desde: string;
  hasta: string;
  codEmpresa?: number;
  label?: string;
}): Promise<SyncResult> {
  const t0 = Date.now();
  const { desde, hasta, codEmpresa, label } = opts;
  if (!hasSupabase()) {
    return { ok: false, comprobantes: 0, clientes: 0, vendedores: 0, elapsedMs: 0, desde, hasta, label, error: 'Supabase no configurado' };
  }
  try {
    const ventas = await fetchVentas(desde, hasta, { codEmpresa });

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
      const total = Number(v.fa_total ?? (v as any).total ?? 0) || 0;
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

    const tag = label ? `[syncVentas:${label}]` : '[syncVentas]';

    // Log del breakdown — útil para auditar discrepancias en el avance.
    const tipoSummary = Array.from(byTipo.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .map(([t, s]) => `${t || '(vacío)'}: ${s.count} comp, $${Math.round(s.sumTotal).toLocaleString('es-AR')} total, $${Math.round(s.sumNeto).toLocaleString('es-AR')} neto`)
      .join(' | ');
    console.log(`${tag} Breakdown por tipo (${desde}→${hasta}): ${tipoSummary}`);
    console.log(`${tag} Comprobantes c/neto=0 (ND/RC/RE/PR/anuladas): ${comprobantesCero}. Reasignados cod_vendedor=0→cliente: ${reasignados}`);

    // Top 5 clientes por neto acumulado — permite al admin cross-checkear.
    const topClientes = Array.from(byCliente.values())
      .sort((a, b) => b.neto - a.neto)
      .slice(0, 5)
      .map(c => `cli ${c.cod_cliente}: $${Math.round(c.neto).toLocaleString('es-AR')} (${c.num} comp)`)
      .join(' | ');
    console.log(`${tag} Top 5 clientes del rango: ${topClientes}`);

    const totalNetoGlobal = Array.from(byCliente.values()).reduce((a, c) => a + c.neto, 0);
    console.log(`${tag} TOTAL NETO rango: $${Math.round(totalNetoGlobal).toLocaleString('es-AR')} sobre ${byCliente.size} clientes y ${byVendedor.size} vendedores. ${ventas.length} ventas procesadas.`);

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
      elapsedMs: Date.now() - t0,
      desde, hasta, label,
    };
  } catch (err: any) {
    return { ok: false, comprobantes: 0, clientes: 0, vendedores: 0, elapsedMs: Date.now() - t0, desde, hasta, label, error: err?.message ?? String(err) };
  }
}

/**
 * Sync del mes actual: del 1 al hoy.
 * Wrapper sobre syncVentasRango.
 */
export async function syncVentasMesActual(opts?: { codEmpresa?: number }): Promise<SyncResult> {
  const r = await syncVentasRango({
    desde: ymdMonthStart(),
    hasta: ymdToday(),
    codEmpresa: opts?.codEmpresa,
    label: 'mes-actual',
  });
  // El cron */30 actualiza vendor/client_sales_monthly del mes actual:
  // invalidar cache de Objetivos para que la próxima carga vea el nuevo avance.
  if (r.ok) invalidateGoalsCache();
  return r;
}

/**
 * Sync de un mes específico (entero, día 1 al último).
 * Si es el mes en curso, recorta `hasta` a hoy.
 */
export async function syncVentasMes(year: number, month: number, opts?: { codEmpresa?: number }): Promise<SyncResult> {
  const now = new Date();
  const isCurrent = now.getUTCFullYear() === year && (now.getUTCMonth() + 1) === month;
  const desde = `${year}-${String(month).padStart(2, '0')}-01`;
  const hasta = isCurrent ? ymdToday() : ymdMonthEnd(year, month);
  return syncVentasRango({
    desde, hasta,
    codEmpresa: opts?.codEmpresa,
    label: `${year}-${String(month).padStart(2, '0')}`,
  });
}

/**
 * Sync de los últimos N meses (incluyendo el actual).
 * Itera mes por mes hacia atrás. Útil para backfill inicial y captura de NCs
 * tardías que afectan meses cerrados.
 */
export async function syncVentasMeses(n: number, opts?: { codEmpresa?: number }): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  const now = new Date();
  const baseYear = now.getUTCFullYear();
  const baseMonth = now.getUTCMonth() + 1;
  for (let i = 0; i < n; i++) {
    // i=0 → mes actual; i=1 → mes anterior; etc.
    let m = baseMonth - i;
    let y = baseYear;
    while (m <= 0) { m += 12; y -= 1; }
    const r = await syncVentasMes(y, m, opts);
    results.push(r);
  }
  // Tras sync masivo (cron diario o backfill manual), invalidar cache de
  // respuestas: los próximos /api/goals reflejan los nuevos avances.
  invalidateGoalsCache();
  return results;
}
