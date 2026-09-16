import type { Request, Response } from 'express';
import { promises as fsp } from 'node:fs';
import axios from 'axios';
import XLSX from 'xlsx';
import { sb, TENANT_ID, hasSupabase } from './supabase.js';
import type { JwtPayload } from './auth.js';
import { invalidateAll as invalidateGoalsCache } from './goalsResponseCache.js';

const DEFAULT_SHEET_NAME = 'mes actual';
const SHEET_ID = '1k7B8Phi5QDn_6mFWiAfYBcqqisEWT6nqUwgmhE54Zy8';
const SHEET_GID = '145678139';
const SHEET_XLSX_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=xlsx`;

// Pestaña de la que Amira (los avisos automáticos de cobranza) saca el plazo de
// cuenta corriente: gid 2120998313 del mismo sheet. En SheetNames viene con un
// espacio al final — se matchea con trim().
const HOJA_PLAZOS = 'base de datos';
const COND_PAGO_CC = new Set(['cc', 'cuenta cte', 'cta cte', 'cuenta corriente']);

/**
 * Valida lo que devolvió el export de Google y lo entrega como Buffer.
 *
 * 🪤 Si el sheet deja de estar compartido, Google NO contesta 401: contesta
 * 200 con el HTML de la pantalla de login. Sin este chequeo, XLSX.read explota
 * con un "Unsupported file" críptico y nadie ata ese error a un permiso.
 */
export function bufferDeDescargaSheet(contentType: string, data: ArrayBuffer | Uint8Array): Buffer {
  if (/text\/html/i.test(String(contentType ?? ''))) {
    throw new Error(
      'El sheet Maestro Clientes no está compartido públicamente (Google devolvió la pantalla de login). '
      + 'Compartilo como "cualquiera con el link puede ver" o subí el XLSX a mano.',
    );
  }
  // Buffer extiende Uint8Array, así que esta rama cubre también lo que devuelve
  // axios en Node; la otra es para un ArrayBuffer pelado.
  return data instanceof Uint8Array ? Buffer.from(data) : Buffer.from(new Uint8Array(data));
}

/**
 * Baja el Maestro Clientes del export público del sheet, sin pedir el archivo.
 *
 * Por qué: el import exigía descargar el sheet a mano y subirlo, y ese paso
 * manual es justo donde la copia de client_operational se quedaba vieja.
 * Mismo patrón que syncRebotes (axios + export?format=xlsx). Bajamos el libro
 * entero — no una pestaña — para que siga andando el import histórico por hoja.
 */
async function bajarMaestroDelSheet(): Promise<Buffer> {
  // 60s: el libro pesa ~1 MB (el de rebotes, que usa 30s, pesa 61 KB).
  const resp = await axios.get(SHEET_XLSX_URL, { responseType: 'arraybuffer', timeout: 60000, maxRedirects: 10 });
  return bufferDeDescargaSheet(String(resp.headers?.['content-type'] ?? ''), resp.data);
}

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
export function buildFieldIndex(headerRow: any[]): Record<string, number> {
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

// Campos string/num que copiamos SOLO si la columna existe en el sheet (los
// ausentes se omiten del upsert para no pisar con NULL columnas que ahora se
// cargan desde otra fuente, ej: saldo_cta_cte / fact_prom_3m vienen de syncVentas).
const STR_FIELDS: string[] = ['razon_social', 'direccion', 'dia_visita', 'visita', 'frecuencia', 'localidad', 'hoja_ruta', 'repartidor', 'dia_entrega', 'cond_pago', 'tipo_abc'];
const NUM_FIELDS: string[] = ['saldo_cta_cte', 'fact_prom_3m', 'fact_mes_pasado'];

/**
 * Plazo de cuenta corriente por cliente, con EL MISMO criterio que Amira:
 * Cond Pago ∈ {cc, cuenta cte, cta cte, cuenta corriente} + columna VISITA en
 * {7, 15}. El resto no tiene plazo pactado y queda afuera.
 *
 * Por qué se lee de otra hoja: la pestaña "mes actual" perdió los clientes de
 * 7 días entre abril y mayo/2026 (abril tenía 64, de mayo en adelante ninguno),
 * así que hoy deja 64 clientes de cta cte sin plazo. La hoja BASE DE DATOS es
 * la que leía el script de cobranzas y mantiene el dato: 134 de 135. Cruzadas
 * las dos no se contradicen en ningún cliente — a "mes actual" sólo le faltan.
 *
 * 🪤 "Frecuencia" NO es el plazo: usar esa columna mandó 6 avisos de cobranza
 * indebidos el 02/07/2026. El plazo es "VISITA".
 */
export function plazosDeCuentaCorriente(rows: any[][]): Map<number, string> {
  const H = (rows[0] || []).map(normHeader);
  const iCod = H.indexOf('cod'), iCondPago = H.indexOf('cond pago'), iVisita = H.indexOf('visita');
  const plazos = new Map<number, string>();
  if (iCod === -1 || iCondPago === -1 || iVisita === -1) return plazos;
  for (let i = 1; i < rows.length; i++) {
    const r: any[] = rows[i] || [];
    const cod = toInt(r[iCod]);
    if (!cod) continue;
    if (!COND_PAGO_CC.has(String(r[iCondPago] ?? '').trim().toLowerCase())) continue;
    // El ".0" aparece cuando la celda viene como número flotante ("7.0").
    const visita = String(r[iVisita] ?? '').trim().replace(/\.0$/, '');
    if (visita === '7' || visita === '15') plazos.set(cod, visita);
  }
  return plazos;
}

/**
 * Completa el plazo de las filas que la hoja principal dejó vacías. NO pisa lo
 * que ya venía cargado: si "mes actual" dice algo, gana esa hoja. Devuelve
 * cuántas filas se completaron.
 */
export function completarPlazosFaltantes(out: any[], plazos: Map<number, string>): number {
  let completados = 0;
  for (const row of out) {
    if (row.visita) continue;
    const plazo = plazos.get(row.cod_cliente);
    if (!plazo) continue;
    row.visita = plazo;
    completados++;
  }
  return completados;
}

export interface BuiltMaestroRows {
  out: any[];
  descartadas: number;
  conObjetivo: number;
  dupCods: number[];
}

/**
 * Construye las filas a upsertear desde el sheet, DEDUPLICANDO por cod_cliente.
 *
 * Por qué deduplicar: un Maestro con un código repetido (típico error de carga
 * — la misma fila pegada dos veces) rompía el import entero. El batch llevaba
 * dos filas con la misma clave de conflicto y Postgres tira
 * "ON CONFLICT DO UPDATE command cannot affect row a second time", que volvía
 * con ok:false y la UI mostraba un críptico "HTTP 200" (incidente 30/06:
 * clientes 742 y 1193 cargados 2× → import de Julio bloqueado).
 *
 * Nos quedamos con la ÚLTIMA aparición de cada código (last-write-wins) y
 * devolvemos los códigos que venían duplicados para avisar en la UI.
 */
export function buildMaestroRows(
  rows: any[][],
  fieldIdx: Record<string, number>,
  opts: { tenantId: string; year: number; month: number; updatedAt: string },
): BuiltMaestroRows {
  const getStr = (r: any[], field: string): string | null =>
    fieldIdx[field] != null ? toStr(r[fieldIdx[field]]) : null;
  const getInt = (r: any[], field: string): number | null =>
    fieldIdx[field] != null ? toInt(r[fieldIdx[field]]) : null;
  const getNum = (r: any[], field: string): number | null =>
    fieldIdx[field] != null ? toNum(r[fieldIdx[field]]) : null;

  const byCod = new Map<number, any>();
  const dupCods = new Set<number>();
  let descartadas = 0;

  for (let i = 1; i < rows.length; i++) {
    const r: any[] = rows[i] || [];
    const cod = getInt(r, 'cod_cliente');
    if (!cod) { descartadas++; continue; }
    const row: any = {
      tenant_id: opts.tenantId,
      cod_cliente: cod,
      objetivo_mes: getNum(r, 'objetivo_mes'),
      objetivo_source: 'sheet',
      objetivo_year: opts.year,
      objetivo_month: opts.month,
      updated_at: opts.updatedAt,
    };
    // cod_vendedor sólo si está presente.
    if (fieldIdx.cod_vendedor != null) row.cod_vendedor = getInt(r, 'cod_vendedor');
    // Campos string/num: incluir sólo si la columna está en el sheet.
    for (const f of STR_FIELDS) if (fieldIdx[f] != null) row[f] = getStr(r, f);
    for (const f of NUM_FIELDS) if (fieldIdx[f] != null) row[f] = getNum(r, f);
    if (byCod.has(cod)) dupCods.add(cod);
    byCod.set(cod, row); // last-write-wins
  }

  const out = [...byCod.values()];
  const conObjetivo = out.filter(r => r.objetivo_mes != null).length;
  return { out, descartadas, conObjetivo, dupCods: [...dupCods] };
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
  // Sin archivo adjunto = "traer del sheet": bajamos el libro del export público
  // en vez de exigir el paso manual descargar → subir.
  const origen: 'archivo' | 'sheet' = file ? 'archivo' : 'sheet';

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
    let buf: Buffer | null;
    if (file) {
      // Multer ahora usa diskStorage: leer el XLSX del disco. El cleanup del
      // archivo lo hace el middleware cleanupUploadedFile en server.ts.
      buf = file.buffer ?? (file.path ? await fsp.readFile(file.path) : null);
      if (!buf) { res.status(400).json({ error: 'Archivo no disponible' }); return; }
    } else {
      buf = await bajarMaestroDelSheet();
    }
    wb = XLSX.read(buf, { type: 'buffer' });
  } catch (err: any) {
    const detalle = err?.message ?? err;
    res.status(400).json({
      error: origen === 'sheet' ? `No pude traer el sheet: ${detalle}` : `XLSX inválido: ${detalle}`,
    });
    return;
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

  // Construir y deduplicar las filas (last-write-wins por cod_cliente). Ver
  // buildMaestroRows: un código repetido en el sheet rompía el upsert entero.
  const updatedAt = new Date().toISOString();
  const { out, descartadas, conObjetivo, dupCods } = buildMaestroRows(
    rows, fieldIdx, { tenantId: TENANT_ID, year, month, updatedAt },
  );

  // Completar el plazo de cta cte desde la hoja BASE DE DATOS (la fuente de los
  // avisos de cobranza). Sin esto, los clientes de 7 días quedan sin plazo y su
  // factura sale sin fecha de vencimiento.
  const hojaPlazos = wb.SheetNames.find(n => n.trim().toLowerCase() === HOJA_PLAZOS);
  let plazosCompletados = 0;
  if (hojaPlazos) {
    const filasPlazos = XLSX.utils.sheet_to_json<any[]>(wb.Sheets[hojaPlazos], { header: 1, raw: true });
    plazosCompletados = completarPlazosFaltantes(out, plazosDeCuentaCorriente(filasPlazos));
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

  // Warnings (no bloquean el import, pero la UI los muestra para que Matías
  // limpie el sheet antes de la reunión).
  const warnings: string[] = [];
  // 1) Códigos repetidos en el sheet: importamos la última aparición de cada uno.
  // La lista se capea a 20 códigos para que un sheet muy roto no genere un
  // warning de miles de caracteres en la UI.
  if (dupCods.length > 0) {
    const MAX_DUP_LIST = 20;
    const listado = dupCods.slice(0, MAX_DUP_LIST).join(', ')
      + (dupCods.length > MAX_DUP_LIST ? ` y ${dupCods.length - MAX_DUP_LIST} más` : '');
    warnings.push(
      `El sheet tenía ${dupCods.length} código(s) de cliente repetido(s) (${listado}). `
      + `Importé la última fila de cada uno; limpiá las filas duplicadas en la hoja "${sheetKey}".`,
    );
  }
  // 2) Falta la hoja de plazos: las facturas de cta cte salen sin vencimiento.
  if (!hojaPlazos) {
    warnings.push(
      `No encontré la hoja "BASE DE DATOS" en el sheet: los clientes de cuenta corriente `
      + `sin VISITA en "${sheetKey}" quedan sin plazo y su factura sale sin fecha de vencimiento.`,
    );
  }
  // 3) Muchos rows sin objetivo: el sheet probablemente perdió la columna o se desplazó.
  if (out.length > 0 && conObjetivo / out.length < 0.20) {
    warnings.push(
      `Sólo ${conObjetivo} de ${out.length} clientes tienen objetivo cargado en el sheet. `
      + `Revisá la columna "OBJETIVO" en la hoja "${sheetKey}" antes de seguir.`,
    );
  }
  const warning: string | undefined = warnings.length ? warnings.join(' · ') : undefined;

  res.json({
    ok: errores.length === 0,
    year, month,
    origen,
    es_mes_actual: esMesActual,
    rows_leidas: rows.length - 1,
    rows_importadas: okCount,
    rows_descartadas: descartadas,
    // Filas pisadas por el dedup (N-1 por código repetido): mantiene la
    // invariante leidas = importadas + descartadas + duplicadas.
    rows_duplicadas: (rows.length - 1) - out.length - descartadas,
    rows_con_objetivo: conObjetivo,
    plazos_completados: plazosCompletados,
    history_imported: historyOk,
    headers_detectados: Object.keys(fieldIdx),
    warning,
    errores: errores.length ? errores : undefined,
  });
}
