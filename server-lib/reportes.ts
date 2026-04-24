import * as XLSX from 'xlsx';
import type { Request, Response } from 'express';
import { sb, TENANT_ID } from './supabase.js';
import type { JwtPayload } from './auth.js';

// ═══════════════════════════════════════════════════════════════════════════
// Reportes — export xlsx admin-only para analisis ad-hoc
// ═══════════════════════════════════════════════════════════════════════════

interface Sheet { headers: string[]; rows: (string | number | null)[][]; }

function today(): { year: number; month: number } {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

async function vendorNameMap(): Promise<Map<number, string>> {
  const { data } = await sb().from('usuarios')
    .select('cod_vendedor, nombre')
    .eq('tenant_id', TENANT_ID)
    .not('cod_vendedor', 'is', null);
  const m = new Map<number, string>();
  (data ?? []).forEach((r: any) => {
    if (r.cod_vendedor != null) m.set(Number(r.cod_vendedor), r.nombre || `cod ${r.cod_vendedor}`);
  });
  return m;
}

/**
 * Clientes con objetivo $0 (o sin objetivo seteado) para el mes indicado.
 * Incluye: objetivo_mes = 0, null, o con año/mes distinto (rollover no aplicado).
 */
async function reporteTargetCero(year: number, month: number): Promise<Sheet> {
  const { data, error } = await sb().from('client_operational')
    .select('cod_cliente, razon_social, localidad, cod_vendedor, tipo_abc, frecuencia, dia_visita, objetivo_mes, objetivo_year, objetivo_month, fact_mes_pasado, fact_prom_3m, saldo_cta_cte')
    .eq('tenant_id', TENANT_ID)
    .limit(5000);
  if (error) throw new Error(error.message);
  const vmap = await vendorNameMap();

  const rows: (string | number | null)[][] = [];
  for (const c of data ?? []) {
    const matches = c.objetivo_year === year && c.objetivo_month === month;
    const obj = matches ? Number(c.objetivo_mes ?? 0) : 0;
    if (obj > 0) continue;
    rows.push([
      c.cod_cliente,
      c.razon_social ?? '',
      c.localidad ?? '',
      c.cod_vendedor ?? null,
      vmap.get(Number(c.cod_vendedor)) ?? '',
      c.tipo_abc ?? '',
      c.frecuencia ?? '',
      c.dia_visita ?? '',
      matches ? Number(c.objetivo_mes ?? 0) : 0,
      c.fact_mes_pasado != null ? Number(c.fact_mes_pasado) : null,
      c.fact_prom_3m != null ? Number(c.fact_prom_3m) : null,
      c.saldo_cta_cte != null ? Number(c.saldo_cta_cte) : null,
      matches ? 'objetivo_cero' : 'objetivo_sin_setear',
    ]);
  }
  rows.sort((a: any, b: any) => (b[11] ?? 0) - (a[11] ?? 0)); // por saldo desc
  return {
    headers: ['cod_cliente', 'razon_social', 'localidad', 'cod_vendedor', 'vendedor', 'tipo_abc', 'frecuencia', 'dia_visita', 'objetivo_mes', 'fact_mes_pasado', 'fact_prom_3m', 'saldo_cta_cte', 'motivo'],
    rows,
  };
}

/**
 * Matriz target vs real por cliente del mes. Incluye todos los clientes con
 * target > 0 o con facturacion > 0 en el mes. diff = real - target. pct = real/target.
 */
async function reporteMatrizTargetReal(year: number, month: number): Promise<Sheet> {
  const [{ data: clientes, error: eC }, { data: sales, error: eS }] = await Promise.all([
    sb().from('client_operational')
      .select('cod_cliente, razon_social, localidad, cod_vendedor, tipo_abc, objetivo_mes, objetivo_year, objetivo_month')
      .eq('tenant_id', TENANT_ID)
      .limit(5000),
    sb().from('client_sales_monthly')
      .select('cod_cliente, neto, num_comprobantes')
      .eq('tenant_id', TENANT_ID).eq('year', year).eq('month', month),
  ]);
  if (eC) throw new Error(eC.message);
  if (eS) throw new Error(eS.message);
  const vmap = await vendorNameMap();
  const salesBy = new Map<number, { neto: number; num: number }>();
  (sales ?? []).forEach((s: any) => salesBy.set(s.cod_cliente, { neto: Number(s.neto) || 0, num: s.num_comprobantes || 0 }));

  const rows: (string | number | null)[][] = [];
  for (const c of clientes ?? []) {
    const matches = c.objetivo_year === year && c.objetivo_month === month;
    const target = matches ? Number(c.objetivo_mes ?? 0) : 0;
    const s = salesBy.get(c.cod_cliente);
    const real = s?.neto ?? 0;
    if (target === 0 && real === 0) continue;
    const diff = real - target;
    const pct = target > 0 ? real / target : null;
    const status = target === 0 ? 'sin_target'
      : real === 0 ? 'sin_compras'
      : real >= target ? 'completado'
      : 'parcial';
    rows.push([
      c.cod_cliente,
      c.razon_social ?? '',
      c.localidad ?? '',
      c.cod_vendedor ?? null,
      vmap.get(Number(c.cod_vendedor)) ?? '',
      c.tipo_abc ?? '',
      target,
      real,
      diff,
      pct,
      s?.num ?? 0,
      status,
    ]);
  }
  rows.sort((a: any, b: any) => (b[6] ?? 0) - (a[6] ?? 0)); // por target desc
  return {
    headers: ['cod_cliente', 'razon_social', 'localidad', 'cod_vendedor', 'vendedor', 'tipo_abc', 'target', 'real', 'diff', 'pct_cumplimiento', 'num_comprobantes', 'status'],
    rows,
  };
}

/**
 * Clientes sin actividad registrada en los ultimos 30 dias.
 * Considera activity (nota/llamada/promesa/pago/visita) + sales_monthly (compras).
 * Filtra a los "que importan": target > 0 o saldo > 1000 o facturacion historica > 0.
 */
async function reporteSinActividad30d(year: number, month: number): Promise<Sheet> {
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const [{ data: clientes, error: eC }, { data: actividad, error: eA }, { data: sales, error: eS }] = await Promise.all([
    sb().from('client_operational')
      .select('cod_cliente, razon_social, localidad, cod_vendedor, tipo_abc, objetivo_mes, objetivo_year, objetivo_month, fact_mes_pasado, fact_prom_3m, saldo_cta_cte')
      .eq('tenant_id', TENANT_ID)
      .limit(5000),
    sb().from('vendor_activity')
      .select('cod_cliente, created_at')
      .eq('tenant_id', TENANT_ID)
      .gte('created_at', cutoff),
    sb().from('client_sales_monthly')
      .select('cod_cliente, neto')
      .eq('tenant_id', TENANT_ID).eq('year', year).eq('month', month),
  ]);
  if (eC) throw new Error(eC.message);
  if (eA) throw new Error(eA.message);
  if (eS) throw new Error(eS.message);
  const vmap = await vendorNameMap();
  const ultimaActPorCliente = new Map<number, string>();
  (actividad ?? []).forEach((a: any) => {
    if (a.cod_cliente == null) return;
    const prev = ultimaActPorCliente.get(a.cod_cliente);
    if (!prev || a.created_at > prev) ultimaActPorCliente.set(a.cod_cliente, a.created_at);
  });
  const salesBy = new Map<number, number>();
  (sales ?? []).forEach((s: any) => salesBy.set(s.cod_cliente, Number(s.neto) || 0));

  const rows: (string | number | null)[][] = [];
  for (const c of clientes ?? []) {
    const matches = c.objetivo_year === year && c.objetivo_month === month;
    const target = matches ? Number(c.objetivo_mes ?? 0) : 0;
    const saldo = Number(c.saldo_cta_cte ?? 0);
    const factProm = Number(c.fact_prom_3m ?? 0);
    // Filtra los "que importan"
    if (target <= 0 && saldo <= 1000 && factProm <= 0) continue;
    // Si tuvo actividad reciente, skip
    if (ultimaActPorCliente.has(c.cod_cliente)) continue;
    // Si tuvo compras en el mes actual, tambien skip (aunque no haya nota)
    if ((salesBy.get(c.cod_cliente) ?? 0) > 0) continue;
    rows.push([
      c.cod_cliente,
      c.razon_social ?? '',
      c.localidad ?? '',
      c.cod_vendedor ?? null,
      vmap.get(Number(c.cod_vendedor)) ?? '',
      c.tipo_abc ?? '',
      target,
      saldo,
      factProm,
      c.fact_mes_pasado != null ? Number(c.fact_mes_pasado) : null,
    ]);
  }
  // Orden: por factProm desc (los mas importantes arriba)
  rows.sort((a: any, b: any) => (b[8] ?? 0) - (a[8] ?? 0));
  return {
    headers: ['cod_cliente', 'razon_social', 'localidad', 'cod_vendedor', 'vendedor', 'tipo_abc', 'objetivo_mes', 'saldo_cta_cte', 'fact_prom_3m', 'fact_mes_pasado'],
    rows,
  };
}

function buildXlsx(sheetName: string, sheet: Sheet): Buffer {
  const wb = XLSX.utils.book_new();
  const aoa = [sheet.headers, ...sheet.rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // Autowidth basado en headers + primera fila
  const widths = sheet.headers.map((h, i) => {
    const maxData = sheet.rows.reduce((m, r) => Math.max(m, String(r[i] ?? '').length), 0);
    return { wch: Math.min(Math.max(h.length, maxData) + 2, 40) };
  });
  ws['!cols'] = widths;
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * GET /api/reportes/:tipo.xlsx — descarga xlsx (admin/gerente)
 * Tipos: target-cero | matriz-target-real | sin-actividad-30d
 * Query: year, month (default: mes en curso)
 */
export async function descargarReporte(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const user = req.user!;
    if (user.rol !== 'admin' && user.rol !== 'gerente') {
      res.status(403).json({ error: 'Requiere admin/gerente' });
      return;
    }
    const t = today();
    const year = Number(req.query.year) || t.year;
    const month = Number(req.query.month) || t.month;
    const tipoRaw = String(req.params.tipo).replace(/\.xlsx$/, '');

    let sheet: Sheet;
    let sheetName: string;
    let fileName: string;
    const mm = String(month).padStart(2, '0');

    switch (tipoRaw) {
      case 'target-cero':
        sheet = await reporteTargetCero(year, month);
        sheetName = `Target Cero ${mm}-${year}`;
        fileName = `clientes-target-cero-${year}-${mm}.xlsx`;
        break;
      case 'matriz-target-real':
        sheet = await reporteMatrizTargetReal(year, month);
        sheetName = `Target vs Real ${mm}-${year}`;
        fileName = `matriz-target-real-${year}-${mm}.xlsx`;
        break;
      case 'sin-actividad-30d':
        sheet = await reporteSinActividad30d(year, month);
        sheetName = `Sin Actividad 30d`;
        fileName = `clientes-sin-actividad-30d-${year}-${mm}.xlsx`;
        break;
      default:
        res.status(400).json({ error: `Tipo desconocido: ${tipoRaw}` });
        return;
    }

    const buf = buildXlsx(sheetName, sheet);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('X-Report-Rows', String(sheet.rows.length));
    res.send(buf);
  } catch (err: any) {
    console.error('descargarReporte error:', err);
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}
