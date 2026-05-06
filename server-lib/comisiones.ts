import type { Request, Response } from 'express';
import type { JwtPayload } from './auth.js';
import { sb, hasSupabase } from './supabase.js';
import { fetchVendedores, fetchArticulosCatalogo } from './infomanager.js';
import { getMonthlyVentasRaw, getMonthlyItemsRaw } from './snapshotCache.js';
import { tipoComprobante, isAnulada } from '../src/utils/ventas.js';
import { getCached as getResponseCached, setCached as setResponseCached } from './goalsResponseCache.js';
import {
  pctParaArticulo,
  categoriaParaPct,
  CATEGORIA_LABELS,
  type CategoriaComision,
} from './comisionesRules.js';

// Mati confirmó 06/05: Andrea (cod=6, backoffice) no entra en el cálculo
// manual de comisiones aunque tenga ventas asignadas. Solo los 4 vendedores
// de calle. Si en el futuro se decide incluirla, agregar 6 al set.
const COD_VENDEDORES_VISIBLES = new Set([2, 3, 4, 12]);

// Clientes internos = sucursales propias. Las "ventas" a estos clientes son
// transferencias entre depósitos, no ventas comerciales. NO se les paga
// comisión. Lista alineada con `semillero-existencias/src/lib/infomanager.ts`.
//   1   = Casa Central
//   652 = San Martín (sucursal)
//   666 = Santo Cristo (sucursal)
//   861 = sucursal adicional
const COD_CLIENTES_INTERNOS = new Set([1, 652, 666, 861]);

// Solo Casa Central (cod_empresa=1) cuenta para comisiones del equipo de
// vendedores Casa Central. Las sucursales tienen sus propios vendedores y
// estructura de comisión independiente. Confirmado por Mati 06/05/2026.
const COD_EMPRESA_CASA_CENTRAL = 1;

interface BreakdownEntry { neto: number; comision: number; lineas: number }
interface ComisionVendedor {
  cod_vendedor: number;
  nombre: string;
  email: string | null;
  activo: boolean;
  neto_total: number;
  comision_total: number;
  num_lineas: number;
  num_comprobantes: number;
  breakdown: Record<CategoriaComision, BreakdownEntry>;
}

function emptyBreakdown(): Record<CategoriaComision, BreakdownEntry> {
  return {
    '5.5%': { neto: 0, comision: 0, lineas: 0 },
    '4%':   { neto: 0, comision: 0, lineas: 0 },
    '3.5%': { neto: 0, comision: 0, lineas: 0 },
    '1%':   { neto: 0, comision: 0, lineas: 0 },
  };
}

interface GetComisionesOpts {
  year: number;
  month: number;
  codVendedorFilter?: number;
}

/**
 * Tipo del comprobante: 'FA' (suma), 'NC' (resta), o null (no cuenta).
 * - F* (FA, FB, FC, FD, FE, FAC, FACT) → FA
 * - NC* → NC
 * - ND, PR, RC, RE, etc. → null (excluido)
 * - anulada=S → null (excluido)
 */
function clasificarCabecera(cab: any): 'FA' | 'NC' | null {
  if (isAnulada(cab)) return null;
  const tipo = tipoComprobante(cab);
  if (tipo.startsWith('ND')) return null;
  if (tipo.startsWith('NC')) return 'NC';
  if (tipo.startsWith('F')) return 'FA';
  return null;
}

export async function getComisionesData(opts: GetComisionesOpts) {
  const { year, month, codVendedorFilter } = opts;

  // 1. Datos crudos paralelos.
  const [ventasRes, itemsRes, articulosMap, vendedoresIM] = await Promise.all([
    getMonthlyVentasRaw(year, month),
    getMonthlyItemsRaw(year, month),
    fetchArticulosCatalogo(),
    fetchVendedores(),
  ]);

  // 2. Map id_comprobante → { signo (FA=+1, NC=-1), cod_vendedor }.
  // Solo cabeceras válidas. Las inválidas (PR, ND, anuladas) quedan fuera y
  // sus items se descartan automáticamente en el loop.
  const cabPorId = new Map<number, { sign: 1 | -1; cod_vendedor: number; tipo: string }>();
  let nFA = 0, nNC = 0, nDescartadas = 0, nClientesInternos = 0, nOtraEmpresa = 0;
  for (const v of ventasRes.ventas) {
    const id = Number((v as any).id);
    if (!Number.isFinite(id)) { nDescartadas++; continue; }
    // Filtrar empresas: solo Casa Central (cod_empresa=1) suma a estas
    // comisiones. Sucursales tienen su propia estructura.
    const codEmp = Number((v as any).cod_empresa);
    if (Number.isFinite(codEmp) && codEmp !== COD_EMPRESA_CASA_CENTRAL) {
      nOtraEmpresa++;
      continue;
    }
    const clase = clasificarCabecera(v);
    if (!clase) { nDescartadas++; continue; }
    const codVend = Number((v as any).cod_vendedor);
    if (!Number.isFinite(codVend)) { nDescartadas++; continue; }
    // Excluir transferencias entre sucursales — no son ventas comerciales.
    const codCli = Number((v as any).cod_cliente);
    if (Number.isFinite(codCli) && COD_CLIENTES_INTERNOS.has(codCli)) {
      nClientesInternos++;
      continue;
    }
    cabPorId.set(id, {
      sign: clase === 'NC' ? -1 : 1,
      cod_vendedor: codVend,
      tipo: tipoComprobante(v),
    });
    if (clase === 'FA') nFA++; else nNC++;
  }

  // 3. Iterar items: cada uno tiene importe directo de la API.
  const acc = new Map<number, ComisionVendedor>();
  const compsTocados = new Map<number, Set<number>>();
  let primerItemLogueado = false;
  let itemsProcesados = 0;
  let itemsDescartados = 0;
  let itemsSinPrecio = 0;
  let netoFA = 0, netoNC = 0;

  for (const it of itemsRes.items) {
    if (!primerItemLogueado) {
      primerItemLogueado = true;
      console.log('[comisiones] sample item:', JSON.stringify(it).slice(0, 400));
    }
    const idComp = Number(it.id_comprobante);
    const meta = cabPorId.get(idComp);
    if (!meta) { itemsDescartados++; continue; }

    // Importe ya viene calculado por IM con descuento aplicado: precio*cantidad
    // (donde precio = precio_orig * (1 - descuento_porc/100)).
    const importeAbs = Number(it.importe ?? 0);
    if (!Number.isFinite(importeAbs) || importeAbs === 0) {
      itemsSinPrecio++;
      // No cuenta: ítems con descuento 100% (regalos), ITEMS_VACIO, etc.
      continue;
    }
    const importe = importeAbs * meta.sign;

    const codArt = Number(it.cod_articulo);  // viene como string en la API
    if (!Number.isFinite(codArt)) { itemsDescartados++; continue; }
    const articuloMeta = articulosMap.get(codArt);
    const codRubro = articuloMeta?.cod_rubro ?? null;
    // Detalle viene en el item directo; si no, fallback al catálogo.
    const detalle = String((it as any).detalle ?? articuloMeta?.descripcion ?? '');
    const pct = pctParaArticulo(codArt, codRubro, detalle);
    const cat = categoriaParaPct(pct);
    const comision = Math.round(importe * pct * 100) / 100;

    let v = acc.get(meta.cod_vendedor);
    if (!v) {
      const vIm = (vendedoresIM ?? []).find((x: any) => Number(x.cod_vendedor) === meta.cod_vendedor);
      v = {
        cod_vendedor: meta.cod_vendedor,
        nombre: String(vIm?.nombre ?? `Vendedor ${meta.cod_vendedor}`),
        email: null,
        activo: true,
        neto_total: 0,
        comision_total: 0,
        num_lineas: 0,
        num_comprobantes: 0,
        breakdown: emptyBreakdown(),
      };
      acc.set(meta.cod_vendedor, v);
      compsTocados.set(meta.cod_vendedor, new Set());
    }
    v.neto_total += importe;
    v.comision_total += comision;
    v.num_lineas += 1;
    v.breakdown[cat].neto += importe;
    v.breakdown[cat].comision += comision;
    v.breakdown[cat].lineas += 1;
    compsTocados.get(meta.cod_vendedor)!.add(idComp);
    itemsProcesados++;
    if (importe > 0) netoFA += importe; else netoNC += importe;
  }

  // 4. Redondeo final + comprobantes.
  for (const v of acc.values()) {
    v.neto_total = Math.round(v.neto_total * 100) / 100;
    v.comision_total = Math.round(v.comision_total * 100) / 100;
    v.num_comprobantes = compsTocados.get(v.cod_vendedor)?.size ?? 0;
    for (const cat of Object.keys(v.breakdown) as CategoriaComision[]) {
      v.breakdown[cat].neto = Math.round(v.breakdown[cat].neto * 100) / 100;
      v.breakdown[cat].comision = Math.round(v.breakdown[cat].comision * 100) / 100;
    }
  }

  // 5. Enriquecer con datos de Supabase.
  if (hasSupabase()) {
    const cods = Array.from(acc.keys());
    if (cods.length) {
      const { data: usuarios } = await sb()
        .from('usuarios')
        .select('cod_vendedor, email, activo, nombre')
        .in('cod_vendedor', cods);
      for (const u of usuarios ?? []) {
        const v = acc.get(Number(u.cod_vendedor));
        if (!v) continue;
        v.email = u.email ?? null;
        v.activo = u.activo !== false;
        if (u.nombre) v.nombre = String(u.nombre);
      }
    }
  }

  // 6. Filtros.
  let items = Array.from(acc.values());
  if (codVendedorFilter != null) {
    items = items.filter(v => v.cod_vendedor === codVendedorFilter);
  } else {
    items = items.filter(v => COD_VENDEDORES_VISIBLES.has(v.cod_vendedor));
  }
  items.sort((a, b) => b.comision_total - a.comision_total);

  // 7. Totales globales.
  const totales = {
    neto_total: Math.round(items.reduce((s, v) => s + v.neto_total, 0) * 100) / 100,
    comision_total: Math.round(items.reduce((s, v) => s + v.comision_total, 0) * 100) / 100,
    num_lineas: items.reduce((s, v) => s + v.num_lineas, 0),
    num_comprobantes: items.reduce((s, v) => s + v.num_comprobantes, 0),
    breakdown: emptyBreakdown(),
  };
  for (const v of items) {
    for (const cat of Object.keys(v.breakdown) as CategoriaComision[]) {
      totales.breakdown[cat].neto += v.breakdown[cat].neto;
      totales.breakdown[cat].comision += v.breakdown[cat].comision;
      totales.breakdown[cat].lineas += v.breakdown[cat].lineas;
    }
  }
  for (const cat of Object.keys(totales.breakdown) as CategoriaComision[]) {
    totales.breakdown[cat].neto = Math.round(totales.breakdown[cat].neto * 100) / 100;
    totales.breakdown[cat].comision = Math.round(totales.breakdown[cat].comision * 100) / 100;
  }

  // 8. Diagnóstico.
  const diag = {
    cabeceras_total: ventasRes.ventas.length,
    cabeceras_validas: cabPorId.size,
    cabeceras_FA: nFA,
    cabeceras_NC: nNC,
    cabeceras_descartadas: nDescartadas,
    cabeceras_clientes_internos_excluidas: nClientesInternos,
    cabeceras_otra_empresa_excluidas: nOtraEmpresa,
    items_total: itemsRes.items.length,
    items_procesados: itemsProcesados,
    items_descartados_sin_cabecera: itemsDescartados,
    items_sin_precio: itemsSinPrecio,
    neto_FA: Math.round(netoFA * 100) / 100,
    neto_NC: Math.round(netoNC * 100) / 100,
    neto_global_items: Math.round((netoFA + netoNC) * 100) / 100,
  };
  console.log(`[comisiones] ${year}-${String(month).padStart(2, '0')}:`, JSON.stringify(diag));

  return {
    year,
    month,
    items,
    totales,
    categoria_labels: CATEGORIA_LABELS,
    diagnostico: diag,
    cache_info: {
      ventas_cached: ventasRes.cached,
      items_cached: itemsRes.cached,
    },
  };
}

/**
 * GET /api/comisiones/sample?year=&month=  (admin)
 *
 * Devuelve las primeras 3 cabeceras + primeros 5 items del cache crudo y un
 * intento de pegar `/ventas/{id}` con el id de la primera cabecera. Sirve
 * para confirmar shape real de la API IM sin tener que conocer IDs internos.
 */
export async function comisionesSample(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const user = req.user!;
    if (user.rol !== 'admin' && user.rol !== 'gerente') {
      res.status(403).json({ error: 'Requiere admin/gerente' }); return;
    }
    const t = new Date();
    const year = Number(req.query.year) || t.getUTCFullYear();
    const month = Number(req.query.month) || (t.getUTCMonth() + 1);

    const [ventasRes, itemsRes] = await Promise.all([
      getMonthlyVentasRaw(year, month),
      getMonthlyItemsRaw(year, month),
    ]);

    const sampleCabs = ventasRes.ventas.slice(0, 3);
    const sampleItems = itemsRes.items.slice(0, 5);

    let detalle: any = null;
    let detalleErr: string | null = null;
    let probedId: any = null;
    if (sampleCabs.length > 0) {
      probedId = (sampleCabs[0] as any).id;
      try {
        const { imClient } = await import('./infomanager.js');
        const cli = await imClient();
        const r = await cli.get(`/ventas/${probedId}`);
        detalle = r.data;
      } catch (e: any) {
        detalleErr = e?.response?.status ? `HTTP ${e.response.status}: ${JSON.stringify(e.response.data ?? '').slice(0, 200)}` : String(e?.message ?? e);
      }
    }

    res.json({
      ok: true,
      year, month,
      cabeceras_total: ventasRes.ventas.length,
      items_total: itemsRes.items.length,
      sample_cabeceras: sampleCabs,
      sample_items: sampleItems,
      probed_id_para_detalle: probedId,
      detalle_via_ventas_id: detalle,
      detalle_error: detalleErr,
    });
  } catch (err: any) {
    console.error('comisionesSample error:', err);
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/**
 * GET /api/comisiones/probe-venta/:id  (admin) — debug temporal.
 */
export async function probeVenta(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const user = req.user!;
    if (user.rol !== 'admin' && user.rol !== 'gerente') {
      res.status(403).json({ error: 'Requiere admin/gerente' }); return;
    }
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: 'id inválido' }); return; }
    const { imClient } = await import('./infomanager.js');
    const cli = await imClient();
    let detalle: any = null;
    let detalleErr: string | null = null;
    try {
      const r = await cli.get(`/ventas/${id}`);
      detalle = r.data;
    } catch (e: any) {
      detalleErr = e?.response?.status ? `HTTP ${e.response.status}` : String(e?.message ?? e);
    }
    const t = new Date();
    const year = Number(req.query.year) || t.getUTCFullYear();
    const month = Number(req.query.month) || (t.getUTCMonth() + 1);
    const itemsRes = await getMonthlyItemsRaw(year, month);
    const itemsDeEstaVenta = itemsRes.items.filter(i => Number(i.id_comprobante) === id);
    const ventasRes = await getMonthlyVentasRaw(year, month);
    const cab = ventasRes.ventas.find((v: any) => Number(v.id) === id) ?? null;
    res.json({
      ok: true,
      id_venta: id,
      cabecera: cab,
      items_de_esta_venta_via_ventas_items: itemsDeEstaVenta,
      detalle_via_ventas_id: detalle,
      detalle_error: detalleErr,
    });
  } catch (err: any) {
    console.error('probeVenta error:', err);
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/**
 * GET /api/comisiones/top-articulos?year=&month=&top=10  (admin)
 *
 * Devuelve los TOP N artículos por neto, agrupados por categoría de comisión.
 * Sirve para detectar artículos mal clasificados (ej: accesorios que caen en
 * "resto" porque su cod_rubro no es 11).
 */
export async function topArticulos(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const user = req.user!;
    if (user.rol !== 'admin' && user.rol !== 'gerente') {
      res.status(403).json({ error: 'Requiere admin/gerente' }); return;
    }
    const t = new Date();
    const year = Number(req.query.year) || t.getUTCFullYear();
    const month = Number(req.query.month) || (t.getUTCMonth() + 1);
    const topN = Math.min(50, Math.max(5, Number(req.query.top) || 10));

    const [ventasRes, itemsRes, articulosMap] = await Promise.all([
      getMonthlyVentasRaw(year, month),
      getMonthlyItemsRaw(year, month),
      fetchArticulosCatalogo(),
    ]);

    // Misma lógica de filtro de cabeceras que getComisionesData.
    const cabPorId = new Map<number, { sign: 1 | -1 }>();
    for (const v of ventasRes.ventas) {
      const id = Number((v as any).id);
      const clase = clasificarCabecera(v);
      const codEmp = Number((v as any).cod_empresa);
      const codCli = Number((v as any).cod_cliente);
      if (!Number.isFinite(id) || !clase) continue;
      if (Number.isFinite(codEmp) && codEmp !== COD_EMPRESA_CASA_CENTRAL) continue;
      if (Number.isFinite(codCli) && COD_CLIENTES_INTERNOS.has(codCli)) continue;
      cabPorId.set(id, { sign: clase === 'NC' ? -1 : 1 });
    }

    // Agregar por (cod_articulo, categoría).
    interface ArtAcc {
      cod_articulo: number;
      detalle: string;
      cod_rubro: number | null;
      categoria: CategoriaComision;
      pct: number;
      neto: number;
      cantidad_total: number;
      lineas: number;
    }
    const acc = new Map<number, ArtAcc>();
    for (const it of itemsRes.items) {
      const meta = cabPorId.get(Number(it.id_comprobante));
      if (!meta) continue;
      const importeAbs = Number(it.importe ?? 0);
      if (!Number.isFinite(importeAbs) || importeAbs === 0) continue;
      const importe = importeAbs * meta.sign;
      const codArt = Number(it.cod_articulo);
      if (!Number.isFinite(codArt)) continue;
      const am = articulosMap.get(codArt);
      const codRubro = am?.cod_rubro ?? null;
      const detalle = String((it as any).detalle ?? am?.descripcion ?? '');
      const pct = pctParaArticulo(codArt, codRubro, detalle);
      const cat = categoriaParaPct(pct);
      let a = acc.get(codArt);
      if (!a) {
        a = {
          cod_articulo: codArt,
          detalle: String((it as any).detalle ?? am?.descripcion ?? '').trim(),
          cod_rubro: codRubro,
          categoria: cat,
          pct,
          neto: 0, cantidad_total: 0, lineas: 0,
        };
        acc.set(codArt, a);
      }
      a.neto += importe;
      a.cantidad_total += Number(it.cantidad ?? 0);
      a.lineas += 1;
    }

    // Por categoría, top N por neto.
    const porCategoria: Record<CategoriaComision, ArtAcc[]> = {
      '5.5%': [], '4%': [], '3.5%': [], '1%': [],
    };
    for (const a of acc.values()) {
      porCategoria[a.categoria].push(a);
    }
    for (const cat of Object.keys(porCategoria) as CategoriaComision[]) {
      porCategoria[cat].sort((x, y) => Math.abs(y.neto) - Math.abs(x.neto));
      porCategoria[cat] = porCategoria[cat].slice(0, topN).map(a => ({
        ...a,
        neto: Math.round(a.neto * 100) / 100,
      }));
    }

    res.json({ ok: true, year, month, top: topN, top_por_categoria: porCategoria, categoria_labels: CATEGORIA_LABELS });
  } catch (err: any) {
    console.error('topArticulos error:', err);
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/**
 * GET /api/comisiones/facturas-vendedor?year=&month=&cod_vendedor=  (admin)
 *
 * Lista TODAS las facturas (cabeceras + total por categoría de comisión) de
 * un vendedor específico para que Mati pueda comparar contra su Excel
 * manual y encontrar discrepancias (facturas duplicadas, asignación
 * incorrecta a un vendedor, etc.).
 */
export async function facturasVendedor(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const user = req.user!;
    if (user.rol !== 'admin' && user.rol !== 'gerente') {
      res.status(403).json({ error: 'Requiere admin/gerente' }); return;
    }
    const t = new Date();
    const year = Number(req.query.year) || t.getUTCFullYear();
    const month = Number(req.query.month) || (t.getUTCMonth() + 1);
    const codVend = Number(req.query.cod_vendedor);
    if (!Number.isFinite(codVend)) {
      res.status(400).json({ error: 'cod_vendedor requerido' }); return;
    }

    const [ventasRes, itemsRes, articulosMap] = await Promise.all([
      getMonthlyVentasRaw(year, month),
      getMonthlyItemsRaw(year, month),
      fetchArticulosCatalogo(),
    ]);

    // Solo cabeceras de Casa Central, válidas (FA/NC), no clientes internos,
    // y del vendedor pedido.
    const cabsValidas = new Map<number, any>();
    for (const v of ventasRes.ventas) {
      const id = Number((v as any).id);
      if (!Number.isFinite(id)) continue;
      const codEmp = Number((v as any).cod_empresa);
      if (Number.isFinite(codEmp) && codEmp !== COD_EMPRESA_CASA_CENTRAL) continue;
      const clase = clasificarCabecera(v);
      if (!clase) continue;
      const cVend = Number((v as any).cod_vendedor);
      if (cVend !== codVend) continue;
      const codCli = Number((v as any).cod_cliente);
      if (Number.isFinite(codCli) && COD_CLIENTES_INTERNOS.has(codCli)) continue;
      cabsValidas.set(id, { cab: v, sign: clase === 'NC' ? -1 : 1 });
    }

    // Acumular por id_comprobante.
    interface FactDetail {
      id: number;
      tipo: string;
      tipo_factura: string;
      numero: number;
      punto_de_venta: number;
      fecha: string;
      cod_cliente: number;
      neto_calculado: number;        // suma de items × signo
      neto_cabecera: number;         // del campo `neto`/`fa_total` de la cabecera
      breakdown: Record<CategoriaComision, number>;  // monto neto por categoría
      lineas: number;
    }
    const facturas: FactDetail[] = [];
    for (const [idComp, info] of cabsValidas.entries()) {
      const { cab, sign } = info;
      const fd: FactDetail = {
        id: idComp,
        tipo: String(cab.tipo_comprobante ?? cab.tipo ?? ''),
        tipo_factura: String(cab.tipo_factura ?? ''),
        numero: Number(cab.numero ?? 0),
        punto_de_venta: Number(cab.punto_de_venta ?? 0),
        fecha: String(cab.fecha ?? ''),
        cod_cliente: Number(cab.cod_cliente ?? 0),
        neto_calculado: 0,
        neto_cabecera: Math.round((Number(cab.neto ?? cab.total ?? cab.fa_total ?? 0) * sign) * 100) / 100,
        breakdown: { '5.5%': 0, '4%': 0, '3.5%': 0, '1%': 0 },
        lineas: 0,
      };
      facturas.push(fd);
    }

    // Indexar items por id_comprobante.
    const itemsPorComp = new Map<number, any[]>();
    for (const it of itemsRes.items) {
      const idC = Number(it.id_comprobante);
      if (!cabsValidas.has(idC)) continue;
      let arr = itemsPorComp.get(idC);
      if (!arr) { arr = []; itemsPorComp.set(idC, arr); }
      arr.push(it);
    }

    // Calcular breakdown por factura.
    for (const fd of facturas) {
      const lineas = itemsPorComp.get(fd.id) ?? [];
      const sign = cabsValidas.get(fd.id)!.sign;
      for (const it of lineas) {
        const importeAbs = Number(it.importe ?? 0);
        if (!Number.isFinite(importeAbs) || importeAbs === 0) continue;
        const importe = importeAbs * sign;
        const codArt = Number(it.cod_articulo);
        if (!Number.isFinite(codArt)) continue;
        const am = articulosMap.get(codArt);
        const codRubro = am?.cod_rubro ?? null;
        const detalle = String((it as any).detalle ?? am?.descripcion ?? '');
        const pct = pctParaArticulo(codArt, codRubro, detalle);
        const cat = categoriaParaPct(pct);
        fd.breakdown[cat] += importe;
        fd.neto_calculado += importe;
        fd.lineas++;
      }
      // Redondeos
      fd.neto_calculado = Math.round(fd.neto_calculado * 100) / 100;
      for (const k of Object.keys(fd.breakdown) as CategoriaComision[]) {
        fd.breakdown[k] = Math.round(fd.breakdown[k] * 100) / 100;
      }
    }
    facturas.sort((a, b) => Math.abs(b.neto_calculado) - Math.abs(a.neto_calculado));

    const totalNeto = facturas.reduce((s, f) => s + f.neto_calculado, 0);

    res.json({
      ok: true,
      year, month, cod_vendedor: codVend,
      total_facturas: facturas.length,
      total_neto: Math.round(totalNeto * 100) / 100,
      facturas,
    });
  } catch (err: any) {
    console.error('facturasVendedor error:', err);
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/** GET /api/comisiones */
export async function listComisiones(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    if (!hasSupabase()) { res.status(500).json({ error: 'Supabase no configurado' }); return; }
    const user = req.user!;
    const t = new Date();
    const year = Number(req.query.year) || t.getUTCFullYear();
    const month = Number(req.query.month) || (t.getUTCMonth() + 1);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      res.status(400).json({ error: 'year/month inválidos' }); return;
    }

    const isAdmin = user.rol === 'admin' || user.rol === 'gerente';
    let codVendedorFilter: number | undefined;
    if (!isAdmin) {
      const codVendedor = (user as any).cod_vendedor;
      if (!Number.isFinite(Number(codVendedor))) {
        res.status(403).json({ error: 'Tu usuario no tiene cod_vendedor asignado' }); return;
      }
      codVendedorFilter = Number(codVendedor);
    } else if (req.query.cod_vendedor) {
      const c = Number(req.query.cod_vendedor);
      if (Number.isFinite(c)) codVendedorFilter = c;
    }

    const cacheKey = `comisiones:${year}-${month}:${codVendedorFilter ?? 'all'}`;
    const hit = getResponseCached(cacheKey);
    if (hit) { res.set('X-Cache', 'HIT').json(hit); return; }

    const data = await getComisionesData({ year, month, codVendedorFilter });
    const body = { ok: true, ...data };
    setResponseCached(cacheKey, body);
    res.set('X-Cache', 'MISS').json(body);
  } catch (err: any) {
    console.error('listComisiones error:', err);
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}
