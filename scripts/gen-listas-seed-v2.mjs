/**
 * Genera la migración de reglas de lista desde la planilla "CONDICIONES LISTA SEMILLERO"
 * corregida por Mati el 08/09/2026.
 *
 *   node scripts/gen-listas-seed-v2.mjs <planilla.csv> > supabase/migrations/035_....sql
 *
 * La planilla es la fuente de verdad. Se baja sola (es pública):
 *   curl -sL "https://docs.google.com/spreadsheets/d/1RWL3lUt9PitfXWdMlqUZRMkdITBkmy5yeOS1VErF2d0/export?format=csv&gid=881096386"
 *
 * TRADUCCIÓN DE LA NOTACIÓN (Mati respondió cada una el 08/09):
 *   UNITARIO      -> libre
 *   10 UDS        -> min 10 bultos, sumando la LÍNEA ("es sumando la linea")
 *   10+1 / 5+1    -> min 11 / min 6  ("tiene que convertirse en lista 2 con 11 unidades,
 *                    que es el equivalente, así deberían cargar los vendedores")
 *   - 5 UDS       -> max 5 ("ese es el precio hasta 5 uds") — max es INCLUSIVE
 *   BOLSA         -> bulto_cerrado ("bolsa cerrada")
 *   BOLS +10%     -> bulto_cerrado OPCIONAL: habilita la lista, no es un derecho del cliente
 *   10 KGS        -> min 10 kg
 *   20% DCTO      -> libre + nota: el descuento ya ESTÁ en el precio de esa lista en IM
 *                    (verificado: COLLAR ANTIPULGAS L1 $7.336 y L3 $5.869 = -20% exacto)
 *   PALLET        -> min N bultos por artículo (120 la bolsa de 12,5 kg, 70 la de 20 kg)
 *
 * Además, la promo general SIGUE VIGENTE (Mati: "sii se sigue ofreciendo"): 10 bultos
 * surtidos en el pedido habilitan la Lista 2, en paralelo a la condición propia de la línea.
 */
import fs from 'node:fs';

const PROMO_GENERAL_BULTOS = 10;

/** Dónde vive cada línea de la planilla dentro de InfoManager. */
const MAPEO = {
  'GANAVE':            { sub: ['Ganave'] },
  'CONEJO AMANECER':   { sub: ['El Amanecer'] },
  'CONEJO GEPSA':      { sub: ['Gepsa'] },
  'CONEJO COENCAR':    { sub: ['Conecar'], nota: 'La planilla dice COENCAR; en IM el subrubro es "Conecar".' },
  'BALANCEADOS PROPIOS': { sub: ['Semillero'], nota: 'Es la línea de producción propia. Los umbrales 30/50 coinciden con los que ya estaban cargados como "LINEA PRODUCCION PROPIA SEMILLERO".' },
  'ROSCO':             { sub: ['Rosco'] },
  'TIERNITO':          { sub: ['Tiernitos', 'Tiernito'], nota: 'Perro (15/21 kg) y gato (10 kg) viven en subrubros distintos. Los SNACK TIERNITO tienen regla propia por código.' },
  'DS CRIADORES':      { sub: ['Dog Seleccion'], nota: 'En IM el subrubro es "Dog Seleccion"; los artículos se llaman DS CRIADORES / DS ETIQ.' },
  'GRAN CAMPEON':      { sub: ['Gran Campeon'] },
  'PACHA':             { sub: ['Pacha'] },
  'BELCAN':            { sub: ['Belcan', 'Belcat'], nota: 'En IM está partido en dos subrubros: Belcan (perro) y Belcat (gato).' },
  'ZIMPI':             { sub: ['Zimpi', 'Zimpy'], nota: 'En IM está escrito de las dos formas (Zimpi y Zimpy).' },
  'ARROZ P PARRO':     { sub: ['Arroz p/perro'] },
  'COMPINCHE':         { sub: ['Compinche'] },
  'FLECKY':            { sub: ['Flecky'], nota: 'Incluye FULL CAT, que comparte subrubro. 🔴 La L4 (50 uds) es NUEVA: hasta el 08/09 la línea sólo llegaba a L2 y se vendía en L4 igual (193 renglones, $26,8M en 4 semanas).' },
  'COMPLETE':          { sub: ['Complete'] },
  'BALANCED':          { sub: ['Balanced'] },
  'PREMIUM':           { sub: ['Exact Premium', 'Premium'] },
  '9 LIVE':            { sub: ['9 lives'], nota: 'En IM el subrubro se escribe "9 lives".' },
  'CHEF CAT':          { sub: ['Chef Cat'] },
  'CEREALES DESYUNO':  { sub: ['Cereales para desayuno'] },
  'CONDIMENTOS':       { sub: ['Condimentos'] },
  'FRUTOS SECOS':      { sub: ['Frutos secos', 'Frutos Secos'] },
  'PASTAS MANI':       { sub: ['Pastas de Mani'] },
  'LEGUMBRES':         { sub: ['Legumbres'], nota: 'Polenta y harina de maíz tienen regla propia por código.' },
  'QUEBRADOS':         { sub: ['Quebrados'] },
  'MEZCLAS':           { sub: ['Mezclas'] },
  'PIEDRAS SANITARIAS':{ sub: ['Accesorios Perros y Gatos'], soloArts: [961, 995, 1009], nota: 'El subrubro mezcla muchas cosas: la regla va por código de artículo.' },
  // Líneas que se identifican por código porque comparten subrubro con otros productos
  'COLLAR ANTIPULGA':  { arts: [921, 922, 923, 924] },
  'PIPETAS':           { arts: [962, 963, 964, 965, 966, 10961] },
  'SHAMPOO':           { arts: [987, 988, 989, 990, 991, 992, 1987], nota: 'Sólo los de mascotas. Los shampoos de Limpieza (12642, 12645-12648) no entran.' },
  'TALQUERA PULGUICIDA': { arts: [993], nota: 'Sólo el pulguicida de mascotas; las talqueras de hormigas son otra cosa.' },
  'SHULLET':           { arts: [766, 767, 768, 769] },
  'PRALINE':           { arts: [656, 2009, 10671, 10680] },
  'MANI TOSTADO SALADO': { arts: [653, 10672] },
  'MANI TOSTADO SIN SAL': { arts: [10640, 10670], activo: false, nota: '⚠️ SIN CONFIRMAR: en IM no hay ningún artículo que diga "sin sal". Se asume que son MANI TOSTADO KING x KG y x 10 KG. Confirmar con Mati.' },
  'LABORATORIO GRAL':  { arts: [], activo: false, nota: '⚠️ SIN MAPEAR: no hay subrubro ni artículos "laboratorio" en IM. Falta que Mati diga qué abarca.' },
  'RATISADA ULTRA JERINGA': { arts: [1959, 1960], activo: false, nota: '⚠️ SIN CONFIRMAR: en IM están RATISADA LIQ. x 1 LT y x 500 CC, no una "ultra jeringa". Las jeringas que hay son CUCAXAN y GERMANI GEL.' },
  'PELLET':            { arts: [471] },
  'PELLET ALFA':       { arts: [485] },
  'TRIGO FORRAJERO':   { arts: [473] },
  'AFRECHO':           { arts: [451] },
  'ARROZ':             { arts: [700] },
  'AVENA FORRAJERA X KG': { arts: [453] },
};
/** Las semillas y granos que se venden por bolsa, cada una con su código. */
const POR_BOLSA = {
  'ALPISTE': 400, 'LINO': 401, 'MIJO': 402, 'SORGO': 403, 'SOJA': 404, 'SESAMO': 405,
  'MIX SEMILLAS': 406, 'QUINOA': 407, 'SALVADO DE AVENA': 409, 'SALVADO DE TRIGO': 410,
  'ARVEJA PARTIDA': 452, 'AVENA PELADA': 454, 'CARTAMO': 455, 'COLZA': 456,
  'GIRASOL CHICO': 457, 'GIRASOL GRANDE': 458, 'GIRASOL PELADO': 459,
};
/** El pallet depende del tamaño de la bolsa (Mati, 08/09). */
// 960 (bolsa de 1,8 kg) queda afuera: está deshabilitado en IM y no se vende por pallet.
const PALLET = { 995: 120, 1009: 70, 961: 60 };

const LISTA = { 1: 12, 2: 13, 3: 14, 4: 15 };
const q = (s) => s == null ? 'null' : `'${String(s).replace(/'/g, "''")}'`;

function traducir(celda, codLista) {
  const c = String(celda || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!c) return null;
  if (c === 'UNITARIO') return { condicion: 'libre' };
  if (c === 'BOLSA') return { condicion: 'bulto_cerrado' };
  if (/^BOLS\.? ?\+ ?10 ?%$/.test(c)) return { condicion: 'bulto_cerrado', opcional: true, nota: 'La bolsa habilita esta lista; el 10% extra es decisión del vendedor, no un derecho del cliente.' };
  if (c === 'PALLET') return { condicion: 'pallet' };
  let m;
  if ((m = /^(\d+)\s*\+\s*(\d+)$/.exec(c)))
    return { condicion: 'min', umbral: Number(m[1]) + Number(m[2]), unidad: 'bulto', ambito: 'linea', bonificacion: `${m[1]}+${m[2]}` };
  if ((m = /^-\s*(\d+) ?UDS?$/.exec(c)))
    return { condicion: 'max', umbral: Number(m[1]), unidad: 'bulto', ambito: 'linea' };
  if ((m = /^(\d+) ?UDS?$/.exec(c)))
    return { condicion: 'min', umbral: Number(m[1]), unidad: 'bulto', ambito: 'linea' };
  if ((m = /^(\d+) ?BOLSAS?$/.exec(c)))
    return { condicion: 'min', umbral: Number(m[1]), unidad: 'bulto', ambito: 'linea' };
  if ((m = /^(\d+) ?KGS?$/.exec(c)))
    // 🪤 En kilos el ámbito es el ARTÍCULO, no la línea: "10 kg de condimentos" sumando toda
    // la línea se cumple en casi cualquier pedido, y entonces todo renglón en L1 pasaba a
    // decir "le estás cobrando de más" (584 falsos en la simulación contra 4 semanas reales).
    // Lo de "sumando la línea" que confirmó Mati aplica a las cantidades en unidades.
    return { condicion: 'min', umbral: Number(m[1]), unidad: 'kg', ambito: 'articulo' };
  if ((m = /^(\d+) ?% ?DCTO$/.exec(c)))
    return { condicion: 'libre', nota: `La planilla dice "${m[1]}% DCTO": ese descuento YA ESTÁ en el precio de esta lista en IM, así que el vendedor elige la lista y no carga un descuento aparte.` };
  return { error: c };
}

const csv = fs.readFileSync(process.argv[2] ?? '/tmp/cond_lista.csv', 'utf8').trim().split('\n').slice(1);
const filas = [], problemas = [];

for (const linea of csv) {
  const [nombre, ...celdas] = linea.split(',').map(c => c.trim());
  const dest = MAPEO[nombre.toUpperCase()] ?? (POR_BOLSA[nombre.toUpperCase()] != null ? { arts: [POR_BOLSA[nombre.toUpperCase()]] } : null);
  if (!dest) { problemas.push(`sin mapeo: ${nombre}`); continue; }
  const activo = dest.activo !== false;

  for (let i = 0; i < 4; i++) {
    const t = traducir(celdas[i], LISTA[i + 1]);
    if (!t) continue;
    if (t.error) { problemas.push(`${nombre} L${i + 1}: no sé traducir "${t.error}"`); continue; }
    const nota = [dest.nota, t.nota].filter(Boolean).join(' ') || null;
    const emitir = (tipo, valor, extra = {}) => filas.push({
      nombre, match_tipo: tipo, match_valor: String(valor), cod_lista: LISTA[i + 1],
      condicion: t.condicion, umbral: t.umbral ?? null, unidad: t.unidad ?? null,
      ambito: t.ambito ?? null, opcional: t.opcional ?? false, bonificacion: t.bonificacion ?? null,
      activo, nota, ...extra,
    });

    if (t.condicion === 'pallet') {
      // El pallet es una cantidad distinta según el tamaño de la bolsa.
      for (const [cod, n] of Object.entries(PALLET))
        emitir('articulo', cod, { condicion: 'min', umbral: n, unidad: 'bulto', ambito: 'articulo',
          nota: `Un pallet son ${n} bolsas de este artículo (Mati, 08/09/2026).` });
      continue;
    }
    if (dest.soloArts) for (const a of dest.soloArts) emitir('articulo', a);
    else if (dest.arts) for (const a of dest.arts) emitir('articulo', a);
    else for (const s of dest.sub) emitir('subrubro', s);

    // La promo general convive con la condición propia: es otro camino a la Lista 2.
    if (LISTA[i + 1] === 13 && t.condicion !== 'libre') {
      const promo = { condicion: 'promo_general', umbral: PROMO_GENERAL_BULTOS, unidad: 'bulto', ambito: 'pedido' };
      const emitirPromo = (tipo, valor) => filas.push({
        nombre, match_tipo: tipo, match_valor: String(valor), cod_lista: 13, ...promo,
        opcional: false, bonificacion: null, activo,
        nota: '10 bultos surtidos en el pedido habilitan la Lista 2 (sigue vigente al 08/09/2026). Es otro camino, en paralelo a la condición propia de la línea.',
      });
      if (dest.soloArts) for (const a of dest.soloArts) emitirPromo('articulo', a);
      else if (dest.arts) for (const a of dest.arts) emitirPromo('articulo', a);
      else for (const s of dest.sub) emitirPromo('subrubro', s);
    }
  }
}

// ── Cobertura que la planilla no menciona ────────────────────────────────────
// La planilla del 08/09 desglosó los accesorios en COLLAR ANTIPULGA, SHAMPOO, PIPETAS,
// TALQUERA y PIEDRAS SANITARIAS, pero dejó fuera líneas que hoy SÍ están controladas
// (ACCESORIOS Y VENENOS, EXACT CRIADORES, FRACCIONADOS KING Y NUTRIFOOD) y varias reglas
// por código. Borrarlas dejaría 817 renglones de 4 semanas sin ningún control.
// Se conservan tal como están, marcadas, hasta que Mati confirme si van o no.
const vigentes = JSON.parse(fs.readFileSync(process.argv[3] ?? '/home/ubuntu/auditorias/listas_20260908/datos/reglas.json', 'utf8'));
const cubierto = new Set(filas.map(f => `${f.match_tipo}|${f.match_valor.toLowerCase()}`));
let heredadas = 0;
for (const r of vigentes) {
  if (r.condicion === 'excluido') continue;                       // se preservan por separado
  if (cubierto.has(`${r.match_tipo}|${String(r.match_valor).toLowerCase()}`)) continue;
  heredadas++;
  filas.push({
    nombre: r.nombre, match_tipo: r.match_tipo, match_valor: String(r.match_valor),
    cod_lista: r.cod_lista, condicion: r.condicion, umbral: r.umbral, unidad: r.unidad,
    ambito: r.ambito, opcional: false, bonificacion: null, activo: true,
    nota: '⚠️ HEREDADA: no figura en la planilla del 08/09/2026. Se conserva para no dejar la línea sin control; confirmar con Mati si corresponde mantenerla.',
  });
}
console.error(`  + ${heredadas} reglas heredadas (líneas que la planilla no menciona)`);

const out = [];
out.push(`-- Migration 035 — Reglas de lista según la planilla CORREGIDA por Mati (08/09/2026).`);
out.push(`-- GENERADO por scripts/gen-listas-seed-v2.mjs. NO editar a mano: corregir el script y regenerar.`);
out.push(`--`);
out.push(`-- Reemplaza la carga de las migraciones 021/022/025, que traducía mal la notación de la`);
out.push(`-- planilla. Los tres errores que corrige, detectados en la auditoría del 08/09:`);
out.push(`--   1. "10+1" se había leído como la promo general de 10 bultos surtidos. Es una`);
out.push(`--      bonificación: se carga como 11 unidades en la lista 2.`);
out.push(`--   2. "BOLSA" se había leído como "20 kg", que dejaba afuera las bolsas de 25 y 30 kg.`);
out.push(`--   3. "BOLS +10%" y "BOLSA" habían quedado con la MISMA condición, así que la lista 2`);
out.push(`--      era inalcanzable y todo pedido disparaba "le estás cobrando de más" (110 casos).`);
out.push(``);
out.push(`alter table listas_reglas add column if not exists opcional boolean not null default false;`);
out.push(`alter table listas_reglas add column if not exists bonificacion text;`);
out.push(`comment on column listas_reglas.opcional is 'La condición habilita la lista pero no le da derecho al cliente (celda "BOLS +10%").';`);
out.push(`comment on column listas_reglas.bonificacion is 'La promo como la escribe la planilla ("10+1"): el umbral ya viene sumado.';`);
out.push(`alter table listas_reglas drop constraint if exists listas_reglas_condicion_check;`);
out.push(`alter table listas_reglas add constraint listas_reglas_condicion_check`);
out.push(`  check (condicion in ('libre','promo_general','min','max','excluido','bulto_cerrado'));`);
out.push(``);
out.push(`-- Las exclusiones no salen de la planilla: se preservan aparte (ver abajo).`);
out.push(`delete from listas_reglas where tenant_id = '00000000-0000-0000-0000-000000000001' and condicion <> 'excluido';`);
out.push(``);
out.push(`insert into listas_reglas (nombre, match_tipo, match_valor, cod_lista, condicion, umbral, unidad, ambito, opcional, bonificacion, activo, nota) values`);
out.push(filas.map(f => `  (${q(f.nombre)}, ${q(f.match_tipo)}, ${q(f.match_valor)}, ${f.cod_lista}, ${q(f.condicion)}, ${f.umbral ?? 'null'}, ${q(f.unidad)}, ${q(f.ambito)}, ${f.opcional}, ${q(f.bonificacion)}, ${f.activo}, ${q(f.nota)})`).join(',\n') + ';');
console.log(out.join('\n'));
console.error(`\n${filas.length} filas generadas · ${new Set(filas.map(f => f.nombre)).size} líneas`);
if (problemas.length) console.error('⚠ PROBLEMAS:\n  ' + problemas.join('\n  '));
