import type { Request, Response } from 'express';
import type { JwtPayload } from './auth.js';
import { sb, hasSupabase } from './supabase.js';
import { fetchVendedores, fetchArticulosCatalogo, fetchClientesIMCached } from './infomanager.js';
import { getMonthlyVentasRaw, getMonthlyItemsRaw } from './snapshotCache.js';
import { tipoComprobante, isAnulada } from '../src/utils/ventas.js';
import { getCached as getResponseCached, setCached as setResponseCached } from './goalsResponseCache.js';
import {
  pctParaArticulo,
  categoriaParaPct,
  CATEGORIA_LABELS,
  type CategoriaComision,
} from './comisionesRules.js';
import {
  COD_EMPRESA_CASA_CENTRAL,
  COD_CLIENTES_INTERNOS,
  COD_VENDEDORES_VISIBLES,
  COD_EMPRESA_SAN_MARTIN,
  NOMBRE_EMPRESA,
  excluirClientesDe,
} from './comisionesShared.js';
import { loadVendedorOverrides, resolveCodVendedor } from './comisionOverrides.js';
import { getDescuentosRebotes } from './rebotes.js';
import { rigenCargosRebotes, PCT_CARGO_REBOTE, type DescuentoRebotes } from './rebotesParser.js';

interface BreakdownEntry { neto: number; comision: number; lineas: number }
interface ComisionVendedor {
  cod_vendedor: number;
  nombre: string;
  email: string | null;
  activo: boolean;
  neto_total: number;
  comision_total: number;
  /** Descuento del 3% por rebotes M.C. VENDEDOR (rige desde julio 2026). */
  rebotes: DescuentoRebotes | null;
  /** comision_total − rebotes.descuento — lo que efectivamente se paga. */
  comision_neta: number;
  num_lineas: number;
  num_comprobantes: number;
  breakdown: Record<CategoriaComision, BreakdownEntry>;
}

function emptyBreakdown(): Record<CategoriaComision, BreakdownEntry> {
  return {
    '5%': { neto: 0, comision: 0, lineas: 0 },
    '4%':   { neto: 0, comision: 0, lineas: 0 },
    '3.5%': { neto: 0, comision: 0, lineas: 0 },
    '1%':   { neto: 0, comision: 0, lineas: 0 },
  };
}

interface GetComisionesOpts {
  year: number;
  month: number;
  codVendedorFilter?: number;
  asOfDate?: string; // 'YYYY-MM-DD' — incluir cabeceras con fecha <= asOfDate
  /** Empresa a comisionar. Default Casa Central (1). La vista de sucursal pasa 2. */
  codEmpresa?: number;
  /** Cod_cliente a excluir del cálculo (decisión de negocio, ej. compras directas
   *  de mostrador que no corresponden al vendedor). Default: ninguno. */
  excluirClientes?: Set<number>;
  /** Si true, además del resumen por vendedor devuelve el detalle factura por
   *  factura (id, fecha, cliente, neto, comisión). Usado por la vista de sucursal. */
  incluirFacturas?: boolean;
}

/** Detalle de una factura comisionada (para la vista de sucursal). */
export interface FacturaComision {
  id: number;
  fecha: string;
  tipo: string;
  cod_cliente: number;
  razon_social: string;
  cod_vendedor: number;
  nombre_vendedor: string;
  neto: number;
  comision: number;
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
  const { year, month, codVendedorFilter, asOfDate, incluirFacturas } = opts;
  // Empresa a comisionar (default Casa Central) + clientes excluidos por negocio.
  const codEmpresaTarget = opts.codEmpresa ?? COD_EMPRESA_CASA_CENTRAL;
  const excluir = opts.excluirClientes ?? new Set<number>();
  // Default: mes entero (incluye facturas con fa_fecha futura del mes en curso).
  // Si se pasa asOfDate, recortar hasta ese día.
  const asOfValid = asOfDate && /^\d{4}-\d{2}-\d{2}$/.test(asOfDate) ? asOfDate : null;

  // 1. Datos crudos paralelos. Los nombres de cliente solo se piden cuando se
  //    necesita el detalle factura por factura (vista de sucursal).
  const [ventasRes, itemsRes, articulosMap, vendedoresIM, overrides, clientesIM] = await Promise.all([
    getMonthlyVentasRaw(year, month),
    getMonthlyItemsRaw(year, month),
    fetchArticulosCatalogo(),
    fetchVendedores(),
    loadVendedorOverrides(),
    incluirFacturas ? fetchClientesIMCached() : Promise.resolve([] as Awaited<ReturnType<typeof fetchClientesIMCached>>),
  ]);
  const nombreCliente = new Map<number, string>();
  for (const c of clientesIM) nombreCliente.set(Number(c.cod_cliente), String((c as any).razon_social ?? ''));

  // 2. Map id_comprobante → { signo (FA=+1, NC=-1), cod_vendedor }.
  // Solo cabeceras válidas. Las inválidas (PR, ND, anuladas) quedan fuera y
  // sus items se descartan automáticamente en el loop.
  const cabPorId = new Map<number, { sign: 1 | -1; cod_vendedor: number; tipo: string; cod_cliente: number; fecha: string }>();
  let nFA = 0, nNC = 0, nDescartadas = 0, nClientesInternos = 0, nOtraEmpresa = 0, nFueraCorte = 0, nExcluidos = 0;
  for (const v of ventasRes.ventas) {
    const id = Number((v as any).id);
    if (!Number.isFinite(id)) { nDescartadas++; continue; }
    // Filtrar empresas: solo la empresa pedida (default Casa Central=1) suma a
    // estas comisiones. La vista de sucursal pasa codEmpresa=2 (San Martín).
    const codEmp = Number((v as any).cod_empresa);
    if (Number.isFinite(codEmp) && codEmp !== codEmpresaTarget) {
      nOtraEmpresa++;
      continue;
    }
    // Filtrar por fecha de corte (asOfDate). Si la fecha de la cabecera
    // es posterior al corte, no se incluye. Útil para comparar contra
    // un cierre manual o para que cada vendedor vea solo lo facturado a
    // hoy sin las facturas con fecha futura del mismo mes.
    if (asOfValid) {
      const fechaCab = String((v as any).fecha ?? '').slice(0, 10);
      if (fechaCab && fechaCab > asOfValid) { nFueraCorte++; continue; }
    }
    const clase = clasificarCabecera(v);
    if (!clase) { nDescartadas++; continue; }
    // Override manual por comprobante (factura emitida en IM con vendedor
    // equivocado e inmutable). Sin override mantiene el crudo; el 0 (mostrador)
    // se deja pasar y lo filtra luego COD_VENDEDORES_VISIBLES.
    const codVend = resolveCodVendedor((v as any).cod_vendedor, id, overrides);
    if (codVend == null) { nDescartadas++; continue; }
    // Excluir transferencias entre sucursales — no son ventas comerciales.
    const codCli = Number((v as any).cod_cliente);
    if (Number.isFinite(codCli) && COD_CLIENTES_INTERNOS.has(codCli)) {
      nClientesInternos++;
      continue;
    }
    // Excluir clientes vetados por decisión de negocio (ej. compras directas de
    // mostrador en sucursal que no corresponden al vendedor del cliente).
    if (Number.isFinite(codCli) && excluir.has(codCli)) {
      nExcluidos++;
      continue;
    }
    cabPorId.set(id, {
      sign: clase === 'NC' ? -1 : 1,
      cod_vendedor: codVend,
      tipo: tipoComprobante(v),
      cod_cliente: Number.isFinite(codCli) ? codCli : 0,
      fecha: String((v as any).fecha ?? '').slice(0, 10),
    });
    if (clase === 'FA') nFA++; else nNC++;
  }

  // 3. Iterar items: cada uno tiene importe directo de la API.
  const acc = new Map<number, ComisionVendedor>();
  const compsTocados = new Map<number, Set<number>>();
  // Acumulador por factura (solo para la vista de sucursal que muestra detalle).
  const facturaAgg = incluirFacturas ? new Map<number, { neto: number; comision: number }>() : null;
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

    if (facturaAgg) {
      let f = facturaAgg.get(idComp);
      if (!f) { f = { neto: 0, comision: 0 }; facturaAgg.set(idComp, f); }
      f.neto += importe;
      f.comision += comision;
    }

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
        rebotes: null,
        comision_neta: 0,
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

  // 4b. Descuento por rebotes: 3% de lo rebotado por M.C. VENDEDOR (error del
  // vendedor al cargar el pedido). Rige desde julio 2026 y solo Casa Central
  // (los repartos salen de acá; las sucursales no tienen hoja de ruta propia
  // en el sheet). Si la consulta falla NO tapamos el error: devolvemos
  // rebotes_error=true y la UI avisa que está mostrando comisión BRUTA —
  // preferible a pagar de más en silencio.
  const rebotesRige = codEmpresaTarget === COD_EMPRESA_CASA_CENTRAL && rigenCargosRebotes(year, month);
  let rebotesError = false;
  if (rebotesRige) {
    const descuentos = await getDescuentosRebotes(year, month, asOfValid);
    if (descuentos == null) rebotesError = true;
    else for (const v of acc.values()) v.rebotes = descuentos.get(v.cod_vendedor) ?? null;
  }
  for (const v of acc.values()) {
    v.comision_neta = Math.round((v.comision_total - (v.rebotes?.descuento ?? 0)) * 100) / 100;
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
  items.sort((a, b) => b.comision_neta - a.comision_neta);

  // 7. Totales globales.
  const totales = {
    neto_total: Math.round(items.reduce((s, v) => s + v.neto_total, 0) * 100) / 100,
    comision_total: Math.round(items.reduce((s, v) => s + v.comision_total, 0) * 100) / 100,
    rebotes_descuento: Math.round(items.reduce((s, v) => s + (v.rebotes?.descuento ?? 0), 0) * 100) / 100,
    comision_neta: Math.round(items.reduce((s, v) => s + v.comision_neta, 0) * 100) / 100,
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
    cod_empresa: codEmpresaTarget,
    cabeceras_total: ventasRes.ventas.length,
    cabeceras_validas: cabPorId.size,
    cabeceras_FA: nFA,
    cabeceras_NC: nNC,
    cabeceras_descartadas: nDescartadas,
    cabeceras_clientes_internos_excluidas: nClientesInternos,
    cabeceras_otra_empresa_excluidas: nOtraEmpresa,
    cabeceras_excluidas_negocio: nExcluidos,
    cabeceras_fuera_corte: nFueraCorte,
    asOfDate: asOfValid,
    items_total: itemsRes.items.length,
    items_procesados: itemsProcesados,
    items_descartados_sin_cabecera: itemsDescartados,
    items_sin_precio: itemsSinPrecio,
    neto_FA: Math.round(netoFA * 100) / 100,
    neto_NC: Math.round(netoNC * 100) / 100,
    neto_global_items: Math.round((netoFA + netoNC) * 100) / 100,
  };
  console.log(`[comisiones] ${year}-${String(month).padStart(2, '0')}:`, JSON.stringify(diag));

  // 9. Detalle factura por factura (solo vista de sucursal). Mismo universo que
  //    los `items`: vendedores visibles (o el filtrado), sin las excluidas.
  let facturas: FacturaComision[] | undefined;
  if (incluirFacturas && facturaAgg) {
    const vendVisibles = new Set(items.map(v => v.cod_vendedor));
    const vendNombre = new Map<number, string>();
    for (const v of items) vendNombre.set(v.cod_vendedor, v.nombre);
    facturas = [];
    for (const [id, meta] of cabPorId.entries()) {
      if (!vendVisibles.has(meta.cod_vendedor)) continue;
      const f = facturaAgg.get(id);
      if (!f) continue; // factura sin items con precio → no aporta
      facturas.push({
        id,
        fecha: meta.fecha,
        tipo: meta.tipo,
        cod_cliente: meta.cod_cliente,
        razon_social: nombreCliente.get(meta.cod_cliente) ?? '',
        cod_vendedor: meta.cod_vendedor,
        nombre_vendedor: vendNombre.get(meta.cod_vendedor) ?? `Vendedor ${meta.cod_vendedor}`,
        neto: Math.round(f.neto * 100) / 100,
        comision: Math.round(f.comision * 100) / 100,
      });
    }
    facturas.sort((a, b) => Math.abs(b.comision) - Math.abs(a.comision));
  }

  return {
    year,
    month,
    cod_empresa: codEmpresaTarget,
    empresa_nombre: NOMBRE_EMPRESA[codEmpresaTarget] ?? `Empresa ${codEmpresaTarget}`,
    items,
    totales,
    facturas,
    categoria_labels: CATEGORIA_LABELS,
    // Descuento por rebotes: rige desde julio 2026 en Casa Central.
    rebotes_rige: rebotesRige,
    rebotes_pct: PCT_CARGO_REBOTE,
    rebotes_error: rebotesError || undefined,
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
      '5%': [], '4%': [], '3.5%': [], '1%': [],
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
        breakdown: { '5%': 0, '4%': 0, '3.5%': 0, '1%': 0 },
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

/**
 * GET /api/comisiones/diagnose-articulo/:cod  (admin)
 *
 * Devuelve: catálogo del artículo + categoría que se le asigna + cuánto
 * sumó en el mes pedido.
 */
export async function diagnoseArticulo(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const user = req.user!;
    if (user.rol !== 'admin' && user.rol !== 'gerente') {
      res.status(403).json({ error: 'Requiere admin/gerente' }); return;
    }
    const cod = Number(req.params.cod);
    if (!Number.isFinite(cod)) { res.status(400).json({ error: 'cod inválido' }); return; }
    const t = new Date();
    const year = Number(req.query.year) || t.getUTCFullYear();
    const month = Number(req.query.month) || (t.getUTCMonth() + 1);

    const [articulosMap, ventasRes, itemsRes] = await Promise.all([
      fetchArticulosCatalogo(),
      getMonthlyVentasRaw(year, month),
      getMonthlyItemsRaw(year, month),
    ]);

    const meta = articulosMap.get(cod) ?? null;
    const cabPorId = new Map<number, { sign: 1 | -1 }>();
    for (const v of ventasRes.ventas) {
      const id = Number((v as any).id);
      const codEmp = Number((v as any).cod_empresa);
      const codCli = Number((v as any).cod_cliente);
      const clase = clasificarCabecera(v);
      if (!Number.isFinite(id) || !clase) continue;
      if (Number.isFinite(codEmp) && codEmp !== COD_EMPRESA_CASA_CENTRAL) continue;
      if (Number.isFinite(codCli) && COD_CLIENTES_INTERNOS.has(codCli)) continue;
      cabPorId.set(id, { sign: clase === 'NC' ? -1 : 1 });
    }
    let totalNeto = 0, lineas = 0;
    let ejemploDetalle = '';
    for (const it of itemsRes.items) {
      if (Number(it.cod_articulo) !== cod) continue;
      const m = cabPorId.get(Number(it.id_comprobante));
      if (!m) continue;
      const importeAbs = Number(it.importe ?? 0);
      if (!Number.isFinite(importeAbs) || importeAbs === 0) continue;
      totalNeto += importeAbs * m.sign;
      lineas++;
      if (!ejemploDetalle) ejemploDetalle = String((it as any).detalle ?? '');
    }
    const codRubroResuelto = meta?.cod_rubro ?? null;
    const detalleResuelto = ejemploDetalle || meta?.descripcion || '';
    const pct = pctParaArticulo(cod, codRubroResuelto, detalleResuelto);
    const cat = categoriaParaPct(pct);

    res.json({
      ok: true,
      cod_articulo: cod,
      year, month,
      en_catalogo: meta != null,
      catalogo: meta,
      ejemplo_detalle_de_factura: ejemploDetalle,
      categoria_aplicada: cat,
      pct_aplicado: pct,
      label: CATEGORIA_LABELS[cat],
      neto_mes: Math.round(totalNeto * 100) / 100,
      lineas_mes: lineas,
      reglas_aplicadas: {
        en_lista_55pct: false,  // ya no existe esta categoría
        en_lista_5pct_EXACT: COMISION_55PCT_CODES_HAS(cod),
        en_lista_1pct_MASIVO: COMISION_1PCT_CODES_HAS(cod),
        match_descripcion_1pct: detalleMatcheaPrefijo1pct(detalleResuelto),
        rubro_es_11_accesorios: codRubroResuelto === 11,
      },
    });
  } catch (err: any) {
    console.error('diagnoseArticulo error:', err);
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

// Helpers para reflejar el estado de las reglas en diagnoseArticulo.
const COMISION_55PCT_CODES_HAS = (cod: number) =>
  new Set([232, 231, 233, 234, 235, 236]).has(cod);
const COMISION_1PCT_CODES_HAS = (cod: number) =>
  new Set([134, 135, 136, 150, 151, 185, 130, 138, 140, 131, 137, 995, 1009, 5, 6, 7, 24, 25, 281, 165]).has(cod);
function detalleMatcheaPrefijo1pct(detalle: string): boolean {
  return detalle.toUpperCase().trim().startsWith('FLECKY');
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

    const asOfDateRaw = String(req.query.asOfDate ?? '').trim();
    const asOfDate = /^\d{4}-\d{2}-\d{2}$/.test(asOfDateRaw) ? asOfDateRaw : undefined;

    const cacheKey = `comisiones:${year}-${month}:${codVendedorFilter ?? 'all'}:${asOfDate ?? 'full'}`;
    const hit = getResponseCached(cacheKey);
    if (hit) { res.set('X-Cache', 'HIT').json(hit); return; }

    const data = await getComisionesData({ year, month, codVendedorFilter, asOfDate });
    const body = { ok: true, ...data };
    setResponseCached(cacheKey, body);
    res.set('X-Cache', 'MISS').json(body);
  } catch (err: any) {
    console.error('listComisiones error:', err);
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/**
 * GET /api/comisiones/sucursal?year=&month=&cod_empresa=2  (SOLO admin/gerente)
 *
 * Comisiones que le corresponden a los vendedores de Casa Central por sus
 * clientes que retiran en una SUCURSAL (default San Martín=2). El cálculo de
 * comisiones normal solo cuenta Casa Central, así que estas ventas quedan
 * afuera; esta vista las muestra aparte y NO es visible para los vendedores.
 * Aplica las exclusiones de negocio (EXCLUIR_CLIENTES_COMISION_SUCURSAL) y
 * devuelve, además del resumen por vendedor, el detalle factura por factura.
 */
export async function listComisionesSucursal(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const user = req.user!;
    if (user.rol !== 'admin' && user.rol !== 'gerente') {
      res.status(403).json({ error: 'Requiere admin/gerente' }); return;
    }
    if (!hasSupabase()) { res.status(500).json({ error: 'Supabase no configurado' }); return; }
    const t = new Date();
    const year = Number(req.query.year) || t.getUTCFullYear();
    const month = Number(req.query.month) || (t.getUTCMonth() + 1);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      res.status(400).json({ error: 'year/month inválidos' }); return;
    }
    // Empresa: default San Martín. Se permiten solo sucursales (≠ Casa Central),
    // porque Casa Central ya tiene su propio panel de comisiones para vendedores.
    let codEmpresa = COD_EMPRESA_SAN_MARTIN;
    if (req.query.cod_empresa != null) {
      const c = Number(req.query.cod_empresa);
      if (![2, 3, 4].includes(c)) { res.status(400).json({ error: 'cod_empresa debe ser una sucursal (2, 3 o 4)' }); return; }
      codEmpresa = c;
    }
    const periodo = `${year}-${String(month).padStart(2, '0')}`;
    const excluirClientes = excluirClientesDe(periodo);

    const cacheKey = `comisiones-suc:${periodo}:emp${codEmpresa}`;
    const hit = getResponseCached(cacheKey);
    if (hit) { res.set('X-Cache', 'HIT').json(hit); return; }

    const data = await getComisionesData({ year, month, codEmpresa, excluirClientes, incluirFacturas: true });
    const body = {
      ok: true,
      ...data,
      // Clientes excluidos por decisión de negocio (para mostrarlo en la vista).
      excluidos: Array.from(excluirClientes),
    };
    setResponseCached(cacheKey, body);
    res.set('X-Cache', 'MISS').json(body);
  } catch (err: any) {
    console.error('listComisionesSucursal error:', err);
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}
