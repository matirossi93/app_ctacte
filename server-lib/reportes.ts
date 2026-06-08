import * as XLSX from 'xlsx';
import type { Request, Response } from 'express';
import { sb, TENANT_ID } from './supabase.js';
import type { JwtPayload } from './auth.js';
import { fetchComprobPendientes } from './infomanager.js';

// ═══════════════════════════════════════════════════════════════════════════
// Reportes — export xlsx admin-only para analisis ad-hoc
// ═══════════════════════════════════════════════════════════════════════════

interface Sheet { headers: string[]; rows: (string | number | null)[][]; }

function today(): { year: number; month: number } {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

function isHistoric(year: number, month: number): boolean {
  const t = today();
  return !(year === t.year && month === t.month);
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
 * Mapa cod_cliente → objetivo del mes consultado.
 * Para mes en curso lee client_operational (con rollover guard).
 * Para mes histórico lee client_objectives_history.
 */
type ObjetivoRow = { objetivo_mes: number; cod_vendedor: number | null; fact_mes_pasado: number | null; fact_prom_3m: number | null; tipo_abc: string | null };
async function getObjetivosPorCliente(year: number, month: number): Promise<Map<number, ObjetivoRow>> {
  const m = new Map<number, ObjetivoRow>();
  if (isHistoric(year, month)) {
    const { data } = await sb().from('client_objectives_history')
      .select('cod_cliente, cod_vendedor, objetivo_mes, fact_mes_pasado, fact_prom_3m, tipo_abc')
      .eq('tenant_id', TENANT_ID)
      .eq('year', year).eq('month', month)
      .limit(5000);
    (data ?? []).forEach((r: any) => {
      m.set(Number(r.cod_cliente), {
        objetivo_mes: Number(r.objetivo_mes ?? 0),
        cod_vendedor: r.cod_vendedor ?? null,
        fact_mes_pasado: r.fact_mes_pasado != null ? Number(r.fact_mes_pasado) : null,
        fact_prom_3m: r.fact_prom_3m != null ? Number(r.fact_prom_3m) : null,
        tipo_abc: r.tipo_abc ?? null,
      });
    });
  } else {
    const { data } = await sb().from('client_operational')
      .select('cod_cliente, cod_vendedor, objetivo_mes, objetivo_year, objetivo_month, fact_mes_pasado, fact_prom_3m, tipo_abc')
      .eq('tenant_id', TENANT_ID)
      .limit(5000);
    (data ?? []).forEach((r: any) => {
      const matches = r.objetivo_year === year && r.objetivo_month === month;
      m.set(Number(r.cod_cliente), {
        objetivo_mes: matches ? Number(r.objetivo_mes ?? 0) : 0,
        cod_vendedor: r.cod_vendedor ?? null,
        fact_mes_pasado: r.fact_mes_pasado != null ? Number(r.fact_mes_pasado) : null,
        fact_prom_3m: r.fact_prom_3m != null ? Number(r.fact_prom_3m) : null,
        tipo_abc: r.tipo_abc ?? null,
      });
    });
  }
  return m;
}

/**
 * Clientes con objetivo $0 (o sin objetivo seteado) para el mes indicado.
 * Incluye: objetivo_mes = 0, null, o (mes en curso) con año/mes distinto.
 *
 * Para meses históricos lee objetivos desde client_objectives_history.
 * El saldo_cta_cte siempre es del presente (no se historiza) y solo se incluye
 * para el mes en curso; para histórico se reporta null.
 */
async function reporteTargetCero(year: number, month: number): Promise<Sheet> {
  const histo = isHistoric(year, month);
  const { data, error } = await sb().from('client_operational')
    .select('cod_cliente, razon_social, localidad, cod_vendedor, tipo_abc, frecuencia, dia_visita, saldo_cta_cte')
    .eq('tenant_id', TENANT_ID)
    .limit(5000);
  if (error) throw new Error(error.message);
  const [vmap, objMap] = await Promise.all([vendorNameMap(), getObjetivosPorCliente(year, month)]);

  const rows: (string | number | null)[][] = [];
  for (const c of data ?? []) {
    const o = objMap.get(Number(c.cod_cliente));
    const obj = o?.objetivo_mes ?? 0;
    if (obj > 0) continue;
    const codVend = o?.cod_vendedor ?? c.cod_vendedor ?? null;
    rows.push([
      c.cod_cliente,
      c.razon_social ?? '',
      c.localidad ?? '',
      codVend,
      codVend != null ? (vmap.get(Number(codVend)) ?? '') : '',
      o?.tipo_abc ?? c.tipo_abc ?? '',
      c.frecuencia ?? '',
      c.dia_visita ?? '',
      obj,
      o?.fact_mes_pasado ?? null,
      o?.fact_prom_3m ?? null,
      // saldo cta cte solo aplica al mes en curso
      histo ? null : (c.saldo_cta_cte != null ? Number(c.saldo_cta_cte) : null),
      o ? 'objetivo_cero' : 'objetivo_sin_setear',
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
 *
 * Para meses históricos: target sale de client_objectives_history; vendedor
 * efectivo también se toma del snapshot histórico (puede haber cambiado).
 */
async function reporteMatrizTargetReal(year: number, month: number): Promise<Sheet> {
  const [{ data: clientes, error: eC }, { data: sales, error: eS }, vmap, objMap] = await Promise.all([
    sb().from('client_operational')
      .select('cod_cliente, razon_social, localidad, cod_vendedor, tipo_abc')
      .eq('tenant_id', TENANT_ID)
      .limit(5000),
    sb().from('client_sales_monthly')
      .select('cod_cliente, neto, num_comprobantes')
      .eq('tenant_id', TENANT_ID).eq('year', year).eq('month', month),
    vendorNameMap(),
    getObjetivosPorCliente(year, month),
  ]);
  if (eC) throw new Error(eC.message);
  if (eS) throw new Error(eS.message);
  const salesBy = new Map<number, { neto: number; num: number }>();
  (sales ?? []).forEach((s: any) => salesBy.set(s.cod_cliente, { neto: Number(s.neto) || 0, num: s.num_comprobantes || 0 }));

  const rows: (string | number | null)[][] = [];
  for (const c of clientes ?? []) {
    const o = objMap.get(Number(c.cod_cliente));
    const target = o?.objetivo_mes ?? 0;
    const s = salesBy.get(c.cod_cliente);
    const real = s?.neto ?? 0;
    if (target === 0 && real === 0) continue;
    const diff = real - target;
    const pct = target > 0 ? real / target : null;
    const status = target === 0 ? 'sin_target'
      : real === 0 ? 'sin_compras'
      : real >= target ? 'completado'
      : 'parcial';
    const codVend = o?.cod_vendedor ?? c.cod_vendedor ?? null;
    rows.push([
      c.cod_cliente,
      c.razon_social ?? '',
      c.localidad ?? '',
      codVend,
      codVend != null ? (vmap.get(Number(codVend)) ?? '') : '',
      o?.tipo_abc ?? c.tipo_abc ?? '',
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
 *
 * Nota: este reporte es contextual al "ahora" — la ventana de 30 días siempre
 * mira los últimos 30 días corridos. Para year/month históricos lo que cambia
 * es el target y el cruce con compras del mes consultado.
 */
async function reporteSinActividad30d(year: number, month: number): Promise<Sheet> {
  const histo = isHistoric(year, month);
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const [{ data: clientes, error: eC }, { data: actividad, error: eA }, { data: sales, error: eS }, vmap, objMap] = await Promise.all([
    sb().from('client_operational')
      .select('cod_cliente, razon_social, localidad, cod_vendedor, tipo_abc, saldo_cta_cte')
      .eq('tenant_id', TENANT_ID)
      .limit(5000),
    sb().from('vendor_activity')
      .select('cod_cliente, created_at')
      .eq('tenant_id', TENANT_ID)
      .gte('created_at', cutoff),
    sb().from('client_sales_monthly')
      .select('cod_cliente, neto')
      .eq('tenant_id', TENANT_ID).eq('year', year).eq('month', month),
    vendorNameMap(),
    getObjetivosPorCliente(year, month),
  ]);
  if (eC) throw new Error(eC.message);
  if (eA) throw new Error(eA.message);
  if (eS) throw new Error(eS.message);
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
    const o = objMap.get(Number(c.cod_cliente));
    const target = o?.objetivo_mes ?? 0;
    const saldo = Number(c.saldo_cta_cte ?? 0);
    const factProm = o?.fact_prom_3m ?? 0;
    // Filtra los "que importan"
    if (target <= 0 && saldo <= 1000 && factProm <= 0) continue;
    if (ultimaActPorCliente.has(c.cod_cliente)) continue;
    if ((salesBy.get(c.cod_cliente) ?? 0) > 0) continue;
    const codVend = o?.cod_vendedor ?? c.cod_vendedor ?? null;
    rows.push([
      c.cod_cliente,
      c.razon_social ?? '',
      c.localidad ?? '',
      codVend,
      codVend != null ? (vmap.get(Number(codVend)) ?? '') : '',
      o?.tipo_abc ?? c.tipo_abc ?? '',
      target,
      // saldo solo aplica al ahora; en histórico no es del corte.
      histo ? null : saldo,
      factProm,
      o?.fact_mes_pasado ?? null,
    ]);
  }
  // Orden: por factProm desc (los mas importantes arriba)
  rows.sort((a: any, b: any) => (b[8] ?? 0) - (a[8] ?? 0));
  return {
    headers: ['cod_cliente', 'razon_social', 'localidad', 'cod_vendedor', 'vendedor', 'tipo_abc', 'objetivo_mes', 'saldo_cta_cte', 'fact_prom_3m', 'fact_mes_pasado'],
    rows,
  };
}

/**
 * Residuos de centavos: facturas con saldo deudor POSITIVO chico (≤ maxSaldo),
 * que es lo que deja InfoManager al truncar a entero el importe imputado en los
 * recibos (ver server-lib/recibos.ts). Sirve para la limpieza/ajuste contable
 * en lote — IM no expone API de NC/ajuste, así que el cierre es manual en el
 * cliente desktop o por import. NO depende del período. Empresa 1 (casa central)
 * por default, igual que /api/data. Se excluyen saldos negativos (NC/recibos).
 *
 * OJO: un saldo chico puede ser deuda parcial legítima, no solo residuo de
 * truncado — el que ajusta revisa la lista antes de cerrar cada uno.
 */
async function reporteResiduos(maxSaldo: number, codEmpresa = 1): Promise<Sheet> {
  const [comprobantes, vmap] = await Promise.all([
    fetchComprobPendientes(codEmpresa, 0),
    vendorNameMap(),
  ]);
  const rows: (string | number | null)[][] = [];
  for (const c of comprobantes ?? []) {
    const saldo = Number((c as any).saldo) || 0;
    if (!(saldo > 0 && saldo <= maxSaldo)) continue;
    const codVend = (c as any).cod_vendedor != null ? Number((c as any).cod_vendedor) : null;
    rows.push([
      (c as any).cod_cliente ?? '',
      (c as any).nombre ?? '',
      codVend,
      codVend != null ? (vmap.get(codVend) ?? '') : '',
      (c as any).tipo_comprobante ?? '',
      `${(c as any).punto_de_venta ?? 0}-${(c as any).numero ?? 0}`,
      (c as any).fecha_factura ? String((c as any).fecha_factura).slice(0, 10) : '',
      Math.round(saldo * 100) / 100,
    ]);
  }
  // Agrupado visualmente por cliente (nombre asc), y dentro por saldo desc.
  rows.sort((a: any, b: any) =>
    String(a[1]).localeCompare(String(b[1])) || (Number(b[7]) - Number(a[7]))
  );
  return {
    headers: ['cod_cliente', 'razon_social', 'cod_vendedor', 'vendedor', 'tipo', 'comprobante', 'fecha_emision', 'saldo_residuo'],
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
      case 'residuos': {
        // No depende de year/month. Corte de saldo por ?max (default $50).
        const max = Number(req.query.max) > 0 ? Number(req.query.max) : 50;
        const empresa = Number(req.query.empresa) > 0 ? Number(req.query.empresa) : 1;
        sheet = await reporteResiduos(max, empresa);
        sheetName = `Residuos hasta $${max}`;
        fileName = `residuos-saldos-chicos-hasta-${max}.xlsx`;
        break;
      }
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
