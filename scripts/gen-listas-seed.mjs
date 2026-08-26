/**
 * Traduce la planilla "CONDICIONES LISTA SEMILLERO" de Mati a la migración de seed
 * de `listas_reglas`.
 *
 *   node scripts/gen-listas-seed.mjs "ruta/CONDICIONES LISTA SEMILLERO.xlsx"
 *
 * Lee además scripts/listas-mapeo.json, que dice a qué apunta cada fila de la planilla
 * dentro de InfoManager (un subrubro o una lista de códigos). Ese archivo es el que hay
 * que corregir cuando Mati confirma un mapeo; la planilla sola no alcanza porque usa
 * nombres comerciales ("LINEA DS CRIADORES") que en IM se llaman distinto ("Dog Seleccion").
 *
 * Cuando Mati actualiza la planilla: se vuelve a correr esto y se aplica el SQL que sale.
 * Todo lo que no se pueda interpretar se imprime al final — nunca se descarta en silencio.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as XLSX from 'xlsx';

const AQUI = dirname(fileURLToPath(import.meta.url));
const PLANILLA = process.argv[2];
const MAPEO = join(AQUI, 'listas-mapeo.json');
const SALIDA = join(AQUI, '..', 'supabase', 'migrations', '021_listas_reglas_seed.sql');
if (!PLANILLA) { console.error('Falta la ruta de la planilla .xlsx'); process.exit(1); }

const COL_LISTA = [12, 13, 14, 15];  // columnas B..E = LISTA 1..4 -> códigos de IM

/**
 * Traduce una celda de la planilla a una condición.
 * Devuelve null si la celda está vacía (= esa lista no aplica a ese producto).
 */
function parsearCelda(txt) {
  const t = String(txt ?? '').trim().toLowerCase();
  if (!t) return null;

  // "LIBRE", "1 bolsa", "1 unidad", "1 bolsa (40kilos)" -> sin condición de cantidad.
  if (t === 'libre' || /^1\s*(bolsa|unidad)/.test(t)) {
    return { condicion: 'libre', umbral: null, unidad: null, ambito: null };
  }
  // "10 bultos promo general" -> la del audio: 10 bultos surtidos en TODO el pedido.
  if (t.includes('promo general')) {
    const n = Number(/(\d+)/.exec(t)?.[1] ?? 10);
    return { condicion: 'promo_general', umbral: n, unidad: 'bulto', ambito: 'pedido' };
  }

  const num = /(\d+(?:[.,]\d+)?)/.exec(t);
  if (!num) return { error: true };
  const umbral = Number(num[1].replace(',', '.'));

  const enKilos = /kilo/.test(t);
  // "misma linea" / "surtidas de la misma linea" -> suma todos los renglones de la línea.
  const ambito = /misma\s*linea|misma\s*l[ií]nea/.test(t) ? 'linea' : 'articulo';
  const unidad = enKilos ? 'kg' : 'bulto';

  if (/^menos de/.test(t)) return { condicion: 'max', umbral, unidad, ambito };
  // "mas de 15 kilos" es estrictamente mayor; "a partir de 15" incluye el 15. La diferencia
  // es de un kilo y solo aparece en CONDIMENTOS: se deja anotado en la nota de la regla.
  // "a parti de" y "prudcto" están así en la planilla: se tolera el typo en vez de
  // pedirle a Mati que corrija la ortografía de una planilla que ya funciona.
  if (/^(a\s*part|mas de|m[áa]s de)/.test(t)) return { condicion: 'min', umbral, unidad, ambito };
  // "10 mismo producto", "30 unidades surtidas de la misma linea", "5 misma linea"
  if (/^\d/.test(t)) return { condicion: 'min', umbral, unidad, ambito };
  return { error: true };
}

const wb = XLSX.read(readFileSync(PLANILLA), { type: 'buffer' });
const filas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
const mapeo = JSON.parse(readFileSync(MAPEO, 'utf8'));

const inserts = [];
const problemas = [];
const vistos = new Set();

for (const fila of filas.slice(1)) {
  const nombre = String(fila[0] ?? '').trim();
  if (!nombre) continue;
  const m = mapeo[nombre];
  if (!m) { problemas.push(`${nombre}: no está en listas-mapeo.json`); continue; }
  if (m.tipo === 'sin_mapear') { problemas.push(`${nombre}: sin mapear a IM (${m.nota})`); continue; }
  // La planilla repite GIRASOL CHICO; Mati confirmó que se ignora la segunda.
  if (vistos.has(nombre)) continue;
  vistos.add(nombre);

  // activo=false mientras Mati no confirme el mapeo: la regla queda cargada pero no evalúa.
  const activo = m.estado === 'ok';
  for (const valor of m.valores) {
    for (let i = 0; i < COL_LISTA.length; i++) {
      const cond = parsearCelda(fila[i + 1]);
      if (!cond) continue;
      if (cond.error) { problemas.push(`${nombre} · LISTA ${i + 1}: no entiendo "${fila[i + 1]}"`); continue; }
      const nota = m.nota ? m.nota.replace(/'/g, "''") : null;
      inserts.push(`  ('${nombre.replace(/'/g, "''")}', '${m.tipo}', '${String(valor).replace(/'/g, "''")}', ${COL_LISTA[i]}, ` +
        `'${cond.condicion}', ${cond.umbral ?? 'null'}, ${cond.unidad ? `'${cond.unidad}'` : 'null'}, ` +
        `${cond.ambito ? `'${cond.ambito}'` : 'null'}, ${activo}, ${nota ? `'${nota}'` : 'null'})`);
    }
  }
}

const sql = `-- Migration 021 — Carga de las reglas de lista (26/08/2026). Idempotente.
--
-- GENERADO por scripts/gen-listas-seed.mjs desde la planilla "CONDICIONES LISTA SEMILLERO"
-- de Mati + scripts/listas-mapeo.json. NO editar a mano: corregir el mapeo y volver a generar.
--
-- Las reglas con activo=false son las que todavía no confirmó cuál es su equivalente en
-- InfoManager. Quedan cargadas para no perder el trabajo, pero el validador no las evalúa.

insert into listas_reglas (nombre, match_tipo, match_valor, cod_lista, condicion, umbral, unidad, ambito, activo, nota) values
${inserts.join(',\n')}
on conflict (tenant_id, match_tipo, match_valor, cod_lista) do update set
  nombre = excluded.nombre, condicion = excluded.condicion, umbral = excluded.umbral,
  unidad = excluded.unidad, ambito = excluded.ambito, activo = excluded.activo,
  nota = excluded.nota, updated_at = now();
`;
writeFileSync(SALIDA, sql);
console.log(`OK ${inserts.length} reglas -> ${SALIDA}`);
console.log(`   activas: ${inserts.filter(i => i.includes(', true, ')).length} · inactivas: ${inserts.filter(i => i.includes(', false, ')).length}`);
if (problemas.length) {
  console.log(`\n${problemas.length} filas que NO entraron:`);
  for (const p of problemas) console.log('   -', p);
}
