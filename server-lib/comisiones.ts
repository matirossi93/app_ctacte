import type { Request, Response } from 'express';
import type { JwtPayload } from './auth.js';
import { sb, hasSupabase } from './supabase.js';
import { fetchVendedores, fetchArticulosCatalogo } from './infomanager.js';
import { getMonthlyVentasRaw, getMonthlyItemsRaw } from './snapshotCache.js';
import { computeVentaNeta, tipoComprobante, isAnulada } from '../src/utils/ventas.js';
import { getCached as getResponseCached, setCached as setResponseCached } from './goalsResponseCache.js';
import {
  pctParaArticulo,
  categoriaParaPct,
  CATEGORIA_LABELS,
  type CategoriaComision,
} from './comisionesRules.js';

const COD_VENDEDORES_VISIBLES = new Set([2, 3, 4, 6, 12]);

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
 * Distribuye el `netoCabecera` entre las líneas del comprobante usando el
 * `precio_venta` del catálogo como peso. Si una línea no tiene precio
 * conocido, se le asigna el promedio de las que sí tienen. Si la cabecera
 * no tiene líneas con peso, se prorratea por cantidad.
 *
 * Retorna Map<id_item, importe_signed_línea>. Suma de importes == netoCabecera.
 */
function distribuirNetoEntreLineas(
  netoCabecera: number,
  lineas: Array<{ id?: any; cod_articulo: number; cantidad: number; precio_venta: number }>,
): Map<any, number> {
  const out = new Map<any, number>();
  if (lineas.length === 0 || netoCabecera === 0) return out;

  // Peso de cada línea = cantidad × precio_venta. Si precio=0 (artículo no
  // catalogado), peso = 0 y compensamos al final.
  const pesos = lineas.map(l => Math.max(0, l.cantidad) * Math.max(0, l.precio_venta));
  const sumaPesos = pesos.reduce((s, p) => s + p, 0);

  if (sumaPesos > 0) {
    // Caso normal: distribuir proporcionalmente al peso.
    let acumulado = 0;
    for (let i = 0; i < lineas.length; i++) {
      const importe = i === lineas.length - 1
        ? Math.round((netoCabecera - acumulado) * 100) / 100  // último ajusta para que sume exacto
        : Math.round(netoCabecera * (pesos[i] / sumaPesos) * 100) / 100;
      out.set(lineas[i].id ?? `${i}`, importe);
      acumulado += importe;
    }
    return out;
  }

  // Fallback: ningún artículo tiene precio_venta en el catálogo. Prorratear
  // por cantidad. Menos exacto pero al menos suma cuadra.
  const sumaCant = lineas.reduce((s, l) => s + Math.max(0, l.cantidad), 0);
  if (sumaCant <= 0) return out;
  let acumulado = 0;
  for (let i = 0; i < lineas.length; i++) {
    const importe = i === lineas.length - 1
      ? Math.round((netoCabecera - acumulado) * 100) / 100
      : Math.round(netoCabecera * (Math.max(0, lineas[i].cantidad) / sumaCant) * 100) / 100;
    out.set(lineas[i].id ?? `${i}`, importe);
    acumulado += importe;
  }
  return out;
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

  // 2. Filtrar cabeceras: solo las que aportan al neto (FA suma, NC resta,
  //    resto 0). Esto reusa la lógica probada de Objetivos (computeVentaNeta).
  const cabsValidas = new Map<number, { cab: any; netoCabecera: number }>();
  let netoTotalCabecerasFA = 0;
  let netoTotalCabecerasNC = 0;
  for (const v of ventasRes.ventas) {
    const id = Number((v as any).id);
    if (!Number.isFinite(id)) continue;
    if (isAnulada(v as any)) continue;
    const tipo = tipoComprobante(v as any);
    if (tipo.startsWith('ND')) continue; // ND no es venta
    const neto = computeVentaNeta(v as any);
    if (neto === 0) continue; // RC, RE, PR, IR, ASD, ASH, etc.
    cabsValidas.set(id, { cab: v, netoCabecera: neto });
    if (neto > 0) netoTotalCabecerasFA += neto;
    else netoTotalCabecerasNC += neto;
  }

  // 3. Agrupar items por id_comprobante (solo las cabeceras válidas).
  const itemsPorComp = new Map<number, Array<{ id: any; cod_articulo: number; cantidad: number; precio_venta: number; cod_rubro: number | null }>>();
  let primerItemLogueado = false;
  for (const it of itemsRes.items) {
    if (!primerItemLogueado) {
      primerItemLogueado = true;
      console.log('[comisiones] sample item:', JSON.stringify(it).slice(0, 400));
    }
    const idComp = Number(it.id_comprobante);
    if (!cabsValidas.has(idComp)) continue;
    const codArt = Number(it.cod_articulo);
    if (!Number.isFinite(codArt)) continue;
    const meta = articulosMap.get(codArt);
    let arr = itemsPorComp.get(idComp);
    if (!arr) { arr = []; itemsPorComp.set(idComp, arr); }
    arr.push({
      id: it.id ?? `${idComp}-${arr.length}`,
      cod_articulo: codArt,
      cantidad: Number(it.cantidad ?? 0),
      precio_venta: meta?.precio_venta ?? 0,
      cod_rubro: meta?.cod_rubro ?? null,
    });
  }

  // 4. Para cada cabecera válida, distribuir el neto entre sus líneas y
  //    aplicar la regla de comisión.
  const acc = new Map<number, ComisionVendedor>();
  const compsTocados = new Map<number, Set<number>>();
  let cabsConItems = 0;
  let cabsSinItems = 0;
  let netoSinItems = 0;

  for (const [idComp, info] of cabsValidas.entries()) {
    const { cab, netoCabecera } = info;
    const codVend = Number(cab.cod_vendedor);
    if (!Number.isFinite(codVend)) continue;

    const lineas = itemsPorComp.get(idComp);

    // Inicializar acumulador del vendedor.
    let v = acc.get(codVend);
    if (!v) {
      const vIm = (vendedoresIM ?? []).find((x: any) => Number(x.cod_vendedor) === codVend);
      v = {
        cod_vendedor: codVend,
        nombre: String(vIm?.nombre ?? `Vendedor ${codVend}`),
        email: null,
        activo: true,
        neto_total: 0,
        comision_total: 0,
        num_lineas: 0,
        num_comprobantes: 0,
        breakdown: emptyBreakdown(),
      };
      acc.set(codVend, v);
      compsTocados.set(codVend, new Set());
    }
    compsTocados.get(codVend)!.add(idComp);

    if (!lineas || lineas.length === 0) {
      // Sin líneas (raro, pero posible): contar el neto pero no clasificar.
      // Aplicamos % "resto" como aproximación para no perder la comisión.
      cabsSinItems++;
      netoSinItems += netoCabecera;
      const com = Math.round(netoCabecera * 0.035 * 100) / 100;
      v.neto_total += netoCabecera;
      v.comision_total += com;
      v.breakdown['3.5%'].neto += netoCabecera;
      v.breakdown['3.5%'].comision += com;
      continue;
    }

    cabsConItems++;
    const distribucion = distribuirNetoEntreLineas(netoCabecera, lineas);
    for (const l of lineas) {
      const importe = distribucion.get(l.id) ?? 0;
      if (importe === 0) continue;
      const pct = pctParaArticulo(l.cod_articulo, l.cod_rubro);
      const cat = categoriaParaPct(pct);
      const comision = Math.round(importe * pct * 100) / 100;
      v.neto_total += importe;
      v.comision_total += comision;
      v.num_lineas += 1;
      v.breakdown[cat].neto += importe;
      v.breakdown[cat].comision += comision;
      v.breakdown[cat].lineas += 1;
    }
  }

  // 5. Redondeo final + comprobantes.
  for (const v of acc.values()) {
    v.neto_total = Math.round(v.neto_total * 100) / 100;
    v.comision_total = Math.round(v.comision_total * 100) / 100;
    v.num_comprobantes = compsTocados.get(v.cod_vendedor)?.size ?? 0;
    for (const cat of Object.keys(v.breakdown) as CategoriaComision[]) {
      v.breakdown[cat].neto = Math.round(v.breakdown[cat].neto * 100) / 100;
      v.breakdown[cat].comision = Math.round(v.breakdown[cat].comision * 100) / 100;
    }
  }

  // 6. Enriquecer con datos de Supabase.
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

  // 7. Filtros.
  let items = Array.from(acc.values());
  if (codVendedorFilter != null) {
    items = items.filter(v => v.cod_vendedor === codVendedorFilter);
  } else {
    items = items.filter(v => COD_VENDEDORES_VISIBLES.has(v.cod_vendedor));
  }
  items.sort((a, b) => b.comision_total - a.comision_total);

  // 8. Totales globales.
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

  // 9. Diagnóstico para comparar con números reales.
  const diag = {
    cabeceras_total: ventasRes.ventas.length,
    cabeceras_validas: cabsValidas.size,
    cabeceras_con_items: cabsConItems,
    cabeceras_sin_items: cabsSinItems,
    items_total: itemsRes.items.length,
    neto_FA: Math.round(netoTotalCabecerasFA * 100) / 100,
    neto_NC: Math.round(netoTotalCabecerasNC * 100) / 100,
    neto_global_cabeceras: Math.round((netoTotalCabecerasFA + netoTotalCabecerasNC) * 100) / 100,
    neto_sin_items: Math.round(netoSinItems * 100) / 100,
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
