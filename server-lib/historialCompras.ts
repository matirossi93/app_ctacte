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
// Análisis: alertas de abandono + comparación entre trimestres
// ---------------------------------------------------------------------------

function diasEntre(desdeISO: string, hastaMs: number): number {
  const t = Date.parse(desdeISO + 'T00:00:00Z');
  if (!Number.isFinite(t)) return 0;
  return Math.floor((hastaMs - t) / (1000 * 60 * 60 * 24));
}

function mediaIntervalos(fechasISO: string[]): number {
  if (fechasISO.length < 2) return 0;
  const sorted = [...fechasISO].sort();
  let total = 0;
  for (let i = 1; i < sorted.length; i++) {
    total += diasEntre(sorted[i - 1], Date.parse(sorted[i] + 'T00:00:00Z'));
  }
  return total / (sorted.length - 1);
}

export interface AlertaCliente {
  dias_sin_comprar: number;
  media_dias_entre_compras: number;
  nivel: 'amarillo' | 'rojo' | null;
}

/**
 * Detecta si el cliente está "dejando de comprar" comparando los días desde
 * su última FA contra su propio ritmo histórico (media de intervalos entre FAs).
 *
 * - Requiere ≥3 FAs en el historial. Con menos hay ruido.
 * - NCs (devoluciones) NO cuentan como compra: las ignoramos.
 * - Niveles:
 *     dias_sin > 3× media  → rojo
 *     dias_sin > 2× media  → amarillo
 *     en otro caso         → null (no hay alerta)
 */
export function calcularAlertaCliente(facturas: FacturaHistorial[], ahora: Date): AlertaCliente | null {
  const fas = facturas.filter(f => f.tipo === 'FA');
  if (fas.length < 3) return null;
  const fechas = fas.map(f => f.fecha).filter(Boolean);
  const sorted = [...fechas].sort();
  const ultima = sorted[sorted.length - 1];
  const ahoraMs = ahora.getTime();
  const diasSin = diasEntre(ultima, ahoraMs);
  const media = mediaIntervalos(sorted);
  if (media <= 0) return null;
  let nivel: 'amarillo' | 'rojo' | null = null;
  if (diasSin > 3 * media) nivel = 'rojo';
  else if (diasSin > 2 * media) nivel = 'amarillo';
  return { dias_sin_comprar: diasSin, media_dias_entre_compras: Math.round(media * 10) / 10, nivel };
}

export interface ProductoAbandono {
  cod_articulo: number;
  detalle: string;
  dias_sin_comprar: number;
  intervalo_medio_dias: number;
  num_compras: number;
}

/**
 * Detecta productos "habituales" del cliente que dejó de comprar.
 *
 * Habitual = aparece en ≥3 facturas FA distintas.
 * Abandono = `dias_sin_comprar` > 2× `intervalo_medio_dias` del producto.
 *
 * Salida ordenada por severidad descendente (`dias_sin / intervalo_medio`).
 * Ideal para destacar al vendedor los productos más caídos primero.
 */
export function detectarProductosAbandono(facturas: FacturaHistorial[], ahora: Date): ProductoAbandono[] {
  const ahoraMs = ahora.getTime();
  // Agrupar por cod_articulo: fechas únicas (por fecha de la factura) donde apareció en FAs.
  const fechasPorArt = new Map<number, { detalle: string; fechas: Set<string> }>();
  for (const f of facturas) {
    if (f.tipo !== 'FA') continue;
    for (const it of f.items) {
      const cod = it.cod_articulo;
      if (!Number.isFinite(cod)) continue;
      let entry = fechasPorArt.get(cod);
      if (!entry) { entry = { detalle: it.detalle, fechas: new Set() }; fechasPorArt.set(cod, entry); }
      entry.fechas.add(f.fecha);
    }
  }
  const result: ProductoAbandono[] = [];
  for (const [cod, { detalle, fechas }] of fechasPorArt) {
    if (fechas.size < 3) continue;
    const sorted = [...fechas].sort();
    const intervaloMedio = mediaIntervalos(sorted);
    if (intervaloMedio <= 0) continue;
    const ultima = sorted[sorted.length - 1];
    const diasSin = diasEntre(ultima, ahoraMs);
    if (diasSin <= 2 * intervaloMedio) continue;
    result.push({
      cod_articulo: cod,
      detalle,
      dias_sin_comprar: diasSin,
      intervalo_medio_dias: Math.round(intervaloMedio * 10) / 10,
      num_compras: fechas.size,
    });
  }
  // Severidad = qué tan tarde está respecto a su propia frecuencia.
  result.sort((a, b) => (b.dias_sin_comprar / b.intervalo_medio_dias) - (a.dias_sin_comprar / a.intervalo_medio_dias));
  return result;
}

export interface ComparacionTrimestre {
  actual: number;
  anterior: number;
  delta_pct: number | null;
}

/**
 * Suma los `total_neto` (que ya vienen con signo: FA + / NC -) de cada
 * arreglo de facturas y devuelve los totales + delta porcentual.
 * Si el trimestre anterior es 0, delta_pct es null (evita división por 0).
 */
export function calcularComparacionTrimestre(actual: FacturaHistorial[], anterior: FacturaHistorial[]): ComparacionTrimestre {
  const sumActual = actual.reduce((acc, f) => acc + f.total_neto, 0);
  const sumAnterior = anterior.reduce((acc, f) => acc + f.total_neto, 0);
  const delta_pct = sumAnterior !== 0 ? (sumActual - sumAnterior) / Math.abs(sumAnterior) : null;
  return { actual: sumActual, anterior: sumAnterior, delta_pct };
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
  const tStart = Date.now();
  const log = (etapa: string, extra?: object) => {
    console.log(`[historial-compras cod=${req.params.cod}] +${Date.now() - tStart}ms ${etapa}${extra ? ' ' + JSON.stringify(extra) : ''}`);
  };
  try {
    log('start');
    const { tipoComprobante, isAnulada } = await import('../src/utils/ventas.js');
    const { getMonthlyVentasRaw, getMonthlyItemsRaw, peekMonthlyVentas, peekMonthlyItems } = await import('./snapshotCache.js');
    const { fetchArticulosCatalogo, fetchClientesIMCached } = await import('./infomanager.js');
    const { COD_EMPRESA_CASA_CENTRAL, COD_CLIENTES_INTERNOS } = await import('./comisionesShared.js');
    log('imports-done');

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
      log('clientes-im-cache', { len: clientesIM.length });
      const cli = clientesIM.find((c: any) => Number(c.cod_cliente) === codCliente);
      if (!cli || Number(cli.cod_vendedor) !== Number(user.cod_vendedor)) {
        res.status(403).json({ error: 'Cliente no pertenece al vendedor' });
        return;
      }
    }

    // Cache hit: permiso ya validado arriba, servir el response cacheado.
    const cached = responseCache.get(codCliente);
    if (cached && cached.expiresAt > Date.now()) {
      log('cache-hit');
      res.json(cached.payload);
      return;
    }

    // Estrategia de fetch:
    //  - Trimestre ACTUAL (3 meses más recientes): fast path — esperamos.
    //    Es lo que el usuario realmente quiere ver (top productos + compras
    //    recientes) y el prewarm los mantiene siempre calientes.
    //  - Trimestre ANTERIOR (3 meses previos): best-effort — solo lo usamos
    //    si ya está en cache (peek). Si no, alimentamos alertas/comparación
    //    con los datos parciales que tengamos. El peek dispara un warm en
    //    background; la próxima request los encontrará.
    //
    // Esto convierte un endpoint que podía tardar 30-60s en cold start en
    // uno que siempre responde en <2s, sacrificando temporalmente las
    // alertas hasta que el prewarm complete el trimestre anterior.
    const periodosActual = ultimosMeses(meses);
    const periodosAnterior = ultimosMeses(meses, new Date(Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth() - meses,
      1,
    )));

    const articulosMap = await fetchArticulosCatalogo();
    log('articulos-map', { size: articulosMap.size });
    const fetchesActual = periodosActual.flatMap(p => [
      getMonthlyVentasRaw(p.year, p.month),
      getMonthlyItemsRaw(p.year, p.month),
    ]);
    const resultsActual = await Promise.all(fetchesActual);
    log('fetches-actual-done', {
      cached: resultsActual.map((r: any) => r.cached),
      sizes: resultsActual.map((r: any) => (r.ventas?.length ?? r.items?.length ?? 0)),
    });

    const ventasAll: any[] = [];
    const itemsAll: any[] = [];
    for (let i = 0; i < periodosActual.length; i++) {
      const v = resultsActual[i * 2] as Awaited<ReturnType<typeof getMonthlyVentasRaw>>;
      const it = resultsActual[i * 2 + 1] as Awaited<ReturnType<typeof getMonthlyItemsRaw>>;
      ventasAll.push(...v.ventas);
      itemsAll.push(...it.items);
    }

    // Trimestre anterior: solo lo que ya esté cacheado (no espera fetch).
    // Si falta algún mes, el peek dispara el warm en background.
    let trimestreAnteriorCompleto = true;
    for (const p of periodosAnterior) {
      const v = peekMonthlyVentas(p.year, p.month);
      const it = peekMonthlyItems(p.year, p.month);
      if (v === null || it === null) { trimestreAnteriorCompleto = false; continue; }
      ventasAll.push(...v);
      itemsAll.push(...it);
    }
    log('trimestre-anterior', { completo: trimestreAnteriorCompleto, total_ventas: ventasAll.length, total_items: itemsAll.length });

    // Fecha de corte: primer día del mes más viejo del trimestre actual.
    // periodosActual[meses - 1] = mes -2 cuando meses=3. Todo lo >= a esa
    // fecha es trimestre actual; todo lo < es trimestre anterior.
    const inicioActual = periodosActual[meses - 1];
    const desdeActual = `${inicioActual.year}-${String(inicioActual.month).padStart(2, '0')}-01`;

    const cabsValidas = new Map<number, any>();
    const signosActual = new Map<number, { sign: 1 | -1; fecha: string }>();

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
      if (fecha >= desdeActual) signosActual.set(id, { sign, fecha });
    }

    // Items "limpios" (sin flete/descuento/etc) restringidos al trimestre
    // actual — son los que alimentan top productos.
    const itemsActualLimpios = itemsAll.filter(it => {
      if (!signosActual.has(Number(it.id_comprobante))) return false;
      const detalle = String((it as any).detalle ?? articulosMap.get(Number(it.cod_articulo))?.descripcion ?? '');
      return !esLineaTecnica(detalle);
    });

    const agg = agregarPorArticulo(itemsActualLimpios, signosActual, articulosMap);
    const top_importe = topPorImporte(agg, 5);
    const top_frecuencia = topPorFrecuencia(agg, 5);

    // Facturas armadas para los 6 meses. Las usamos para separar actual /
    // anterior y para correr las funciones de análisis. Lo que devolvemos al
    // cliente como `facturas` es solo el trimestre actual.
    const facturasTodas = armarFacturas(cabsValidas, itemsAll, articulosMap);
    const facturas = facturasTodas.filter(f => f.fecha >= desdeActual);
    const facturasAnterior = facturasTodas.filter(f => f.fecha < desdeActual);

    const ahora = new Date();
    // Si el trimestre anterior no estaba completo en cache, alertas y
    // comparación se calculan con datos parciales — preferimos no mostrarlas
    // a mostrar números engañosos. Cuando el prewarm complete, la próxima
    // request (hit del cache 5min del response) ya las verá llenas tras
    // expirar el TTL.
    const alerta_cliente = trimestreAnteriorCompleto ? calcularAlertaCliente(facturasTodas, ahora) : null;
    const productos_abandono = trimestreAnteriorCompleto ? detectarProductosAbandono(facturasTodas, ahora) : [];
    const comparacion = trimestreAnteriorCompleto
      ? calcularComparacionTrimestre(facturas, facturasAnterior)
      : { actual: facturas.reduce((s, f) => s + f.total_neto, 0), anterior: 0, delta_pct: null };

    const desde = `${inicioActual.year}-${String(inicioActual.month).padStart(2, '0')}-01`;
    const lastMes = new Date(periodosActual[0].year, periodosActual[0].month, 0);
    const hasta = `${periodosActual[0].year}-${String(periodosActual[0].month).padStart(2, '0')}-${String(lastMes.getDate()).padStart(2, '0')}`;

    const payload = {
      ok: true,
      cod_cliente: codCliente,
      meses,
      rango: { desde, hasta },
      facturas,
      top_importe,
      top_frecuencia,
      alertas: {
        cliente: alerta_cliente,
        productos: productos_abandono,
      },
      comparacion,
      trimestre_anterior_completo: trimestreAnteriorCompleto,
      generated_at: new Date().toISOString(),
    };
    // Cachear siempre: si el trimestre anterior estaba completo TTL 5min;
    // si fue parcial, TTL corto 60s — el cache del usuario reusa el cómputo
    // pesado mientras el prewarm completa, pero expira pronto para mostrar
    // alertas tras el warm background.
    const ttl = trimestreAnteriorCompleto ? RESPONSE_CACHE_TTL_MS : 60_000;
    responseCache.set(codCliente, { payload, expiresAt: Date.now() + ttl });
    log('done', { facturas: facturas.length, ms: Date.now() - tStart });
    res.json(payload);
  } catch (err: any) {
    console.error('historialComprasCliente error:', err);
    res.status(500).json({ ok: false, error: err?.message ?? 'error' });
  }
}
