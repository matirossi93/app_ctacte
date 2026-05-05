import type { Request, Response } from 'express';
import XLSX from 'xlsx';
import { sb, TENANT_ID, hasSupabase } from './supabase.js';
import type { JwtPayload } from './auth.js';
import { invalidateAll as invalidateGoalsCache } from './goalsResponseCache.js';

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

// Normaliza un header de columna del XLSX para matching tolerante:
// "OBJETIVO O" → "objetivoo", "Razón Social" → "razon social", "  HR " → "hr".
function normHeader(s: any): string {
  if (s == null) return '';
  return String(s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // sin tildes
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Mapeo de nuestros campos lógicos → posibles nombres de header en el sheet.
// Si el sheet usa otro alias razonable, agregarlo acá. Sólo el primer match
// que aparezca en la fila 1 se usa.
const FIELD_ALIASES: Record<string, string[]> = {
  cod_cliente:     ['cod', 'cod cliente', 'codigo', 'codigo cliente', 'cliente'],
  cod_vendedor:    ['cod vend', 'cod vendedor', 'codigo vendedor'],
  razon_social:    ['razon social', 'razonsocial', 'cliente razon social'],
  direccion:       ['direccion', 'domicilio'],
  // dia_visita: aliases más específicos primero — sino "visita" matchea la
  // columna "VISITA" (estado) en vez de "Dia de visita" cuando ambas existen.
  dia_visita:      ['dia de visita', 'dia visita'],
  visita:          ['visita', 'estado visita'],
  frecuencia:      ['frecuencia'],
  localidad:       ['localidad'],
  hoja_ruta:       ['hr', 'hoja ruta', 'hoja de ruta'],
  repartidor:      ['repartidor'],
  dia_entrega:     ['dia de entrega', 'dia entrega'],
  cond_pago:       ['cond pago', 'condicion de pago', 'condicion pago'],
  tipo_abc:        ['tipo', 'tipo abc', 'abc'],
  saldo_cta_cte:   ['saldo', 'saldo cta cte', 'saldo cuenta corriente'],
  fact_prom_3m:    ['fact prom 3m', 'prom 3m', 'promedio 3m'],
  fact_mes_pasado: ['fact mes pasado', 'mes pasado'],
  // objetivo_mes acepta variantes: "OBJETIVO OK", "OBJETIVO O", "Objetivo Mes",
  // "Objetivo Original", etc. Si nada matchea por alias, se aplica fallback:
  // primer header que empiece con "objetivo" (ver buildFieldIndex).
  objetivo_mes:    ['objetivo ok', 'objetivo o', 'objetivo', 'objetivo mes', 'objetivo mensual', 'objetivo original'],
};

// Construye un map { campo_logico: indexColumna }. Sólo incluye campos cuyo
// header esté presente en la fila 1 — los ausentes se omiten del upsert para
// no sobrescribir con NULL columnas que ahora se cargan desde otra fuente
// (ej: saldo_cta_cte / fact_prom_3m / fact_mes_pasado vienen de syncVentas).
function buildFieldIndex(headerRow: any[]): Record<string, number> {
  const headerNorm = headerRow.map(normHeader);
  const idx: Record<string, number> = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      const i = headerNorm.indexOf(normHeader(alias));
      if (i !== -1) { idx[field] = i; break; }
    }
  }
  // Fallback para objetivo_mes: si ningún alias matchea, tomar el primer
  // header que empiece con "objetivo" (tolera renames futuros como "OBJETIVO X").
  if (idx.objetivo_mes == null) {
    const i = headerNorm.findIndex(h => h.startsWith('objetivo'));
    if (i !== -1) idx.objetivo_mes = i;
  }
  return idx;
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

  // Construir map { campo: indexColumna } leyendo la fila 1 del sheet.
  // Si una columna no aparece en el header, su campo se omite del upsert
  // (no se sobrescribe el valor previo en client_operational con NULL).
  const fieldIdx = buildFieldIndex(rows[0] || []);
  if (fieldIdx.cod_cliente == null) {
    res.status(400).json({
      error: 'No encontré la columna "Cod" (cod_cliente) en la fila 1 del sheet. Headers detectados: '
        + (rows[0] || []).map((h: any) => String(h).trim()).filter(Boolean).join(', '),
    });
    return;
  }
  if (fieldIdx.objetivo_mes == null) {
    res.status(400).json({
      error: 'No encontré columna de objetivo (busqué: OBJETIVO, OBJETIVO O, Objetivo Mes). Headers detectados: '
        + (rows[0] || []).map((h: any) => String(h).trim()).filter(Boolean).join(', '),
    });
    return;
  }

  // Helpers para leer un campo del row r tomando el índice del map dinámico.
  const getStr = (r: any[], field: string): string | null =>
    fieldIdx[field] != null ? toStr(r[fieldIdx[field]]) : null;
  const getInt = (r: any[], field: string): number | null =>
    fieldIdx[field] != null ? toInt(r[fieldIdx[field]]) : null;
  const getNum = (r: any[], field: string): number | null =>
    fieldIdx[field] != null ? toNum(r[fieldIdx[field]]) : null;

  // Lista de campos string/num/int que vamos a copiar SOLO si la columna existe.
  const STR_FIELDS: string[] = ['razon_social', 'direccion', 'dia_visita', 'visita', 'frecuencia', 'localidad', 'hoja_ruta', 'repartidor', 'dia_entrega', 'cond_pago', 'tipo_abc'];
  const NUM_FIELDS: string[] = ['saldo_cta_cte', 'fact_prom_3m', 'fact_mes_pasado'];

  const out: any[] = [];
  let descartadas = 0;
  let conObjetivo = 0;
  const updatedAt = new Date().toISOString();

  for (let i = 1; i < rows.length; i++) {
    const r: any[] = rows[i] || [];
    const cod = getInt(r, 'cod_cliente');
    if (!cod) { descartadas++; continue; }
    const objetivoMes = getNum(r, 'objetivo_mes');
    if (objetivoMes != null) conObjetivo++;
    const row: any = {
      tenant_id: TENANT_ID,
      cod_cliente: cod,
      objetivo_mes: objetivoMes,
      objetivo_source: 'sheet',
      objetivo_year: year,
      objetivo_month: month,
      updated_at: updatedAt,
    };
    // cod_vendedor sólo si está presente.
    if (fieldIdx.cod_vendedor != null) row.cod_vendedor = getInt(r, 'cod_vendedor');
    // Campos string/num: incluir sólo si la columna está en el sheet.
    for (const f of STR_FIELDS) if (fieldIdx[f] != null) row[f] = getStr(r, f);
    for (const f of NUM_FIELDS) if (fieldIdx[f] != null) row[f] = getNum(r, f);
    out.push(row);
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

  // Invalidar cache de respuestas de Objetivos: los nuevos objetivos por
  // cliente / vendedor entran a las próximas queries.
  invalidateGoalsCache();

  // Warning si vienen muchos rows sin objetivo: el sheet probablemente perdió
  // la columna o se desplazó. El import no falla pero la UI puede avisar para
  // que Matías corrija el sheet antes de la reunión.
  let warning: string | undefined;
  if (out.length > 0 && conObjetivo / out.length < 0.20) {
    warning = `Sólo ${conObjetivo} de ${out.length} clientes tienen objetivo cargado en el sheet. Revisá la columna "OBJETIVO" en la hoja "${sheetKey}" antes de seguir.`;
  }

  res.json({
    ok: errores.length === 0,
    year, month,
    es_mes_actual: esMesActual,
    rows_leidas: rows.length - 1,
    rows_importadas: okCount,
    rows_descartadas: descartadas,
    rows_con_objetivo: conObjetivo,
    history_imported: historyOk,
    headers_detectados: Object.keys(fieldIdx),
    warning,
    errores: errores.length ? errores : undefined,
  });
}
