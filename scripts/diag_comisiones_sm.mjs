/**
 * DIAGNÓSTICO FINO (read-only) para validar el análisis de comisiones de
 * San Martín. Responde 4 preguntas antes de darle un número a Mati:
 *
 *  1. ¿Los id_comprobante son únicos entre empresas? (si no, el match
 *     items↔cabeceras estaría inflando el neto)
 *  2. ¿Qué compone el "mostrador" (vendedor 0)? ¿Es un cliente genérico o
 *     clientes reales sin vendedor asignado?
 *  3. EL AGUJERO INVISIBLE: ¿hay facturas con cabecera vendedor=0 cuyo cliente,
 *     en el maestro, SÍ pertenece a un vendedor visible? (esos serían clientes
 *     de vendedor facturados como mostrador → comisión perdida no detectada)
 *  4. Detalle de las facturas de vendedores visibles (con nombre de cliente).
 *
 * No escribe ni envía nada.
 * Uso: node --env-file=.env scripts/diag_comisiones_sm.mjs
 */
import {
  fetchVentas, fetchVentasItems, fetchArticulosCatalogo,
  fetchClientesIM, fetchVendedores,
} from '../dist-server/server-lib/infomanager.js';
import { pctParaArticulo } from '../dist-server/server-lib/comisionesRules.js';
import { COD_CLIENTES_INTERNOS, COD_VENDEDORES_VISIBLES } from '../dist-server/server-lib/comisionesShared.js';
import { tipoComprobante, isAnulada } from '../dist-server/src/utils/ventas.js';

const COD_EMPRESA_SM = 2;
const ANIO = 2026;
const MESES = [4, 5];
const pad = (n) => String(n).padStart(2, '0');
const round2 = (n) => Math.round(n * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function ymdMonthEnd(y, m) { return `${y}-${pad(m)}-${pad(new Date(y, m, 0).getDate())}`; }
function clasificarCabecera(cab) {
  if (isAnulada(cab)) return null;
  const t = tipoComprobante(cab);
  if (t.startsWith('ND')) return null;
  if (t.startsWith('NC')) return 'NC';
  if (t.startsWith('F')) return 'FA';
  return null;
}

async function main() {
  const clientesArr = await fetchClientesIM(); await sleep(1000);
  const articulosMap = await fetchArticulosCatalogo(); await sleep(1000);
  const vendedoresArr = await fetchVendedores();
  const cliVend = new Map(), cliNombre = new Map();
  for (const c of clientesArr) { cliVend.set(Number(c.cod_cliente), c.cod_vendedor == null ? null : Number(c.cod_vendedor)); cliNombre.set(Number(c.cod_cliente), String(c.razon_social ?? '')); }
  const vendName = new Map(); for (const v of vendedoresArr) vendName.set(Number(v.cod_vendedor), String(v.nombre ?? '').trim());

  for (const mes of MESES) {
    const desde = `${ANIO}-${pad(mes)}-01`, hasta = ymdMonthEnd(ANIO, mes);
    console.log(`\n══════════ ${ANIO}-${pad(mes)} ══════════`);
    const ventas = await fetchVentas(desde, hasta, { codEmpresa: COD_EMPRESA_SM }); await sleep(1200);
    const items = await fetchVentasItems(desde, hasta, { codEmpresa: COD_EMPRESA_SM }); await sleep(1200);

    // (1) Unicidad de id_comprobante entre empresas
    const idEmpresas = new Map(); // id → Set(cod_empresa)
    for (const v of ventas) {
      const id = Number(v.id), e = Number(v.cod_empresa);
      if (!Number.isFinite(id)) continue;
      if (!idEmpresas.has(id)) idEmpresas.set(id, new Set());
      idEmpresas.get(id).add(e);
    }
    const idsColision = [...idEmpresas.entries()].filter(([, s]) => s.size > 1);
    console.log(`(1) IDs con >1 empresa (colisión): ${idsColision.length}  ${idsColision.slice(0, 3).map(([id, s]) => `${id}:{${[...s]}}`).join(' ')}`);

    // Cabeceras válidas empresa 2
    const cab = new Map(); // id → {sign, vCab, vCli, cli}
    for (const v of ventas) {
      const id = Number(v.id);
      if (!Number.isFinite(id) || Number(v.cod_empresa) !== COD_EMPRESA_SM) continue;
      const clase = clasificarCabecera(v); if (!clase) continue;
      const cli = Number(v.cod_cliente);
      if (COD_CLIENTES_INTERNOS.has(cli)) continue;
      cab.set(id, {
        sign: clase === 'NC' ? -1 : 1,
        vCab: Number.isFinite(Number(v.cod_vendedor)) ? Number(v.cod_vendedor) : null,
        vCli: cliVend.has(cli) ? cliVend.get(cli) : null,
        cli, fecha: String(v.fecha ?? '').slice(0, 10), tipo: tipoComprobante(v),
      });
    }
    // Neto/comisión por factura
    const fa = new Map();
    for (const it of items) {
      const id = Number(it.id_comprobante); const m = cab.get(id); if (!m) continue;
      const imp = Number(it.importe ?? 0); if (!Number.isFinite(imp) || imp === 0) continue;
      const importe = imp * m.sign;
      const codArt = Number(it.cod_articulo); if (!Number.isFinite(codArt)) continue;
      const am = articulosMap.get(codArt);
      const pct = pctParaArticulo(codArt, am?.cod_rubro ?? null, String(it.detalle ?? am?.descripcion ?? ''));
      let f = fa.get(id); if (!f) { f = { neto: 0, com: 0 }; fa.set(id, f); }
      f.neto += importe; f.com += round2(importe * pct);
    }

    // (2) Composición mostrador (vCab===0): top clientes por neto
    const mostradorPorCli = new Map();
    let mostradorFact = 0, mostradorNeto = 0;
    for (const [id, m] of cab) {
      if (m.vCab !== 0) continue;
      const f = fa.get(id); if (!f) continue;
      mostradorFact++; mostradorNeto += f.neto;
      let a = mostradorPorCli.get(m.cli); if (!a) { a = { neto: 0, fact: 0, vCli: m.vCli }; mostradorPorCli.set(m.cli, a); }
      a.neto += f.neto; a.fact++;
    }
    console.log(`(2) MOSTRADOR (cabecera vendedor 0): ${mostradorFact} fact · neto $${fmt(round2(mostradorNeto))} · ${mostradorPorCli.size} clientes distintos`);
    const topMost = [...mostradorPorCli.entries()].sort((a, b) => b[1].neto - a[1].neto).slice(0, 12);
    for (const [cli, a] of topMost) {
      console.log(`     cli ${String(cli).padStart(6)} ${String(cliNombre.get(cli) ?? '?').slice(0, 32).padEnd(32)} neto $${fmt(round2(a.neto)).padStart(14)} (${a.fact} fact) vendedor_maestro=${a.vCli}`);
    }

    // (3) AGUJERO INVISIBLE: cabecera vendedor 0 PERO cliente pertenece a vendedor visible
    let agujero = 0, agujeroNeto = 0; const agujeroEj = [];
    for (const [id, m] of cab) {
      if (m.vCab === 0 && m.vCli != null && COD_VENDEDORES_VISIBLES.has(m.vCli)) {
        const f = fa.get(id); if (!f) continue;
        agujero++; agujeroNeto += f.neto;
        if (agujeroEj.length < 8) agujeroEj.push(`id${id} cli${m.cli}(${cliNombre.get(m.cli) ?? '?'}) →vend${m.vCli} $${fmt(round2(f.neto))}`);
      }
    }
    console.log(`(3) AGUJERO INVISIBLE (cabecera=0 pero cliente es de vendedor visible): ${agujero} fact · $${fmt(round2(agujeroNeto))}`);
    for (const e of agujeroEj) console.log(`     ${e}`);

    // (3b) Inconsistencias: cabecera vendedor visible distinto del vendedor del cliente
    let inconsist = 0; const inconsEj = [];
    for (const [id, m] of cab) {
      if (m.vCab != null && COD_VENDEDORES_VISIBLES.has(m.vCab) && m.vCli != null && m.vCab !== m.vCli) {
        inconsist++;
        if (inconsEj.length < 8) inconsEj.push(`id${id} cli${m.cli} cab=${m.vCab} maestro=${m.vCli}`);
      }
    }
    console.log(`(3b) Facturas con vendedor de cabecera VISIBLE ≠ vendedor del cliente en maestro: ${inconsist}`);
    for (const e of inconsEj) console.log(`     ${e}`);

    // (4) Detalle facturas de vendedores visibles (por cabecera)
    console.log(`(4) DETALLE facturas de vendedores visibles:`);
    const vis = [...cab.entries()].filter(([, m]) => m.vCab != null && COD_VENDEDORES_VISIBLES.has(m.vCab))
      .map(([id, m]) => ({ id, ...m, ...(fa.get(id) ?? { neto: 0, com: 0 }) }))
      .sort((a, b) => b.neto - a.neto);
    for (const f of vis) {
      console.log(`     ${f.fecha} ${f.tipo.padEnd(4)} id${String(f.id).padStart(8)} vend ${f.vCab}(${vendName.get(f.vCab)}) cli ${String(f.cli).padStart(6)} ${String(cliNombre.get(f.cli) ?? '?').slice(0, 26).padEnd(26)} neto $${fmt(round2(f.neto)).padStart(13)} com $${fmt(round2(f.com)).padStart(10)}`);
    }
    const totN = vis.reduce((s, f) => s + f.neto, 0), totC = vis.reduce((s, f) => s + f.com, 0);
    console.log(`     ── TOTAL: ${vis.length} fact · neto $${fmt(round2(totN))} · comisión $${fmt(round2(totC))}`);
  }
}
main().catch((e) => { console.error('ERROR:', e?.message ?? e); process.exit(1); });
