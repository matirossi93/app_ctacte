import type { Request, Response } from 'express';
import type { JwtPayload } from './auth.js';
import { sb, hasSupabase } from './supabase.js';
import { fetchVendedores, fetchArticulosCatalogo } from './infomanager.js';
import { getMonthlyVentasRaw, getMonthlyItemsRaw } from './snapshotCache.js';
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

/**
 * Convierte cualquier item de venta a un importe firmado:
 *  - FA / FB → positivo
 *  - NC      → negativo (resta del neto)
 *  - resto   → 0 (ND, RE, ASD, etc no son ventas reales)
 *
 * Estrategia para obtener el monto de la línea:
 *  1. item.importe (si la API lo devuelve)
 *  2. item.cantidad * item.precio (si vienen ambos)
 *  3. fallback: prorratear fa_total de la cabecera por proporción de cantidad
 *     (último recurso, introduce error si la factura mezcla artículos de muy
 *     distinto precio).
 */
function importeLineaSigned(
  item: any,
  cabecera: any,
  totalCantidadComprobante: number,
): number {
  const tipo = String(cabecera?.tipo ?? cabecera?.tipo_comprobante ?? '').toUpperCase();
  if (cabecera?.anulada === 'S') return 0;
  const isFA = tipo.startsWith('FA') || tipo.startsWith('FB') || tipo.startsWith('FC');
  const isNC = tipo.startsWith('NC');
  if (!isFA && !isNC) return 0;
  const sign = isNC ? -1 : 1;

  let importe = item.importe != null ? Number(item.importe) : NaN;
  if (!Number.isFinite(importe) || importe === 0) {
    const cantidad = Number(item.cantidad ?? 0);
    const precio = Number(item.precio ?? 0);
    if (Number.isFinite(cantidad) && Number.isFinite(precio) && precio > 0) {
      importe = cantidad * precio;
    }
  }
  if (!Number.isFinite(importe) || importe === 0) {
    // Fallback: prorratear fa_total por cantidad relativa.
    const cabTotal = Number(cabecera?.fa_total ?? cabecera?.total ?? cabecera?.neto ?? 0);
    const cantidad = Number(item.cantidad ?? 0);
    if (totalCantidadComprobante > 0 && cabTotal > 0) {
      importe = cabTotal * (cantidad / totalCantidadComprobante);
    } else {
      importe = 0;
    }
  }
  return Math.round(importe * 100) / 100 * sign;
}

interface GetComisionesOpts {
  year: number;
  month: number;
  codVendedorFilter?: number; // si viene, filtra al final solo ese vendedor
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

  // 2. Map id_comprobante → cabecera.
  const cabPorId = new Map<number, any>();
  for (const v of ventasRes.ventas) {
    const id = Number((v as any).id);
    if (Number.isFinite(id)) cabPorId.set(id, v);
  }

  // 3. Pre-calc cantidad total por comprobante (para fallback proporcional).
  const cantTotalPorComp = new Map<number, number>();
  for (const it of itemsRes.items) {
    const id = Number(it.id_comprobante);
    if (!Number.isFinite(id)) continue;
    const c = Number(it.cantidad ?? 0);
    cantTotalPorComp.set(id, (cantTotalPorComp.get(id) ?? 0) + (Number.isFinite(c) ? c : 0));
  }

  // 4. Acumular por vendedor.
  const acc = new Map<number, ComisionVendedor>();
  const compsTocados = new Map<number, Set<number>>(); // cod_vend → set(id_comp)
  let primerItemLogueado = false;

  for (const it of itemsRes.items) {
    const idComp = Number(it.id_comprobante);
    const cab = cabPorId.get(idComp);
    if (!cab) continue;
    const codVend = Number((cab as any).cod_vendedor);
    if (!Number.isFinite(codVend)) continue;

    if (!primerItemLogueado) {
      primerItemLogueado = true;
      console.log('[comisiones] sample item:', JSON.stringify(it).slice(0, 300));
    }

    const totalCantComp = cantTotalPorComp.get(idComp) ?? 0;
    const importe = importeLineaSigned(it, cab, totalCantComp);
    if (importe === 0) continue;

    const codArt = Number(it.cod_articulo);
    const articuloMeta = articulosMap.get(codArt);
    const codRubro = articuloMeta?.cod_rubro ?? null;
    const pct = pctParaArticulo(codArt, codRubro);
    const cat = categoriaParaPct(pct);
    const comision = Math.round(importe * pct * 100) / 100;

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
    v.neto_total += importe;
    v.comision_total += comision;
    v.num_lineas += 1;
    v.breakdown[cat].neto += importe;
    v.breakdown[cat].comision += comision;
    v.breakdown[cat].lineas += 1;
    compsTocados.get(codVend)!.add(idComp);
  }

  // 5. Redondeos finales + comprobantes.
  for (const v of acc.values()) {
    v.neto_total = Math.round(v.neto_total * 100) / 100;
    v.comision_total = Math.round(v.comision_total * 100) / 100;
    v.num_comprobantes = compsTocados.get(v.cod_vendedor)?.size ?? 0;
    for (const cat of Object.keys(v.breakdown) as CategoriaComision[]) {
      v.breakdown[cat].neto = Math.round(v.breakdown[cat].neto * 100) / 100;
      v.breakdown[cat].comision = Math.round(v.breakdown[cat].comision * 100) / 100;
    }
  }

  // 6. Enriquecer con datos de Supabase (usuarios.email, activo).
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

  // 7. Filtros: whitelist o vendedor específico.
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

  return {
    year,
    month,
    items,
    totales,
    categoria_labels: CATEGORIA_LABELS,
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
