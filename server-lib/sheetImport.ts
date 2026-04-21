import type { Request, Response } from 'express';
import XLSX from 'xlsx';
import { sb, TENANT_ID, hasSupabase } from './supabase.js';
import type { JwtPayload } from './auth.js';

const SHEET_NAME = 'mes actual';
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

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(file.buffer, { type: 'buffer' });
  } catch (err: any) {
    res.status(400).json({ error: `XLSX inválido: ${err?.message ?? err}` }); return;
  }

  const ws = wb.Sheets[SHEET_NAME];
  if (!ws) {
    res.status(400).json({ error: `Hoja "${SHEET_NAME}" no encontrada. Hojas: ${wb.SheetNames.join(', ')}` });
    return;
  }
  const rows = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, raw: true });
  if (rows.length < 2) { res.status(400).json({ error: 'Hoja vacía' }); return; }

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

  // Upsert por batches.
  const BATCH = 200;
  let okCount = 0;
  const errores: Array<{ batch: number; error: string }> = [];
  for (let i = 0; i < out.length; i += BATCH) {
    const chunk = out.slice(i, i + BATCH);
    const { error } = await sb().from('client_operational').upsert(chunk, { onConflict: 'tenant_id,cod_cliente' });
    if (error) errores.push({ batch: i, error: error.message });
    else okCount += chunk.length;
  }

  // Log del import.
  try {
    await sb().from('sheet_import_log').insert({
      tenant_id: TENANT_ID,
      sheet_id: SHEET_ID,
      gid: SHEET_GID,
      hoja: SHEET_NAME,
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
    rows_leidas: rows.length - 1,
    rows_importadas: okCount,
    rows_descartadas: descartadas,
    errores: errores.length ? errores : undefined,
  });
}
