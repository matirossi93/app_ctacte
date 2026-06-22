/**
 * ANÁLISIS READ-ONLY — Comisiones de vendedores por ventas en sucursal
 * Av. San Martín (cod_empresa = 2), meses abril y mayo 2026 por separado.
 *
 * Contexto: el cálculo de comisiones de app_ctacte (comisiones.ts) SOLO cuenta
 * Casa Central (cod_empresa = 1) — ver filtro nOtraEmpresa. Desde abril algunos
 * clientes de vendedores empezaron a retirar también en San Martín, y esas
 * ventas (cod_empresa = 2) NO generan la comisión que le corresponde al
 * vendedor dueño del cliente.
 *
 * Este script NO escribe nada, NO envía nada: solo lee de InfoManager y calcula.
 * Reusa la MISMA lógica del sistema (clasificarCabecera, pctParaArticulo,
 * clientes internos, vendedores visibles) para que los números cuadren con el
 * panel de Comisiones.
 *
 * Uso:  node --env-file=.env scripts/analisis_comisiones_sm.mjs
 */
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import {
  fetchVentas, fetchVentasItems, fetchArticulosCatalogo,
  fetchClientesIM, fetchVendedores,
} from '../dist-server/server-lib/infomanager.js';
import {
  pctParaArticulo, categoriaParaPct, CATEGORIA_LABELS,
} from '../dist-server/server-lib/comisionesRules.js';
import {
  COD_CLIENTES_INTERNOS, COD_VENDEDORES_VISIBLES,
} from '../dist-server/server-lib/comisionesShared.js';
import { tipoComprobante, isAnulada } from '../dist-server/src/utils/ventas.js';

const COD_EMPRESA_SM = 2;          // Sucursal Av. San Martín (BRS)
const ANIO = 2026;
const MESES = [4, 5];              // abril, mayo

// Exclusiones por decisión de negocio (Mati, 16/06/2026): el cliente 17
// (BRUNO, Mayra — Alderetes) hace compras directas de alto volumen en la
// sucursal San Martín sin intervención del vendedor (31 retiros en mayo, varios
// el mismo día) → NO corresponde comisionar esas ventas a Julio. Se excluye SOLO
// de mayo; en abril no tuvo compras en SM. Map periodo 'YYYY-MM' → Set(cod_cliente).
const EXCLUIR_CLIENTES_POR_MES = { '2026-05': new Set([17]) };

const pad = (n) => String(n).padStart(2, '0');
const round2 = (n) => Math.round(n * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function ymdMonthEnd(year, month) {
  const lastDay = new Date(year, month, 0).getDate();
  return `${year}-${pad(month)}-${pad(lastDay)}`;
}

// Copia EXACTA de comisiones.ts → clasificarCabecera
function clasificarCabecera(cab) {
  if (isAnulada(cab)) return null;
  const tipo = tipoComprobante(cab);
  if (tipo.startsWith('ND')) return null;
  if (tipo.startsWith('NC')) return 'NC';
  if (tipo.startsWith('F')) return 'FA';
  return null;
}

function emptyBreakdown() {
  return { '5%': 0, '4%': 0, '3.5%': 0, '1%': 0 };
}

async function analizarMes(year, month, clientesMap, articulosMap) {
  const periodo = `${year}-${pad(month)}`;
  const excluir = EXCLUIR_CLIENTES_POR_MES[periodo] ?? new Set();
  const desde = `${year}-${pad(month)}-01`;
  const hasta = ymdMonthEnd(year, month);
  console.log(`\n[${year}-${pad(month)}] trayendo ventas+items de empresa ${COD_EMPRESA_SM} (${desde}…${hasta})`);

  const ventas = await fetchVentas(desde, hasta, { codEmpresa: COD_EMPRESA_SM });
  await sleep(1200);
  const items = await fetchVentasItems(desde, hasta, { codEmpresa: COD_EMPRESA_SM });
  await sleep(1200);

  // ¿IM respetó el filtro codEmpresa? Igual filtramos client-side.
  const ventasOtraEmp = ventas.filter((v) => Number.isFinite(Number(v.cod_empresa)) && Number(v.cod_empresa) !== COD_EMPRESA_SM).length;

  // cabPorId: id → { sign, codVendCab, codVendCli, codCli }
  const cabPorId = new Map();
  let nFA = 0, nNC = 0, nDescartadas = 0, nInternos = 0, nOtraEmpresaSkip = 0;
  for (const v of ventas) {
    const id = Number(v.id);
    if (!Number.isFinite(id)) { nDescartadas++; continue; }
    const codEmp = Number(v.cod_empresa);
    if (Number.isFinite(codEmp) && codEmp !== COD_EMPRESA_SM) { nOtraEmpresaSkip++; continue; }
    const clase = clasificarCabecera(v);
    if (!clase) { nDescartadas++; continue; }
    const codCli = Number(v.cod_cliente);
    if (Number.isFinite(codCli) && COD_CLIENTES_INTERNOS.has(codCli)) { nInternos++; continue; }
    const codVendCab = Number.isFinite(Number(v.cod_vendedor)) ? Number(v.cod_vendedor) : null;
    const codVendCli = clientesMap.has(codCli) ? clientesMap.get(codCli) : null;
    cabPorId.set(id, {
      sign: clase === 'NC' ? -1 : 1,
      codVendCab,
      codVendCli,
      codCli,
      excluido: excluir.has(codCli),  // decisión de negocio: no comisionar
      fecha: String(v.fecha ?? v.fa_fecha ?? '').slice(0, 10),
      tipo: tipoComprobante(v),
      numero: Number(v.numero ?? 0),
      pdv: Number(v.punto_de_venta ?? 0),
    });
    if (clase === 'FA') nFA++; else nNC++;
  }

  // Acumular por factura (neto + comisión) iterando items.
  const facturaAgg = new Map(); // id → { neto, comision, breakdown, lineas }
  let itemsProcesados = 0, itemsSinCab = 0, itemsSinPrecio = 0, netoTotal = 0;
  for (const it of items) {
    const idComp = Number(it.id_comprobante);
    const meta = cabPorId.get(idComp);
    if (!meta) { itemsSinCab++; continue; }
    const importeAbs = Number(it.importe ?? 0);
    if (!Number.isFinite(importeAbs) || importeAbs === 0) { itemsSinPrecio++; continue; }
    const importe = importeAbs * meta.sign;
    const codArt = Number(it.cod_articulo);
    if (!Number.isFinite(codArt)) { itemsSinCab++; continue; }
    const am = articulosMap.get(codArt);
    const codRubro = am?.cod_rubro ?? null;
    const detalle = String(it.detalle ?? am?.descripcion ?? '');
    const pct = pctParaArticulo(codArt, codRubro, detalle);
    const cat = categoriaParaPct(pct);
    const comision = round2(importe * pct);

    let fa = facturaAgg.get(idComp);
    if (!fa) { fa = { neto: 0, comision: 0, breakdown: emptyBreakdown(), lineas: 0 }; facturaAgg.set(idComp, fa); }
    fa.neto += importe;
    fa.comision += comision;
    fa.breakdown[cat] += importe;
    fa.lineas++;
    netoTotal += importe;
    itemsProcesados++;
  }

  // Agregar por vendedor según los DOS criterios.
  // A = vendedor de la CABECERA de la factura (como hace hoy Casa Central)
  // B = vendedor DUEÑO del cliente (maestro de clientes) ← lo que pide Mati
  function nuevoAcc() { return new Map(); }
  function sumar(acc, codVend, fa) {
    if (codVend == null) codVend = '∅'; // sin vendedor
    let a = acc.get(codVend);
    if (!a) { a = { neto: 0, comision: 0, facturas: 0, breakdown: emptyBreakdown() }; acc.set(codVend, a); }
    a.neto += fa.neto; a.comision += fa.comision; a.facturas++;
    for (const k of Object.keys(fa.breakdown)) a.breakdown[k] += fa.breakdown[k];
  }
  const accCab = nuevoAcc();
  const accCli = nuevoAcc();
  const excAgg = { neto: 0, comision: 0, facturas: 0 }; // excluidas por negocio
  const detalleFacturas = [];
  for (const [id, meta] of cabPorId.entries()) {
    const fa = facturaAgg.get(id);
    if (!fa) continue; // factura sin items con precio → no aporta
    if (meta.excluido) {
      excAgg.neto += fa.neto; excAgg.comision += fa.comision; excAgg.facturas++;
    } else {
      sumar(accCab, meta.codVendCab, fa);
      sumar(accCli, meta.codVendCli, fa);
    }
    detalleFacturas.push({
      mes: periodo,
      id, fecha: meta.fecha, tipo: meta.tipo, pdv: meta.pdv, numero: meta.numero,
      cod_cliente: meta.codCli,
      cod_vendedor_cabecera: meta.codVendCab,
      cod_vendedor_cliente: meta.codVendCli,
      excluido_comision: meta.excluido ? 'sí' : 'no',
      neto: round2(fa.neto),
      comision: round2(fa.comision),
      lineas: fa.lineas,
    });
  }

  return {
    periodo,
    excAgg,
    diag: {
      ventas_traidas: ventas.length, ventas_otra_empresa_en_respuesta: ventasOtraEmp,
      items_traidos: items.length,
      cabeceras_validas: cabPorId.size, FA: nFA, NC: nNC,
      descartadas: nDescartadas, clientes_internos: nInternos, otra_empresa_skip: nOtraEmpresaSkip,
      items_procesados: itemsProcesados, items_sin_cabecera: itemsSinCab, items_sin_precio: itemsSinPrecio,
      facturas_con_neto: facturaAgg.size,
      neto_total: round2(netoTotal),
      excluidas_negocio_fact: excAgg.facturas,
      excluidas_negocio_neto: round2(excAgg.neto),
      excluidas_negocio_comision: round2(excAgg.comision),
    },
    accCab, accCli, detalleFacturas,
  };
}

function pintarAcc(titulo, acc, vendedoresMap) {
  console.log(`\n  ── ${titulo} ──`);
  const filas = Array.from(acc.entries()).map(([cod, a]) => ({ cod, ...a }));
  filas.sort((x, y) => y.neto - x.neto);
  let totVis = { neto: 0, comision: 0, facturas: 0 };
  for (const f of filas) {
    const visible = COD_VENDEDORES_VISIBLES.has(Number(f.cod));
    const nombre = f.cod === '∅' ? 'SIN VENDEDOR' : (vendedoresMap.get(Number(f.cod)) ?? `Vendedor ${f.cod}`);
    const tag = visible ? '✔' : (f.cod === '∅' ? '∅' : '·');
    console.log(`   ${tag} [${String(f.cod).padStart(3)}] ${nombre.padEnd(22)} neto $${fmt(round2(f.neto)).padStart(15)}  comisión $${fmt(round2(f.comision)).padStart(12)}  (${f.facturas} fact)`);
    if (visible) { totVis.neto += f.neto; totVis.comision += f.comision; totVis.facturas += f.facturas; }
  }
  console.log(`   ─────────────────────────────────────────────────────────────`);
  console.log(`   TOTAL VENDEDORES VISIBLES (2,3,4,12):  neto $${fmt(round2(totVis.neto))}  comisión $${fmt(round2(totVis.comision))}  (${totVis.facturas} fact)`);
  return totVis;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' ANÁLISIS COMISIONES — Sucursal Av. San Martín (emp 2) · abr/may 2026');
  console.log(' READ-ONLY · reusa la lógica de comisiones.ts · no escribe ni envía');
  console.log('═══════════════════════════════════════════════════════════════');

  console.log('\nCargando maestro de clientes, catálogo de artículos y vendedores…');
  const clientesArr = await fetchClientesIM();
  await sleep(1000);
  const articulosMap = await fetchArticulosCatalogo();
  await sleep(1000);
  const vendedoresArr = await fetchVendedores();

  const clientesMap = new Map(); // cod_cliente → cod_vendedor
  const clientesNombre = new Map();
  for (const c of clientesArr) {
    clientesMap.set(Number(c.cod_cliente), c.cod_vendedor == null ? null : Number(c.cod_vendedor));
    clientesNombre.set(Number(c.cod_cliente), String(c.razon_social ?? ''));
  }
  const vendedoresMap = new Map();
  for (const v of vendedoresArr) vendedoresMap.set(Number(v.cod_vendedor), String(v.nombre ?? '').trim());
  console.log(`  clientes: ${clientesArr.length} · artículos: ${articulosMap.size} · vendedores: ${vendedoresArr.length}`);

  const resultados = [];
  for (const mes of MESES) {
    const r = await analizarMes(ANIO, mes, clientesMap, articulosMap);
    console.log(`\n[${r.periodo}] DIAGNÓSTICO:`, JSON.stringify(r.diag));
    console.log(`\n[${r.periodo}]  Facturas San Martín de clientes (excluidas transferencias internas): ${r.diag.facturas_con_neto}`);
    console.log(`[${r.periodo}]  Neto total facturado a esos clientes: $${fmt(r.diag.neto_total)}`);
    if (r.diag.excluidas_negocio_fact > 0) {
      console.log(`[${r.periodo}]  ⊘ EXCLUIDAS por decisión de negocio (cliente 17 BRUNO Mayra): ${r.diag.excluidas_negocio_fact} fact · neto $${fmt(r.diag.excluidas_negocio_neto)} · comisión $${fmt(r.diag.excluidas_negocio_comision)} (NO se comisionan)`);
    }
    const totA = pintarAcc('CRITERIO A — por vendedor de la CABECERA de la factura', r.accCab, vendedoresMap);
    const totB = pintarAcc('CRITERIO B — por vendedor DUEÑO del cliente (maestro) ← recomendado', r.accCli, vendedoresMap);
    r._totA = totA; r._totB = totB;
    resultados.push(r);
  }

  // ── Resumen comparativo final ──
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(' RESUMEN — COMISIÓN ADEUDADA A VENDEDORES POR VENTAS EN SAN MARTÍN');
  console.log('═══════════════════════════════════════════════════════════════');
  let granB = 0;
  for (const r of resultados) {
    console.log(`  ${r.periodo}:  por cliente (recomendado) → comisión $${fmt(round2(r._totB.comision))}   |  por cabecera → $${fmt(round2(r._totA.comision))}`);
    granB += r._totB.comision;
  }
  console.log(`  ─────────────────────────────────────────────`);
  console.log(`  TOTAL abr+may (criterio cliente):  $${fmt(round2(granB))}`);

  // ── Exportar Excel ──
  const wb = XLSX.utils.book_new();
  // Hoja resumen por vendedor/mes/criterio
  const resumenRows = [];
  for (const r of resultados) {
    for (const [criterio, acc] of [['cabecera', r.accCab], ['cliente', r.accCli]]) {
      for (const [cod, a] of acc.entries()) {
        if (cod !== '∅' && !COD_VENDEDORES_VISIBLES.has(Number(cod))) continue;
        resumenRows.push({
          mes: r.periodo, criterio,
          cod_vendedor: cod,
          vendedor: cod === '∅' ? 'SIN VENDEDOR' : (vendedoresMap.get(Number(cod)) ?? `Vendedor ${cod}`),
          visible: cod !== '∅' && COD_VENDEDORES_VISIBLES.has(Number(cod)) ? 'sí' : 'no',
          facturas: a.facturas,
          neto: round2(a.neto),
          comision: round2(a.comision),
          neto_5pct: round2(a.breakdown['5%']),
          neto_4pct: round2(a.breakdown['4%']),
          neto_3_5pct: round2(a.breakdown['3.5%']),
          neto_1pct: round2(a.breakdown['1%']),
        });
      }
    }
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(resumenRows), 'Resumen_por_vendedor');

  // Hoja detalle de facturas (para cruzar con el Excel manual de Mati)
  const detalleRows = [];
  for (const r of resultados) {
    for (const d of r.detalleFacturas) {
      detalleRows.push({
        ...d,
        razon_social: clientesNombre.get(d.cod_cliente) ?? '',
        vendedor_cabecera: d.cod_vendedor_cabecera == null ? '' : (vendedoresMap.get(d.cod_vendedor_cabecera) ?? d.cod_vendedor_cabecera),
        vendedor_cliente: d.cod_vendedor_cliente == null ? 'SIN VENDEDOR' : (vendedoresMap.get(d.cod_vendedor_cliente) ?? d.cod_vendedor_cliente),
        cliente_es_de_vendedor_visible: d.cod_vendedor_cliente != null && COD_VENDEDORES_VISIBLES.has(d.cod_vendedor_cliente) ? 'sí' : 'no',
      });
    }
  }
  detalleRows.sort((a, b) => (a.mes.localeCompare(b.mes)) || (b.neto - a.neto));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detalleRows), 'Detalle_facturas_SM');

  const outPath = join(homedir(), 'Downloads', 'comisiones_san_martin_abr_may_2026.xlsx');
  XLSX.writeFile(wb, outPath);
  console.log(`\n📄 Excel guardado en: ${outPath}`);

  // JSON crudo por las dudas
  const jsonPath = join(homedir(), 'Downloads', 'comisiones_san_martin_abr_may_2026.json');
  writeFileSync(jsonPath, JSON.stringify(resultados.map((r) => ({
    periodo: r.periodo, diag: r.diag,
    porCabecera: Object.fromEntries(r.accCab), porCliente: Object.fromEntries(r.accCli),
  })), null, 2));
  console.log(`📄 JSON guardado en: ${jsonPath}`);
}

main().catch((e) => { console.error('ERROR:', e?.message ?? e); process.exit(1); });
