// Validación del motor de cruce con el caso REAL de junio 2026:
// Sheet de carpeta (Drive) + cierre 30/06 (pestaña SISTEMA) vs el cruce manual verificado.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Requiere `npm run build:server` previo (importa el motor compilado).
const APP = new URL('../../dist-server/server-lib/', import.meta.url).href;
const require_ = createRequire(new URL('../../package.json', import.meta.url));
const XLSX = require_('xlsx');
const { parseCarpeta, cruzarCarpeta } = await import(APP + 'cruceCarpeta.js');

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const SCRATCH = dirname(fileURLToPath(import.meta.url)) + '/';
const CORTE = '2026-06-30';

// --- Lado carpeta: el Sheet real de junio ---
const wb = XLSX.read(readFileSync(SCRATCH + 'cte_junio_2026.xlsx'), { type: 'buffer', cellDates: false });
const carpeta = parseCarpeta(wb, CORTE);
console.log('CARPETA: pestañas ignoradas:', carpeta.pestanas_ignoradas);
console.log('  vendedores:', carpeta.vendedores.map(g => `${g.pestana}(${g.clientes.length} cli, $${Math.round(g.total).toLocaleString()})`).join(' | '));
console.log('  excluidas por fecha:', carpeta.excluidas_por_fecha.map(e => `${e.cliente} ${e.fecha}`));
console.log('  sin fecha:', carpeta.sin_fecha.length);

// --- Lado sistema: cierre 30/06 real (sistema_all.json de la sesión del 01/07) ---
const sistemaAll = JSON.parse(readFileSync(SCRATCH + 'sistema_all.json', 'utf-8'));
const VEN_COD = { 'Brandan Julio': 4, 'Veliz Marcelo': 3, 'veliz Marcelo': 3, 'El eter Sebastian': 2, 'BRIAN': 12, 'ANDREA': 6 };
const sistemaRows = [];
const maestro = [];
const maestroSnapshot = {};
for (const s of sistemaAll) {
  if (s.cod == null) continue;
  const cod = Number(s.cod);
  const codVen = VEN_COD[s.ven] ?? 0;
  sistemaRows.push({
    cod_cliente: cod, nombre: s.nom, saldo: Number(s.sal) || 0,
    tipo_comprobante: 'FA', fecha_factura: CORTE, dias_deuda: 0,
    importe_factura: Number(s.sal) || 0, importe_pagado: 0,
    punto_de_venta: '', numero: '', id: cod, cod_empresa: 1, cod_vendedor: codVen,
  });
  maestro.push({ cod_cliente: cod, razon_social: s.nom, cod_vendedor: codVen });
  maestroSnapshot[String(cod)] = { cod_vendedor: codVen, nombre: s.nom };
}
console.log(`SISTEMA: ${sistemaRows.length} clientes del cierre 30/06`);

// --- Cruce ---
const r = cruzarCarpeta({
  carpeta, sistemaRows, maestro, maestroSnapshot,
  recibos: [], corte: CORTE, tolerancia: 20,
  corteExacto: true, advertencia: null,
});

console.log('\n=== RESULTADO DEL MOTOR ===');
console.log(`Totales: carpeta $${Math.round(r.totales.carpeta).toLocaleString()} | sistema $${Math.round(r.totales.sistema).toLocaleString()}`);
console.log(`cuadra=${r.totales.n_cuadra} dif=${r.totales.n_diferencia} soloCarp=${r.totales.n_solo_carpeta} soloSist=${r.totales.n_solo_sistema}`);
for (const v of r.vendedores) {
  const difs = v.matches.filter(m => m.estado === 'DIFERENCIA');
  console.log(`\n-- ${v.pestana}: ${v.matches.length} matches (${difs.length} dif) | soloCarp=${v.solo_carpeta.length} soloSist=${v.solo_sistema.length}`);
  for (const m of difs.slice(0, 8)) {
    const flags = [m.tentativo && 'tent', m.ambiguo && 'amb'].filter(Boolean).join(',');
    console.log(`   DIF ${m.carpeta} vs ${m.sistema} (#${m.cod_cliente}): ${Math.round(m.dif).toLocaleString()} ${flags}`);
  }
  for (const sc of v.solo_carpeta) console.log(`   SOLO-CARP ${sc.cliente} $${Math.round(sc.saldo).toLocaleString()} ${sc.cross_vendedor ? '→ ' + JSON.stringify(sc.cross_vendedor).slice(0, 90) : ''}`);
}
console.log('\nINTERNAS:', r.internas.map(i => `${i.nombre} $${Math.round(i.saldo_im).toLocaleString()}`).join(' | '));

// --- Comparación contra el cruce manual verificado (recon_full.json) ---
const manual = JSON.parse(readFileSync(SCRATCH + 'recon_full.json', 'utf-8'));
console.log('\n=== COMPARACIÓN vs CRUCE MANUAL (junio, verificado por 6 agentes) ===');
const PEST_BY_KEY = { JULIO: 'JULIO', MARCELO: 'MARCELO', SEBA: 'SEBA', BRIAN: 'BRIAN', ANDREA: 'ANDREA' };
let okDif = 0, faltantes = [], extras = [];
for (const [key, R] of Object.entries(manual.recon)) {
  const pest = PEST_BY_KEY[key];
  const grupo = r.vendedores.find(v => v.pestana.toUpperCase().startsWith(pest));
  if (!grupo) { console.log(`  !! grupo ${pest} no encontrado en motor`); continue; }
  const motorDifs = new Map(grupo.matches.filter(m => m.estado === 'DIFERENCIA').map(m => [m.carpeta.toUpperCase(), Math.round(m.dif)]));
  const manualDifs = (R.match || []).filter(x => x.estado === 'DIFERENCIA');
  for (const md of manualDifs) {
    const clave = md.fis.toUpperCase();
    const got = motorDifs.get(clave);
    if (got !== undefined && Math.abs(got - Math.round(md.dif)) <= 2) okDif++;
    else if (got !== undefined) { okDif++; console.log(`  ~ ${key}/${md.fis}: dif motor ${got.toLocaleString()} vs manual ${Math.round(md.dif).toLocaleString()}`); }
    else faltantes.push(`${key}/${md.fis} (manual dif ${Math.round(md.dif).toLocaleString()})`);
  }
  for (const [nom, dif] of motorDifs) {
    if (!manualDifs.some(x => x.fis.toUpperCase() === nom)) extras.push(`${key}/${nom} (motor dif ${dif.toLocaleString()})`);
  }
}
console.log(`\nDiferencias del manual reproducidas por el motor: ${okDif}`);
console.log('No reproducidas (revisar):', faltantes.length ? faltantes : 'ninguna');
console.log('Nuevas del motor (no estaban en manual):', extras.length ? extras : 'ninguna');
