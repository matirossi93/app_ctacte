import type { Request, Response } from 'express';
import XLSX from 'xlsx';
import { sb, TENANT_ID, hasSupabase } from './supabase.js';
import type { JwtPayload } from './auth.js';

const DEFAULT_SHEET_NAME = 'mes actual';
const SHEET_ID = '1k7B8Phi5QDn_6mFWiAfYBcqqisEWT6nqUwgmhE54Zy8';
const SHEET_GID = '145678139';

function toInt(v: any): number | null {
  if (v == null) return null;
  const n = parseInt(v);
  return isNaN(n) ? null : n;
}
function toNum(v: any): number | null {
  if (v == null) return null;
  const n = Number(v);
  return isFinite(n) ? Math.round(n * 100) / 100 : null;
}
function toStr(v: any): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

/**
 * POST /api/sheet-import/maestro-clientes
 * Multipart: file=<xlsx>, year?, month?
 * Solo admin/gerente (enforced por requireAdmin en la ruta).
 *
 * Lee hoja "mes actual" del XLSX y upsertea a client_operational
 * con objetivo_source='sheet' + objetivo_year/month del request (default = mes actual).
 */
export async function importMaestroClientes(req: Request & { user?: JwtPayload; file?: any }, res: Response) {
  if (!hasSupabase()) { res.status(500).json({ error: 'Supabase no configurado' }); return; }
  const user = req.user!;
  const file = req.file;
  if (!file) { res.status(400).json({ error: 'Archivo XLSX requerido (campo "file")' }); return; }

  const now = new Date();
  const year = req.body?.year ? Number(req.body.year) : now.getUTCFullYear();
  const month = req.body?.month ? Number(req.body.month) : now.getUTCMonth() + 1;
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    res.status(400).json({ error: 'year/month inválidos' }); return;
  }
  // Hoja del XLSX a leer. Default "mes actual" para imports del mes en curso.
  // Para imports históricos (Enero, Febrero, marzo) se pasa el nombre de la hoja
  // del Maestro Clientes que tiene ese snapshot mensual.
  const hojaName = String(req.body?.hoja ?? DEFAULT_SHEET_NAME).trim() || DEFAULT_SHEET_NAME;

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(file.buffer, { type: 'buffer' });
  } catch (err: any) {
    res.status(400).json({ error: `XLSX inválido: ${err?.message ?? err}` }); return;
  }

  // Match case-insensitive de la hoja para tolerar "marzo" vs "Marzo" vs "MARZO".
  const sheetKey = wb.SheetNames.find(n => n.toLowerCase().trim() === hojaName.toLowerCase().trim()) ?? hojaName;
  const ws = wb.Sheets[sheetKey];
  if (!ws) {
    res.status(400).json({ error: `Hoja "${hojaName}" no encontrada. Hojas disponibles: ${wb.SheetNames.join(', ')}` });
    return;
  }
  const rows = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, raw: true });
  if (rows.length < 2) { res.status(400).json({ error: 'Hoja vacía' }); return; }

  // ¿El import es para el mes en curso o para un mes pasado?
  // - Mes actual → escribimos en client_operational + client_objectives_history.
  // - Mes histórico → SOLO history. Tocar client_operational con datos de un mes
  //   pasado pisa los objetivo_year/month vivos y rompe la vista actual
  //   (incidente real 28/04: import enero pisó client_operational, abril
  //   pasó a mostrar todos los clientes como "sin objetivo").
  const nowYM = new Date();
  const esMesActual = year === nowYM.getUTCFullYear() && month === (nowYM.getUTCMonth() + 1);

  const out: any[] = [];
  let descartadas = 0;
  const updatedAt = new Date().toISOString();

  for (let i = 1; i < rows.length; i++) {
    const r: any[] = rows[i] || [];
    const cod = toInt(r[0]);
    if (!cod) { descartadas++; continue; }
    out.push({
      tenant_id: TENANT_ID,
      cod_cliente: cod,
      cod_vendedor: toInt(r[1]),
      razon_social: toStr(r[3]),
      direccion: toStr(r[4]),
      dia_visita: toStr(r[5]),
      visita: toStr(r[6]),
      frecuencia: toStr(r[7]),
      localidad: toStr(r[8]),
      hoja_ruta: toStr(r[9]),
      repartidor: toStr(r[10]),
      dia_entrega: toStr(r[11]),
      cond_pago: toStr(r[12]),
      tipo_abc: toStr(r[13]),
      saldo_cta_cte: toNum(r[14]),
      fact_prom_3m: toNum(r[15]),
      fact_mes_pasado: toNum(r[16]),
      objetivo_mes: toNum(r[17]),
      objetivo_source: 'sheet',
      objetivo_year: year,
      objetivo_month: month,
      updated_at: updatedAt,
    });
  }

  // Upsert por batches a client_operational SOLO si es el mes actual.
  // En histórico, esa tabla NO debe tocarse: representa el snapshot vivo.
  const BATCH = 200;
  let okCount = 0;
  const errores: Array<{ batch: number; error: string }> = [];
  if (esMesActual) {
    for (let i = 0; i < out.length; i += BATCH) {
      const chunk = out.slice(i, i + BATCH);
      const { error } = await sb().from('client_operational').upsert(chunk, { onConflict: 'tenant_id,cod_cliente' });
      if (error) errores.push({ batch: i, error: error.message });
      else okCount += chunk.length;
    }
  } else {
    // Histórico: contamos las filas que hubieran ido a operational, para visibilidad.
    okCount = out.length;
  }

  // Snapshot histórico de objetivos por (cliente, año, mes).
  // client_operational guarda solo el mes en curso — se sobrescribe al importar
  // el siguiente mes. Esta tabla preserva el objetivo de cada cliente para
  // poder consultar meses pasados desde reportes/ObjetivosView.
  const historyRows = out.map(r => ({
    tenant_id: TENANT_ID,
    cod_cliente: r.cod_cliente,
    year, month,
    cod_vendedor: r.cod_vendedor,
    objetivo_mes: r.objetivo_mes,
    objetivo_source: 'sheet' as const,
    fact_mes_pasado: r.fact_mes_pasado,
    fact_prom_3m: r.fact_prom_3m,
    tipo_abc: r.tipo_abc,
    imported_by: user.sub,
  }));
  let historyOk = 0;
  for (let i = 0; i < historyRows.length; i += BATCH) {
    const chunk = historyRows.slice(i, i + BATCH);
    const { error } = await sb()
      .from('client_objectives_history')
      .upsert(chunk, { onConflict: 'tenant_id,cod_cliente,year,month' });
    if (error) errores.push({ batch: i, error: `history: ${error.message}` });
    else historyOk += chunk.length;
  }

  // Log del import.
  try {
    await sb().from('sheet_import_log').insert({
      tenant_id: TENANT_ID,
      sheet_id: SHEET_ID,
      gid: SHEET_GID,
      hoja: sheetKey,
      year, month,
      rows_leidas: rows.length - 1,
      rows_importadas: okCount,
      rows_descartadas: descartadas,
      errores: errores.length ? errores : null,
      finished_at: new Date().toISOString(),
      imported_by: user.sub,
    });
  } catch { /* log best-effort */ }

  res.json({
    ok: errores.length === 0,
    year, month,
    es_mes_actual: esMesActual,
    rows_leidas: rows.length - 1,
    rows_importadas: okCount,
    rows_descartadas: descartadas,
    history_imported: historyOk,
    errores: errores.length ? errores : undefined,
  });
}
