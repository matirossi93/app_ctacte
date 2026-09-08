/**
 * Genera la migración de reglas de lista desde la planilla "CONDICIONES LISTA SEMILLERO".
 *
 *   node scripts/gen-listas-seed-v2.mjs <planilla.csv> > supabase/migrations/0XX_....sql
 *
 * La planilla (Excel de Mati) es la fuente de verdad. Para regenerar: exportarla a CSV con
 * las columnas PRODUCTO/LINEA · LISTA 1 · LISTA 2 · LISTA 3 · LISTA 4 · nota.
 *
 * A DÓNDE APUNTA CADA LÍNEA: se reutiliza el mapeo ya validado de las reglas cargadas
 * (mismo nombre de línea), y sólo se declaran acá las que no existían.
 *
 * NOTACIÓN (tal como la escribe la planilla, typos incluidos):
 *   LIBRE · 1 bolsa · 1 unidad          -> libre (es el piso: siempre se puede vender ahí)
 *   10 bultos promo general             -> promo_general, 10 bultos surtidos del PEDIDO
 *   10 mismo producto                   -> min 10 unidades del ARTÍCULO
 *   30 unidades surtidas de la linea    -> min 30 unidades de la LÍNEA
 *   5 misma linea                       -> min 5 unidades de la LÍNEA
 *   menos de 20 kilos                   -> max 20 kg del artículo (estricto)
 *   a partir de 20 kilos                -> min 20 kg del artículo
 *   a partir de 50 bolsas               -> min 50 BULTOS del artículo (pallets)
 *
 * 🪤 "unidades" y "bultos" NO son lo mismo: un artículo que IM no reconoce como bolsa
 * (unidad de medida vacía, equivalencia 0) nunca suma un bulto, así que un umbral en
 * unidades cargado como 'bulto' no se cumple jamás. Por eso las celdas que hablan de
 * unidades usan `unidad: 'unidad'` y sólo las que dicen "bolsas"/"bultos" usan 'bulto'.
 */
import fs from 'node:fs';

const TENANT = '00000000-0000-0000-0000-000000000001';

/** Sólo las líneas que NO existían: el resto hereda su mapeo de las reglas ya cargadas. */
const NUEVAS = {
  'MONKY':                                   { arts: [695, 696, 697, 698, 699, 727, 13123, 13124, 13125, 13126, 13127] },
  'MANI C/ CHOCOLATE':                       { arts: [650, 10707] },
  'MANI SABORIZADO':                         { arts: [652, 772, 773, 774, 775, 10682, 10683, 10684, 10685, 10686, 10690, 10708] },
  'MANI SALADO CON PIEL':                    { arts: [653] },
  'MANI SALADO X KG - MANI KING':            { arts: [10672] },
  'MANI TOSTADO X KG - MANI KING':           { arts: [10670] },
  'MANI TOSTADO C/ CASCARA X KG - MANI KING':{ arts: [10669], nota: 'Sólo el fraccionado por kilo (MANI CON CASCARA KING X KG); los 16x175 y 10x400 son otra presentación.' },
  'PRALINE X KG - MANI KING':                { arts: [10671] },
  'PASTA DE MANI DULCE BORIS X 400G X 12U':  { arts: [692] },
  'PASTA DE MANI CHOCO BORIS X 400G X 12U':  { arts: [693] },
  'PISTACHO SALADO MK':                      { arts: [2010], nota: 'Sólo el salado; PISTACHO NATURAL 2X6KG (2013) no figura en la planilla.' },
  'VITALFUN':                                { arts: [1016], nota: 'ARENA SANITARIA VITAL FUN X 6K. Vive en Accesorios Perros y Gatos, así que va por código: la regla por artículo le gana a la de la línea.' },
  'SALSA TIERNITOS':                         { arts: [194, 195, 196, 10264, 10265], nota: 'Comparte subrubro con el alimento Tiernito, por eso va por código.' },
  // La planilla las separó del resto de MEZCLAS: 10 kg en vez de 20. Van por código porque
  // comparten el subrubro con las demás, y la regla por artículo le gana a la de la línea.
  // Las versiones "SAN JUAN" quedan afuera: el control es de casa central.
  'MEZCLAS GALLO, GALLO PREMIUM Y GRUESA':   { arts: [464, 468, 469, 491] },
  'MEZCLAS (SALVO GALLO, GALLO PREMIUM Y GRUESA': { sub: ['Mezclas'] },
};

const norm = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Mati, 08/09: cuando falta stock se le hace el mejor precio igual — *"ya es un problema
 * nuestro, no del cliente, por eso le respetamos el precio"*. El sistema no sabe qué había
 * en el depósito el día del pedido, así que no puede distinguir ese caso: queda escrito acá
 * para quien revise el aviso.
 */
const FALTANTES = {
  'CEREALES DESYUNO': 'Si el producto estaba faltante se respeta el mejor precio aunque no llegue a la cantidad: el sistema no puede verificarlo y va a marcarlo igual.',
};

function traducir(celda) {
  const c = String(celda || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!c) return null;
  if (c === 'libre') return { condicion: 'libre' };
  // "1 bolsa", "1 unidad", "1 bolsa (40kilos)": es el piso, siempre se puede vender ahí.
  if (/^1 (bolsa|unidad)/.test(c)) return { condicion: 'libre' };
  if (/bultos? promo general/.test(c)) return { condicion: 'promo_general', umbral: 10, unidad: 'bulto', ambito: 'pedido' };
  let m;
  // Kilos
  if ((m = /^menos de (\d+(?:[.,]\d+)?) kilos/.exec(c)))
    return { condicion: 'max', umbral: num(m[1]), unidad: 'kg', ambito: 'articulo' };
  if ((m = /^(?:a partir(?: de)?|a parti de|mas de) (\d+(?:[.,]\d+)?) kilos/.exec(c)))
    return { condicion: 'min', umbral: num(m[1]), unidad: 'kg', ambito: 'articulo' };
  // Bolsas enteras (los pallets de piedras sanitarias)
  if ((m = /^(?:a partir de )?(\d+) bolsas/.exec(c)))
    return { condicion: 'min', umbral: num(m[1]), unidad: 'bulto', ambito: 'articulo' };
  // Unidades — el ámbito lo dice el texto: "mismo producto" vs "surtidas / misma linea"
  if ((m = /^(?:a partir(?: de)? )?(\d+) unidades? surtidas?/.exec(c)))
    return { condicion: 'min', umbral: num(m[1]), unidad: 'unidad', ambito: 'linea' };
  if ((m = /^(?:a partir(?: de)? )?(\d+) unidades? de la mi[sm]+a linea/.exec(c)))
    return { condicion: 'min', umbral: num(m[1]), unidad: 'unidad', ambito: 'linea' };
  if ((m = /^menos de (\d+) unidades/.exec(c)))
    return { condicion: 'max', umbral: num(m[1]), unidad: 'unidad', ambito: 'articulo' };
  if ((m = /^(?:a partir(?: de)? )?(\d+) unidades?(?: del? mismo (?:producto|prudcto))?$/.exec(c)))
    return { condicion: 'min', umbral: num(m[1]), unidad: 'unidad', ambito: 'articulo' };
  if ((m = /^(\d+) mi[sm]+a linea/.exec(c)))
    return { condicion: 'min', umbral: num(m[1]), unidad: 'unidad', ambito: 'linea' };
  if ((m = /^(\d+) mismo producto/.exec(c)))
    return { condicion: 'min', umbral: num(m[1]), unidad: 'unidad', ambito: 'articulo' };
  return { error: c };
}
const num = (s) => Number(String(s).replace(',', '.'));
const q = (s) => s == null ? 'null' : `'${String(s).replace(/'/g, "''")}'`;

// ── Entrada ──────────────────────────────────────────────────────────────────
const csv = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').slice(1)
  .map(l => (l.match(/(?:^|,)("[^"]*"|[^,]*)/g) ?? []).map(x => x.replace(/^,/, '').replace(/^"|"$/g, '').trim()));
const vigentes = JSON.parse(fs.readFileSync(process.argv[3] ?? '/home/ubuntu/auditorias/listas_20260908/datos/reglas.json', 'utf8'));

/** Mapeo heredado: nombre de línea -> a qué apunta en IM. */
const destinoDe = new Map();
for (const r of vigentes) {
  const k = norm(r.nombre);
  if (!destinoDe.has(k)) destinoDe.set(k, { nombre: r.nombre, targets: new Map() });
  destinoDe.get(k).targets.set(`${r.match_tipo}|${r.match_valor}`, { tipo: r.match_tipo, valor: r.match_valor });
}

const filas = [], problemas = [], sinMapeo = [];
for (const c of csv) {
  const linea = c[0];
  if (!linea) continue;
  const heredado = destinoDe.get(norm(linea));
  const nueva = NUEVAS[linea.toUpperCase()] ?? NUEVAS[linea.toUpperCase().replace(/\)$/, '')];
  let targets, activo = true, notaLinea = null;
  if (heredado) targets = [...heredado.targets.values()];
  else if (nueva) {
    targets = nueva.arts
      ? nueva.arts.map(a => ({ tipo: 'articulo', valor: String(a) }))
      : nueva.sub.map(x => ({ tipo: 'subrubro', valor: x }));
    activo = nueva.activo !== false; notaLinea = nueva.nota ?? null;
  } else { sinMapeo.push(linea); continue; }

  const notaPlanilla = c[5] || null;
  for (let i = 0; i < 4; i++) {
    const t = traducir(c[i + 1]);
    if (!t) continue;
    if (t.error) { problemas.push(`${linea} · L${i + 1}: no sé traducir "${t.error}"`); continue; }
    for (const tg of targets) {
      filas.push({
        nombre: linea, match_tipo: tg.tipo, match_valor: tg.valor, cod_lista: 12 + i,
        condicion: t.condicion, umbral: t.umbral ?? null, unidad: t.unidad ?? null,
        ambito: t.ambito ?? null, activo,
        nota: [notaLinea, notaPlanilla && `Nota de la planilla: ${notaPlanilla}`, FALTANTES[linea.toUpperCase()]].filter(Boolean).join(' ') || null,
      });
    }
  }
}
// Las exclusiones no salen de la planilla y se preservan aparte.
const cubierto = new Set(filas.map(f => `${f.match_tipo}|${f.match_valor}`));
let heredadas = 0;
for (const r of vigentes) {
  if (r.condicion === 'excluido') continue;
  if (cubierto.has(`${r.match_tipo}|${r.match_valor}`)) continue;
  heredadas++;
  filas.push({ ...r, activo: true, nota: '⚠️ HEREDADA: la línea no figura en la planilla del 08/09/2026. Se conserva para no dejarla sin control; confirmar con Mati.' });
}

// La planilla repite alguna línea (GIRASOL CHICO está dos veces). Se deduplica por destino
// + lista + condición, que es la clave del índice único.
const unicas = new Map();
const repetidas = [];
for (const f of filas) {
  const k = `${f.match_tipo}|${f.match_valor}|${f.cod_lista}|${f.condicion}`;
  if (unicas.has(k)) { repetidas.push(`${f.nombre} L${f.cod_lista - 11}`); continue; }
  unicas.set(k, f);
}
filas.length = 0;
filas.push(...unicas.values());
if (repetidas.length) console.error(`  ${repetidas.length} filas repetidas en la planilla, descartadas: ${[...new Set(repetidas.map(r => r.split(' L')[0]))].join(', ')}`);

const out = [];
out.push(`-- Migration 035 — Reglas de lista según la planilla real de Mati (08/09/2026).`);
out.push(`-- GENERADO por scripts/gen-listas-seed-v2.mjs. NO editar a mano: corregir el script.`);
out.push(`--`);
out.push(`-- Qué cambia respecto de lo cargado en agosto:`);
out.push(`--   · LINEA FLECKY + FULLCAT gana L3 (20 unidades surtidas) y L4 (30). Antes llegaba`);
out.push(`--     sólo hasta L2, y la auditoría del 08/09 encontró 193 renglones vendidos en L4.`);
out.push(`--   · MEZCLAS se parte en dos: las comunes siguen con 20 kg y las de gallo, gallo`);
out.push(`--     premium y gruesa pasan a 10 kg.`);
out.push(`--   · Entran 13 líneas que no estaban: los maníes y snacks de Mani King, PASTA DE MANI`);
out.push(`--     BORIS, PISTACHO, MONKY, VITALFUN y SALSA TIERNITOS.`);
out.push(`--   · Los umbrales en UNIDADES dejan de contarse como bultos (ver el 🪤 del generador).`);
out.push(``);
out.push(`alter table listas_reglas drop constraint if exists listas_reglas_unidad_check;`);
out.push(`alter table listas_reglas add constraint listas_reglas_unidad_check`);
out.push(`  check (unidad is null or unidad in ('bulto','kg','unidad'));`);
out.push(``);
out.push(`-- 🪤 El índice único era (tenant, tipo, valor, lista): UNA sola condición por lista.`);
out.push(`-- Varias líneas llegan a la misma lista por dos caminos (la condición propia y la promo`);
out.push(`-- general de 10 bultos surtidos), así que la condición entra en la clave.`);
out.push(`drop index if exists listas_reglas_target_uidx;`);
out.push(`create unique index if not exists listas_reglas_target_uidx`);
out.push(`  on listas_reglas (tenant_id, match_tipo, match_valor, cod_lista, condicion);`);
out.push(``);
out.push(`delete from listas_reglas where tenant_id = '${TENANT}' and condicion <> 'excluido';`);
out.push(``);
out.push(`insert into listas_reglas (nombre, match_tipo, match_valor, cod_lista, condicion, umbral, unidad, ambito, activo, nota) values`);
out.push(filas.map(f => `  (${q(f.nombre)}, ${q(f.match_tipo)}, ${q(f.match_valor)}, ${f.cod_lista}, ${q(f.condicion)}, ${f.umbral ?? 'null'}, ${q(f.unidad)}, ${q(f.ambito)}, ${f.activo}, ${q(f.nota)})`).join(',\n') + ';');

// La planilla trae este descuento como nota al margen de la línea, no como una lista.
// La auditoría del 08/09 encontró 52 renglones de Exact Criadores con 5% que el control
// marcaba como "producto sin descuentos habilitados": estaban bien, faltaba cargarlo.
// 🔑 La nota dice "sobre lista 1", pero Mati confirmó que el 5% va sobre la LISTA 3, que es
// donde los vendedores lo estaban aplicando (los 52 renglones, sin excepción).
out.push(``);
out.push(`insert into descuentos_reglas (nombre, match_tipo, match_valor, desde_cantidad, ambito, porcentaje_max, requiere_lista, requiere_mejor_lista, aviso, activo) values`);
out.push(`  ('EXACT CRIADORES', 'subrubro', 'Exact Criadores', 1, 'articulo', 5, 14, false, null, true)`);
out.push(`on conflict (tenant_id, match_tipo, match_valor, desde_cantidad, coalesce(requiere_lista, -1)) do update set`);
out.push(`  porcentaje_max = excluded.porcentaje_max, ambito = excluded.ambito, activo = excluded.activo;`);
console.log(out.join('\n'));
console.error(`${filas.length} filas · ${new Set(filas.map(f => f.nombre)).size} líneas · ${heredadas} heredadas`);
if (sinMapeo.length) console.error('⚠ SIN MAPEO:\n  ' + sinMapeo.join('\n  '));
if (problemas.length) console.error('⚠ NO TRADUCIDAS:\n  ' + problemas.join('\n  '));
