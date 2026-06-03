import { fetchVentas, fetchVentasItems } from './infomanager.js';
import { sb, TENANT_ID, hasSupabase } from './supabase.js';
import { computeVentaNeta, monthKey } from '../src/utils/ventas.js';
import { invalidateByPrefix as invalidateGoalsPrefix } from './goalsResponseCache.js';
import { invalidateMonth as invalidateSnapshotMonth, invalidateItemsMonth } from './snapshotCache.js';
import {
  COD_EMPRESA_CASA_CENTRAL as COD_EMPRESA_DEFAULT,
  COD_CLIENTES_INTERNOS,
} from './comisionesShared.js';
import { loadVendedorOverrides, resolveCodVendedor } from './comisionOverrides.js';

/**
 * Invalida los caches de Goals / snapshot / items para el mes recién sincronizado.
 * Antes se llamaba `invalidateAll()` sobre el response cache, lo que tiraba
 * meses históricos que no habían cambiado y bajaba el hit rate. Ahora limpia
 * solo el prefijo del mes afectado (goals + clientes) y el dataset crudo del
 * mismo mes en snapshotCache para que /api/goals/snapshot vea las ventas
 * frescas inmediatamente, sin esperar al TTL de 5 min.
 */
function invalidateMonthCaches(year: number, month: number, codEmpresa?: number): void {
  const mm = String(month).padStart(2, '0');
  invalidateGoalsPrefix(`goals:${year}-${mm}:`);
  invalidateGoalsPrefix(`clientes:${year}-${mm}:`);
  invalidateSnapshotMonth(year, month, codEmpresa);
  invalidateItemsMonth(year, month, codEmpresa);
}

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
    // Traemos cabeceras y líneas en paralelo. El neto del avance se calcula
    // sumando `item.importe` (con descuento aplicado) por id_comprobante,
    // multiplicado por el signo del tipo (FA: +, NC: -). Esto da exactamente
    // el mismo número que `comisiones.ts` (ya validado contra el Excel manual
    // de Mati), y evita la diff que aparecía cuando se sumaba `fa_total` por
    // cabecera (incluye IVA/redondeos que items no tiene).
    const [ventas, items, overrides] = await Promise.all([
      fetchVentas(desde, hasta, { codEmpresa }),
      fetchVentasItems(desde, hasta, { codEmpresa }),
      loadVendedorOverrides(),
    ]);

    // Importe por id_comprobante (suma de líneas).
    const importeByComprob = new Map<number, number>();
    for (const it of items) {
      const id = Number((it as any).id_comprobante);
      if (!Number.isFinite(id)) continue;
      const cur = importeByComprob.get(id) ?? 0;
      importeByComprob.set(id, cur + (Number((it as any).importe ?? 0) || 0));
    }

    const byCliente = new Map<string, { cod_cliente: number; year: number; month: number; neto: number; num: number }>();
    const byVendedor = new Map<string, { cod_vendedor: number; year: number; month: number; neto: number; num: number }>();

    // Diagnóstico: contar por tipo (para saber si FA/NC/ND y tipos no reconocidos).
    const byTipo = new Map<string, { count: number; sumTotal: number; sumNeto: number }>();
    let comprobantesCero = 0;
    let mostradorDescartados = 0;
    let internosExcluidos = 0;
    let otraEmpresaExcluidos = 0;
    let sinItems = 0;

    // Filtro de empresa = el codEmpresa pedido (default Casa Central). InfoManager
    // ignora silenciosamente el query param `codEmpresa` en /ventas y devuelve
    // todas las empresas, así que filtramos en código (igual que comisiones.ts).
    const codEmpresaTarget = codEmpresa ?? COD_EMPRESA_DEFAULT;

    for (const v of ventas) {
      const tipo = String((v as any).tipo ?? (v as any).tipo_comprobante ?? '').toUpperCase();
      // computeVentaNeta hace todo el filtering por nosotros: anuladas → 0,
      // ND/RC/RE/PR/IR/ASD/ASH → 0, F* positivo, NC* negativo. Sólo nos
      // quedamos con el signo, no con el monto (que viene de items).
      const netoCabecera = computeVentaNeta(v);
      const total = Number(v.fa_total ?? (v as any).total ?? 0) || 0;
      const t = byTipo.get(tipo) ?? { count: 0, sumTotal: 0, sumNeto: 0 };
      t.count++;
      t.sumTotal += total;
      t.sumNeto += netoCabecera;
      byTipo.set(tipo, t);

      // Filtro empresa: solo la empresa pedida. Sin esto el avance se infla
      // con ventas de sucursales hermanas (BRS, Jujuy) cuyo equipo de
      // vendedores tiene su propia estructura.
      const codEmp = Number((v as any).cod_empresa);
      if (Number.isFinite(codEmp) && codEmp !== codEmpresaTarget) {
        otraEmpresaExcluidos++;
        continue;
      }

      // Excluir traspasos a sucursales propias — no son ventas comerciales.
      if (v.cod_cliente != null && COD_CLIENTES_INTERNOS.has(Number(v.cod_cliente))) {
        internosExcluidos++;
        continue;
      }

      if (netoCabecera === 0) { comprobantesCero++; continue; }
      const k = monthKey(v.fa_fecha ?? v.fecha);
      if (!k) continue;

      // Neto = suma items × signo de la cabecera.
      const sign = netoCabecera >= 0 ? 1 : -1;
      const importeItems = importeByComprob.get(Number((v as any).id)) ?? 0;
      if (importeItems === 0) { sinItems++; continue; }
      const neto = importeItems * sign;

      if (v.cod_cliente != null) {
        const key = `${v.cod_cliente}-${k.year}-${k.month}`;
        const cur = byCliente.get(key) ?? { cod_cliente: v.cod_cliente, year: k.year, month: k.month, neto: 0, num: 0 };
        cur.neto += neto;
        cur.num += 1;
        byCliente.set(key, cur);
      }
      // Vendedor: descartar mostrador (cod_vendedor=0) sin reasignar.
      // Comisiones también las descarta y no le asigna comisión a nadie por
      // mostrador, así que el avance debe seguir la misma regla. Excepción:
      // un override manual por comprobante gana incluso sobre mostrador.
      const idVenta = Number((v as any).id);
      const codVend = resolveCodVendedor(v.cod_vendedor, idVenta, overrides, { mostradorEsNull: true });
      if (codVend == null) { mostradorDescartados++; continue; }
      const key = `${codVend}-${k.year}-${k.month}`;
      const cur = byVendedor.get(key) ?? { cod_vendedor: codVend, year: k.year, month: k.month, neto: 0, num: 0 };
      cur.neto += neto;
      cur.num += 1;
      byVendedor.set(key, cur);
    }

    const tag = label ? `[syncVentas:${label}]` : '[syncVentas]';

    // Log del breakdown — útil para auditar discrepancias en el avance.
    const tipoSummary = Array.from(byTipo.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .map(([t, s]) => `${t || '(vacío)'}: ${s.count} comp, $${Math.round(s.sumTotal).toLocaleString('es-AR')} total, $${Math.round(s.sumNeto).toLocaleString('es-AR')} neto-cab`)
      .join(' | ');
    console.log(`${tag} Breakdown por tipo (${desde}→${hasta}): ${tipoSummary}`);
    console.log(`${tag} Items totales: ${items.length}. Comprobantes c/neto=0 (ND/RC/RE/PR/anuladas): ${comprobantesCero}. Sin items en /ventas/items: ${sinItems}. Mostrador descartados (cod_vendedor=0): ${mostradorDescartados}. Clientes internos excluidos: ${internosExcluidos}. Otra empresa excluidos (filtrados en código, no IM): ${otraEmpresaExcluidos}.`);

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
 * Sync del mes actual: del 1 al último día del mes (incluye facturas con
 * `fa_fecha` futura del mes en curso). Antes recortaba a hoy y dejaba afuera
 * las facturas anticipadas, generando diff residual con Comisiones (que
 * consulta el mes entero). Cada corrida del cron (cada 30 min) vuelve a
 * refrescar el rango y los días futuros aparecen cuando IM los tiene.
 */
export async function syncVentasMesActual(opts?: { codEmpresa?: number }): Promise<SyncResult> {
  const now = new Date();
  const r = await syncVentasRango({
    desde: ymdMonthStart(),
    hasta: ymdMonthEnd(now.getUTCFullYear(), now.getUTCMonth() + 1),
    codEmpresa: opts?.codEmpresa ?? COD_EMPRESA_DEFAULT,
    label: 'mes-actual',
  });
  // El cron */30 actualiza vendor/client_sales_monthly del mes actual:
  // invalidar caches del mes para que la próxima carga vea el nuevo avance.
  if (r.ok) invalidateMonthCaches(now.getUTCFullYear(), now.getUTCMonth() + 1, opts?.codEmpresa);
  return r;
}

/**
 * Sync de un mes específico (entero, día 1 al último día). Para el mes en
 * curso incluye facturas con `fa_fecha` futura del mismo mes (ventas
 * anticipadas) — el cron lo refresca cada media hora.
 */
export async function syncVentasMes(year: number, month: number, opts?: { codEmpresa?: number }): Promise<SyncResult> {
  const desde = `${year}-${String(month).padStart(2, '0')}-01`;
  const hasta = ymdMonthEnd(year, month);
  return syncVentasRango({
    desde, hasta,
    codEmpresa: opts?.codEmpresa ?? COD_EMPRESA_DEFAULT,
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
    // Invalidar caches de este mes específico tras cada iteración exitosa.
    // Mejor que un invalidateAll al final: si fallamos a mitad de camino,
    // los meses que sí sincronizaron ya tienen cache fresco.
    if (r.ok) invalidateMonthCaches(y, m, opts?.codEmpresa);
  }
  return results;
}
