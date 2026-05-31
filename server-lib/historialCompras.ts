/**
 * Historial de compras por cliente — endpoint + helpers de agregación.
 *
 * Reusa el cache RAM mensual de snapshotCache.ts (mismas ventas+items que
 * usa /api/comisiones). Filtra por cod_cliente y agrega top productos +
 * lista de últimas facturas.
 *
 * Spec: docs/superpowers/specs/2026-05-25-historial-compras-cliente-design.md
 */


const PATRONES_LINEA_TECNICA = ['flete', 'descuento', 'bonif', 'ajuste', 'redondeo', 'percepcion'];

/** True si el detalle del artículo corresponde a un concepto técnico (no producto real). */
export function esLineaTecnica(detalle: string | null | undefined): boolean {
  if (!detalle) return false;
  const lower = String(detalle).toLowerCase();
  return PATRONES_LINEA_TECNICA.some(p => lower.includes(p));
}

export interface AgregadoArticulo {
  cod_articulo: number;
  detalle: string;
  cantidad_total: number;
  importe_total: number;
  num_facturas: number;
  ultima_compra: string; // 'YYYY-MM-DD'
}

interface CabeceraSigno {
  sign: 1 | -1;
  fecha: string;
}

/**
 * Agrupa los items por `cod_articulo`, aplicando el signo de cada cabecera
 * (FA suma, NC resta). Devuelve un Map para que el caller pueda armar varios
 * rankings sin re-iterar los items.
 *
 * Items cuya cabecera no está en `signos` se descartan (cabecera inválida
 * = no Casa Central, anulada, no FA/NC, no este cliente).
 */
export function agregarPorArticulo(
  items: Array<{ id_comprobante: number; cod_articulo: number | string; cantidad: number | string; importe?: number | string; precio?: number | string; detalle?: string }>,
  signos: Map<number, CabeceraSigno>,
  articulosMap: Map<number, { descripcion: string }>
): Map<number, AgregadoArticulo> {
  const acc = new Map<number, AgregadoArticulo>();
  const facturasPorArt = new Map<number, Set<number>>();

  for (const it of items) {
    const cab = signos.get(Number(it.id_comprobante));
    if (!cab) continue;

    const codArt = Number(it.cod_articulo);
    if (!Number.isFinite(codArt)) continue;

    const cantidad = Number(it.cantidad ?? 0);
    const importe = Number(it.importe ?? 0);
    if (!Number.isFinite(cantidad) || !Number.isFinite(importe)) continue;

    const sign = cab.sign;
    const detalleArt = String(
      (it as any).detalle ?? articulosMap.get(codArt)?.descripcion ?? `#${codArt}`
    ).trim();

    let a = acc.get(codArt);
    if (!a) {
      a = {
        cod_articulo: codArt,
        detalle: detalleArt,
        cantidad_total: 0,
        importe_total: 0,
        num_facturas: 0,
        ultima_compra: cab.fecha,
      };
      acc.set(codArt, a);
      facturasPorArt.set(codArt, new Set());
    }

    a.cantidad_total += cantidad * sign;
    a.importe_total += importe * sign;
    if (cab.fecha > a.ultima_compra) a.ultima_compra = cab.fecha;

    facturasPorArt.get(codArt)!.add(Number(it.id_comprobante));
  }

  for (const [cod, set] of facturasPorArt) {
    const a = acc.get(cod);
    if (a) a.num_facturas = set.size;
  }

  return acc;
}

export function topPorImporte(agg: Map<number, AgregadoArticulo>, n: number): AgregadoArticulo[] {
  return Array.from(agg.values())
    .filter(a => a.importe_total > 0)
    .sort((a, b) => b.importe_total - a.importe_total)
    .slice(0, n);
}

export function topPorFrecuencia(agg: Map<number, AgregadoArticulo>, n: number): AgregadoArticulo[] {
  return Array.from(agg.values())
    .filter(a => a.num_facturas > 0)
    .sort((a, b) => {
      if (b.num_facturas !== a.num_facturas) return b.num_facturas - a.num_facturas;
      return b.importe_total - a.importe_total;
    })
    .slice(0, n);
}

export interface FacturaHistorial {
  id_comprobante: number;
  fecha: string;
  tipo: 'FA' | 'NC';
  tipo_factura: string;
  punto_venta: number;
  numero: number;
  total_neto: number;
  items: Array<{ cod_articulo: number; detalle: string; cantidad: number; importe: number }>;
}

interface CabeceraValida {
  id: number;
  fecha: string;
  tipo: string;
  tipo_factura?: string;
  punto_de_venta?: number;
  numero?: number;
  fa_total?: number;
  sign: 1 | -1;
}

export function armarFacturas(
  cabsValidas: Map<number, CabeceraValida>,
  items: Array<{ id_comprobante: number; cod_articulo: number | string; cantidad: number | string; importe?: number | string; detalle?: string }>,
  articulosMap: Map<number, { descripcion: string }>
): FacturaHistorial[] {
  const itemsPorComp = new Map<number, FacturaHistorial['items']>();

  for (const it of items) {
    const cab = cabsValidas.get(Number(it.id_comprobante));
    if (!cab) continue;

    const detalle = String(
      (it as any).detalle ?? articulosMap.get(Number(it.cod_articulo))?.descripcion ?? `#${it.cod_articulo}`
    ).trim();
    if (esLineaTecnica(detalle)) continue;

    const arr = itemsPorComp.get(Number(it.id_comprobante)) ?? [];
    arr.push({
      cod_articulo: Number(it.cod_articulo),
      detalle,
      cantidad: Number(it.cantidad ?? 0) * cab.sign,
      importe: Number(it.importe ?? 0) * cab.sign,
    });
    itemsPorComp.set(Number(it.id_comprobante), arr);
  }

  const facturas: FacturaHistorial[] = [];
  for (const [id, cab] of cabsValidas) {
    const clase: 'FA' | 'NC' = cab.sign === -1 ? 'NC' : 'FA';
    facturas.push({
      id_comprobante: id,
      fecha: cab.fecha,
      tipo: clase,
      tipo_factura: String(cab.tipo_factura ?? cab.tipo ?? ''),
      punto_venta: Number(cab.punto_de_venta ?? 0),
      numero: Number(cab.numero ?? 0),
      total_neto: Number(cab.fa_total ?? 0) * cab.sign,
      items: itemsPorComp.get(id) ?? [],
    });
  }

  facturas.sort((a, b) => {
    if (a.fecha === b.fecha) return b.id_comprobante - a.id_comprobante;
    return a.fecha < b.fecha ? 1 : -1;
  });

  return facturas;
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

const MESES_DEFAULT = 3;

function ultimosMeses(n: number, ref?: Date): Array<{ year: number; month: number }> {
  const d = ref ?? new Date();
  const list: Array<{ year: number; month: number }> = [];
  for (let i = 0; i < n; i++) {
    const dd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    list.push({ year: dd.getUTCFullYear(), month: dd.getUTCMonth() + 1 });
  }
  return list;
}

/**
 * Cache RAM del response YA ARMADO por cod_cliente. TTL 5min — alineado con
 * el TTL del mes actual de snapshotCache. La primera carga de un cliente
 * paga el costo de filtrar+agregar; las siguientes (mismo cliente, cualquier
 * vendedor) responden desde acá en ~0ms. El permiso se valida SIEMPRE antes
 * de tocar el cache, así que servir desde cache no filtra datos a quien no
 * corresponde.
 */
interface HistorialCacheEntry { payload: object; expiresAt: number }
const RESPONSE_CACHE_TTL_MS = 5 * 60 * 1000;
const responseCache = new Map<number, HistorialCacheEntry>();

/**
 * GET /api/clientes/:cod/historial-compras?meses=3
 *
 * Auth:
 *   - admin / gerente: cualquier cliente.
 *   - vendedor: solo si el cliente pertenece al vendedor (matching de
 *     cod_vendedor del cliente en IM contra user.cod_vendedor del JWT).
 *   - cualquier otro rol (incluido repartidor): 403.
 */
export async function historialComprasCliente(req: import('express').Request & { user?: import('./auth.js').JwtPayload }, res: import('express').Response) {
  try {
    const { tipoComprobante, isAnulada } = await import('../src/utils/ventas.js');
    const { getMonthlyVentasRaw, getMonthlyItemsRaw } = await import('./snapshotCache.js');
    const { fetchArticulosCatalogo, fetchClientesIMCached } = await import('./infomanager.js');
    const { COD_EMPRESA_CASA_CENTRAL, COD_CLIENTES_INTERNOS } = await import('./comisionesShared.js');

    function clasificarCabecera(cab: any): 'FA' | 'NC' | null {
      if (isAnulada(cab)) return null;
      const tipo = tipoComprobante(cab);
      if (tipo.startsWith('ND')) return null;
      if (tipo.startsWith('NC')) return 'NC';
      if (tipo.startsWith('F')) return 'FA';
      return null;
    }

    const user = req.user!;
    if (!user || (user.rol !== 'admin' && user.rol !== 'gerente' && user.rol !== 'vendedor')) {
      res.status(403).json({ error: 'No autorizado para ver el historial de compras' });
      return;
    }

    const codCliente = Number(req.params.cod);
    if (!Number.isFinite(codCliente) || codCliente <= 0) {
      res.status(400).json({ error: 'cod_cliente inválido' });
      return;
    }

    const meses = Number(req.query.meses ?? MESES_DEFAULT);
    if (meses !== MESES_DEFAULT) {
      res.status(400).json({ error: `meses debe ser ${MESES_DEFAULT}` });
      return;
    }

    if (user.rol === 'vendedor') {
      const clientesIM = await fetchClientesIMCached();
      const cli = clientesIM.find((c: any) => Number(c.cod_cliente) === codCliente);
      if (!cli || Number(cli.cod_vendedor) !== Number(user.cod_vendedor)) {
        res.status(403).json({ error: 'Cliente no pertenece al vendedor' });
        return;
      }
    }

    // Cache hit: permiso ya validado arriba, servir el response cacheado.
    const cached = responseCache.get(codCliente);
    if (cached && cached.expiresAt > Date.now()) {
      res.json(cached.payload);
      return;
    }

    const periodos = ultimosMeses(meses);
    const fetches = periodos.flatMap(p => [getMonthlyVentasRaw(p.year, p.month), getMonthlyItemsRaw(p.year, p.month)]);
    const articulosMap = await fetchArticulosCatalogo();
    const results = await Promise.all(fetches);

    const ventasAll: any[] = [];
    const itemsAll: any[] = [];
    for (let i = 0; i < periodos.length; i++) {
      const v = results[i * 2] as Awaited<ReturnType<typeof getMonthlyVentasRaw>>;
      const it = results[i * 2 + 1] as Awaited<ReturnType<typeof getMonthlyItemsRaw>>;
      ventasAll.push(...v.ventas);
      itemsAll.push(...it.items);
    }

    const cabsValidas = new Map<number, any>();
    const signosParaAgg = new Map<number, { sign: 1 | -1; fecha: string }>();

    for (const v of ventasAll) {
      const id = Number(v.id);
      if (!Number.isFinite(id)) continue;
      const codEmp = Number(v.cod_empresa);
      if (Number.isFinite(codEmp) && codEmp !== COD_EMPRESA_CASA_CENTRAL) continue;
      const codCli = Number(v.cod_cliente);
      if (codCli !== codCliente) continue;
      if (COD_CLIENTES_INTERNOS.has(codCli)) continue;
      const clase = clasificarCabecera(v);
      if (!clase) continue;
      const sign: 1 | -1 = clase === 'NC' ? -1 : 1;
      const fecha = String(v.fecha ?? v.fa_fecha ?? '').slice(0, 10);

      cabsValidas.set(id, {
        id,
        fecha,
        tipo: tipoComprobante(v),
        tipo_factura: (v as any).tipo_factura ?? tipoComprobante(v),
        punto_de_venta: v.punto_de_venta,
        numero: v.numero,
        fa_total: Number(v.fa_total ?? v.total ?? 0),
        sign,
      });
      signosParaAgg.set(id, { sign, fecha });
    }

    const itemsLimpios = itemsAll.filter(it => {
      const detalle = String((it as any).detalle ?? articulosMap.get(Number(it.cod_articulo))?.descripcion ?? '');
      return !esLineaTecnica(detalle);
    });

    const agg = agregarPorArticulo(itemsLimpios, signosParaAgg, articulosMap);
    const top_importe = topPorImporte(agg, 5);
    const top_frecuencia = topPorFrecuencia(agg, 5);
    const facturas = armarFacturas(cabsValidas, itemsAll, articulosMap);

    const desde = `${periodos[periodos.length - 1].year}-${String(periodos[periodos.length - 1].month).padStart(2, '0')}-01`;
    const lastMes = new Date(periodos[0].year, periodos[0].month, 0);
    const hasta = `${periodos[0].year}-${String(periodos[0].month).padStart(2, '0')}-${String(lastMes.getDate()).padStart(2, '0')}`;

    const payload = {
      ok: true,
      cod_cliente: codCliente,
      meses,
      rango: { desde, hasta },
      facturas,
      top_importe,
      top_frecuencia,
      generated_at: new Date().toISOString(),
    };
    responseCache.set(codCliente, { payload, expiresAt: Date.now() + RESPONSE_CACHE_TTL_MS });
    res.json(payload);
  } catch (err: any) {
    console.error('historialComprasCliente error:', err);
    res.status(500).json({ ok: false, error: err?.message ?? 'error' });
  }
}
