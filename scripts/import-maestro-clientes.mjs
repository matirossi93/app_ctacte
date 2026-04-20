// Import del sheet "mes actual" (Maestro Clientes) → client_operational en Supabase.
// Usage:
//   node scripts/import-maestro-clientes.mjs <xlsx-path> [year] [month]
// Requiere .env con SUPABASE_URL, SUPABASE_SERVICE_KEY.
//
// Uso por el backend (server-lib/sheetImport.ts) — este script es para
// imports manuales / one-shot desde CLI.

import 'dotenv/config';
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import XLSX from 'xlsx';

const TENANT_ID = process.env.TENANT_ID || '00000000-0000-0000-0000-000000000001';
const SHEET_NAME = 'mes actual';

const args = process.argv.slice(2);
const xlsxPath = args[0];
const year = Number(args[1]) || new Date().getUTCFullYear();
const month = Number(args[2]) || new Date().getUTCMonth() + 1;

if (!xlsxPath || !fs.existsSync(xlsxPath)) {
  console.error(`xlsx no encontrado: ${xlsxPath}`);
  process.exit(1);
}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY no seteados');
  process.exit(1);
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
});

function toInt(v) { if (v == null) return null; const n = parseInt(v); return isNaN(n) ? null : n; }
function toNum(v) { if (v == null) return null; const n = Number(v); return isFinite(n) ? Math.round(n * 100) / 100 : null; }
function toStr(v) { if (v == null) return null; const s = String(v).trim(); return s || null; }

const wb = XLSX.readFile(xlsxPath);
const ws = wb.Sheets[SHEET_NAME];
if (!ws) {
  console.error(`Hoja "${SHEET_NAME}" no encontrada. Hojas: ${wb.SheetNames.join(', ')}`);
  process.exit(1);
}
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
const header = rows[0];
console.log(`Hoja: "${SHEET_NAME}"`);
console.log(`Header: ${header.slice(0, 20).join(' | ')}`);
console.log(`Total filas: ${rows.length - 1}`);

const out = [];
let desc = 0;
for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  const cod = toInt(r[0]);
  if (!cod) { desc++; continue; }
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
    updated_at: new Date().toISOString(),
  });
}

console.log(`\nA importar: ${out.length}  |  Descartadas (Cod vacío): ${desc}`);

const BATCH = 200;
let ok = 0;
const errores = [];
for (let i = 0; i < out.length; i += BATCH) {
  const chunk = out.slice(i, i + BATCH);
  const { error } = await sb.from('client_operational').upsert(chunk, { onConflict: 'tenant_id,cod_cliente' });
  if (error) {
    errores.push({ batch: i, error: error.message });
    console.error(`  Batch ${i}: FAIL — ${error.message}`);
  } else {
    ok += chunk.length;
    console.log(`  Batch ${i}-${i + chunk.length}: OK`);
  }
}

console.log(`\n=== RESUMEN ===`);
console.log(`Upserts OK: ${ok}  |  Errores: ${errores.length}`);

const { error: logErr } = await sb.from('sheet_import_log').insert({
  tenant_id: TENANT_ID,
  sheet_id: '1k7B8Phi5QDn_6mFWiAfYBcqqisEWT6nqUwgmhE54Zy8',
  gid: '145678139',
  hoja: SHEET_NAME,
  year, month,
  rows_leidas: rows.length - 1,
  rows_importadas: ok,
  rows_descartadas: desc,
  errores: errores.length ? errores : null,
  finished_at: new Date().toISOString(),
});
if (logErr) console.warn(`Log fail: ${logErr.message}`);
else console.log('Log OK');

process.exit(errores.length > 0 ? 1 : 0);
