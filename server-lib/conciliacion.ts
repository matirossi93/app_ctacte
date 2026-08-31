import * as XLSX from 'xlsx';
import type { Request, Response } from 'express';
import { sb, TENANT_ID } from './supabase.js';
import { fetchComprobPendientes, fetchClientesIMCached, fetchVendedores } from './infomanager.js';
import { COD_CLIENTES_INTERNOS, COD_VENDEDORES_VISIBLES } from './comisionesShared.js';
import { RECIBO_STATUSES, CADUCADO_PREFIX, type ReciboStatus } from './recibosShared.js';
import type { JwtPayload } from './auth.js';

// ═══════════════════════════════════════════════════════════════════════════
// Conciliación de cuenta corriente de clientes (admin/gerente)
//
// Reemplaza el cruce manual mensual "carpeta del vendedor vs InfoManager":
// por cada vendedor y cliente muestra el saldo según IM (suma de comprobantes
// pendientes), las cobranzas cargadas en la app que todavía NO llegaron a IM
// ("en tránsito") y el saldo ajustado = IM − tránsito.
// ═══════════════════════════════════════════════════════════════════════════

/** Andrea (mostrador). En comisiones queda afuera; acá SÍ interesa su cartera. */
export const COD_VENDEDOR_MOSTRADOR = 6;

/** Vendedores con grupo propio en la conciliación: comerciales + mostrador. */
export const COD_VENDEDORES_CONCILIACION = new Set<number>([
  ...COD_VENDEDORES_VISIBLES,
  COD_VENDEDOR_MOSTRADOR,
]);

/**
 * Estados NO terminales de comprobantes_pago que la conciliación trae de
 * Supabase (derivados de RECIBO_STATUSES, la fuente única — ver recibosShared).
 * Cómo cuenta cada uno lo decide clasificarRecibos():
 *  - pendiente_revision            → EN TRÁNSITO (resta del saldo IM)
 *  - error (rechazo real de IM)    → EN TRÁNSITO (la plata se cobró, reprocesar)
 *  - error con prefijo [CADUCADO]  → NO resta; contador aparte para depurar
 *  - aprobado (anticipo manual)    → NO resta; bucket propio para verificar
 * ('imputado' ya está en IM; 'rechazado' no es plata real.)
 */
export const ESTADOS_NO_TERMINALES: ReciboStatus[] =
  RECIBO_STATUSES.filter(s => s !== 'imputado' && s !== 'rechazado');

/** Clientes con |saldo IM| menor a esto y sin tránsito son ruido de centavos. */
const UMBRAL_RUIDO = 1;

/** Grupo sintético para clientes cuyo vendedor no matchea ninguno conocido. */
const COD_SIN_VENDEDOR = 0;

// ─── Shapes de entrada (mínimos que consume la función pura) ────────────────

/** Fila de /reportes/comprob_pendientes_clientes (solo los campos que usamos). */
export interface PendienteIM {
  cod_cliente: number;
  cod_vendedor?: number;          // ⚠️ RC/NC vienen con 0 — NO usar para agrupar
  nombre?: string;
  tipo_comprobante?: string;
  punto_de_venta?: number;
  numero?: number;
  id_asiento?: number;
  fecha_factura?: string;
  importe_factura?: number;
  importe_pagado?: number;
  saldo?: number;
  dias_deuda?: number;
  [k: string]: any;
}

/** Cliente del maestro IM (fetchClientesIMCached). */
export interface ClienteMaestro {
  cod_cliente: number;
  razon_social?: string;
  cod_vendedor?: number | null;
  [k: string]: any;
}

/** Recibo no terminal (fila de comprobantes_pago). */
export interface ReciboTransito {
  id: string;
  cod_cliente: number;
  monto: number;
  fecha_comprobante?: string | null;
  created_at?: string | null;
  status: string;
  error_msg?: string | null;
  /** Solo viene en el cruce carpeta: recibos imputados DESPUÉS del corte. */
  imputado_at?: string | null;
}

export interface VendedorIM { cod_vendedor: number; nombre: string }

// ─── Shapes de salida ────────────────────────────────────────────────────────

export interface ComprobanteConc {
  tipo: string;
  numero: string;
  fecha: string;
  importe: number;
  pagado: number;
  saldo: number;
  dias: number | null;
}

export interface ReciboTransitoConc {
  id: string;
  monto: number;
  fecha: string | null;
  status: string;
}

export interface AnticipoConc {
  id: string;
  monto: number;
  fecha: string | null;
}

export interface ClienteConc {
  cod_cliente: number;
  nombre: string;
  saldo_im: number;
  n_comprobantes: number;
  aging_dias: number | null;
  en_transito: number;
  saldo_ajustado: number;
  comprobantes: ComprobanteConc[];
  recibos_transito: ReciboTransitoConc[];
  /** Anticipos status='aprobado': NO restan (ver clasificarRecibos). */
  anticipos_aprobados: AnticipoConc[];
  /** Recibos status='error' con prefijo [CADUCADO]: basura por depurar, no restan. */
  caducados: number;
}

export interface VendedorConc {
  cod_vendedor: number;
  nombre: string;
  total_saldo_im: number;
  total_en_transito: number;
  total_ajustado: number;
  total_anticipos: number;
  clientes: ClienteConc[];
}

export interface InternaConc {
  cod_cliente: number;
  nombre: string;
  saldo_im: number;
  n_comprobantes: number;
  en_transito: number;
  total_anticipos: number;
  caducados: number;
}

export interface ResultadoConciliacion {
  vendedores: VendedorConc[];
  internas: InternaConc[];
  /** Totales SOLO de clientes reales (los grupos de vendedor); internas afuera. */
  totales: {
    saldo_im: number;
    en_transito: number;
    ajustado: number;
    total_anticipos: number;
    caducados: number;
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Redondeo a 2 decimales para no arrastrar ruido de float en las sumas. */
function r2(n: number): number { return Math.round(n * 100) / 100; }

/** Número legible del comprobante: "0003-00142847" o "asiento 52096837". */
function numeroComprobante(row: PendienteIM): string {
  const pv = Number(row.punto_de_venta) || 0;
  const num = Number(row.numero) || 0;
  if (pv || num) return `${String(pv).padStart(4, '0')}-${String(num).padStart(8, '0')}`;
  if (row.id_asiento) return `asiento ${row.id_asiento}`;
  return '—';
}

function fechaRecibo(rec: ReciboTransito): string | null {
  if (rec.fecha_comprobante) return String(rec.fecha_comprobante).slice(0, 10);
  if (rec.created_at) return String(rec.created_at).slice(0, 10);
  return null;
}

interface RecibosClasificados {
  transito: ReciboTransitoConc[];
  anticipos: AnticipoConc[];
  enTransito: number;
  totalAnticipos: number;
  caducados: number;
}

/**
 * Clasifica los recibos no terminales de UN cliente:
 *
 *  - EN TRÁNSITO (restan del saldo IM): pendiente_revision + error real de IM.
 *    En ambos casos la plata se cobró y falta imputarla en IM.
 *
 *  - ANTICIPOS 'aprobado' (NO restan): la API de IM no soporta anticipos, el
 *    backoffice los carga A MANO en el escritorio de IM. Como no existe
 *    transición aprobado→imputado en la app (solo reabrir→pendiente_revision,
 *    ver recibos.ts editarRecibo), después de la carga manual la cta cte de IM
 *    YA refleja el anticipo pero el recibo sigue 'aprobado' acá → si lo
 *    restáramos sería un DOBLE DESCUENTO perpetuo. Van a un bucket propio para
 *    que el admin verifique contra IM.
 *
 *  - CADUCADOS (NO restan): status='error' con error_msg prefijo [CADUCADO] es
 *    lo que deja el cron caducarRecibosPendientes tras 30 días sin imputar —
 *    basura por depurar, no un rechazo real de IM. Se cuentan aparte.
 */
export function clasificarRecibos(recs: ReciboTransito[]): RecibosClasificados {
  const transito: ReciboTransitoConc[] = [];
  const anticipos: AnticipoConc[] = [];
  let enTransito = 0;
  let totalAnticipos = 0;
  let caducados = 0;

  for (const rec of recs) {
    const monto = r2(Number(rec.monto) || 0);
    if (rec.status === 'aprobado') {
      anticipos.push({ id: String(rec.id), monto, fecha: fechaRecibo(rec) });
      totalAnticipos = r2(totalAnticipos + monto);
    } else if (rec.status === 'error' && String(rec.error_msg ?? '').startsWith(CADUCADO_PREFIX)) {
      caducados += 1;
    } else {
      transito.push({ id: String(rec.id), monto, fecha: fechaRecibo(rec), status: rec.status });
      enTransito = r2(enTransito + monto);
    }
  }
  return { transito, anticipos, enTransito, totalAnticipos, caducados };
}

// ─── Función pura (testeable sin red) ────────────────────────────────────────

/**
 * Arma la conciliación agrupada por vendedor a partir de datos ya traídos.
 *
 * Reglas (validadas contra spike real 01/07/2026 + review adversarial):
 *  - saldo del cliente = SUM(saldo) de TODAS sus filas (positivas y negativas)
 *  - el vendedor sale del MAESTRO de clientes, no de las filas (RC traen 0)
 *  - aging = MAX(dias_deuda) de filas FA/ND con saldo > 0
 *  - saldo_ajustado = saldo IM − tránsito (anticipos y caducados NO restan,
 *    ver clasificarRecibos)
 *  - internas (1/652/666/861) van a una sección aparte, fuera de los totales;
 *    conservan su tránsito/anticipos/caducados (una interna con SOLO tránsito
 *    también aparece)
 *  - clientes con |saldo| < $1 y sin tránsito/anticipos/caducados se excluyen
 *    (ruido de centavos que deja IM al truncar imputaciones)
 *  - un cliente con recibos en la app pero SIN pendientes en IM igual aparece
 */
export function agruparConciliacion(
  pendientesIM: PendienteIM[],
  clientesMaestro: ClienteMaestro[],
  recibosTransito: ReciboTransito[],
  vendedores: VendedorIM[],
): ResultadoConciliacion {
  // Índices
  const maestro = new Map<number, ClienteMaestro>();
  for (const c of clientesMaestro) maestro.set(Number(c.cod_cliente), c);
  const nombreVendedor = new Map<number, string>();
  for (const v of vendedores) nombreVendedor.set(Number(v.cod_vendedor), String(v.nombre ?? '').trim());

  // Agrupar filas IM por cliente
  const filasPorCliente = new Map<number, PendienteIM[]>();
  for (const row of pendientesIM) {
    const cod = Number(row.cod_cliente);
    if (!Number.isFinite(cod)) continue;
    const arr = filasPorCliente.get(cod);
    if (arr) arr.push(row); else filasPorCliente.set(cod, [row]);
  }

  // Agrupar recibos no terminales por cliente
  const transitoPorCliente = new Map<number, ReciboTransito[]>();
  for (const rec of recibosTransito) {
    const cod = Number(rec.cod_cliente);
    if (!Number.isFinite(cod)) continue;
    const arr = transitoPorCliente.get(cod);
    if (arr) arr.push(rec); else transitoPorCliente.set(cod, [rec]);
  }

  // Universo de clientes = con pendientes en IM ∪ con recibos en la app
  const codsClientes = new Set<number>([...filasPorCliente.keys(), ...transitoPorCliente.keys()]);

  const internas: InternaConc[] = [];
  const clientesPorVendedor = new Map<number, ClienteConc[]>();
  const totales = { saldo_im: 0, en_transito: 0, ajustado: 0, total_anticipos: 0, caducados: 0 };

  for (const cod of codsClientes) {
    const filas = filasPorCliente.get(cod) ?? [];
    const saldoIM = r2(filas.reduce((a, f) => a + (Number(f.saldo) || 0), 0));
    const m = maestro.get(cod);
    const nombre = String(m?.razon_social || filas[0]?.nombre || `Cliente ${cod}`).trim();

    // Clasificar recibos ANTES de la rama interna: las internas también pueden
    // tener cobranzas cargadas en la app y no deben perderlas.
    const cls = clasificarRecibos(transitoPorCliente.get(cod) ?? []);
    const sinRecibos = cls.enTransito === 0 && cls.totalAnticipos === 0 && cls.caducados === 0;

    // ── Cuentas internas (sucursales/consumidor final): sección aparte ──────
    if (COD_CLIENTES_INTERNOS.has(cod)) {
      if (filas.length === 0 && Math.abs(saldoIM) < UMBRAL_RUIDO && sinRecibos) continue;
      internas.push({
        cod_cliente: cod,
        nombre,
        saldo_im: saldoIM,
        n_comprobantes: filas.length,
        en_transito: cls.enTransito,
        total_anticipos: cls.totalAnticipos,
        caducados: cls.caducados,
      });
      continue;
    }

    // Ruido de centavos: decenas de cuentas quedan en ±$0.xx por el truncado
    // a entero que hace IM al imputar recibos. Sin nada en la app, no aportan.
    if (Math.abs(saldoIM) < UMBRAL_RUIDO && sinRecibos) continue;

    // Aging: la factura viva más vieja (FA/ND con saldo positivo)
    let aging: number | null = null;
    for (const f of filas) {
      const tipo = String(f.tipo_comprobante ?? '').toUpperCase();
      if ((tipo === 'FA' || tipo === 'ND') && (Number(f.saldo) || 0) > 0) {
        const dias = Number(f.dias_deuda);
        if (Number.isFinite(dias) && (aging === null || dias > aging)) aging = dias;
      }
    }

    const comprobantes: ComprobanteConc[] = filas
      .map(f => ({
        tipo: String(f.tipo_comprobante ?? '').toUpperCase(),
        numero: numeroComprobante(f),
        fecha: f.fecha_factura ? String(f.fecha_factura).slice(0, 10) : '',
        importe: r2(Number(f.importe_factura) || 0),
        pagado: r2(Number(f.importe_pagado) || 0),
        saldo: r2(Number(f.saldo) || 0),
        dias: Number.isFinite(Number(f.dias_deuda)) ? Number(f.dias_deuda) : null,
      }))
      .sort((a, b) => a.fecha.localeCompare(b.fecha)); // más viejo primero

    const cliente: ClienteConc = {
      cod_cliente: cod,
      nombre,
      saldo_im: saldoIM,
      n_comprobantes: filas.length,
      aging_dias: aging,
      en_transito: cls.enTransito,
      saldo_ajustado: r2(saldoIM - cls.enTransito),
      comprobantes,
      recibos_transito: cls.transito,
      anticipos_aprobados: cls.anticipos,
      caducados: cls.caducados,
    };

    // El vendedor sale del maestro; si no matchea ninguno conocido → "Sin vendedor"
    const codVendMaestro = m?.cod_vendedor != null ? Number(m.cod_vendedor) : null;
    const codVend = codVendMaestro != null && COD_VENDEDORES_CONCILIACION.has(codVendMaestro)
      ? codVendMaestro
      : COD_SIN_VENDEDOR;

    const lista = clientesPorVendedor.get(codVend);
    if (lista) lista.push(cliente); else clientesPorVendedor.set(codVend, [cliente]);

    totales.saldo_im = r2(totales.saldo_im + saldoIM);
    totales.en_transito = r2(totales.en_transito + cls.enTransito);
    totales.total_anticipos = r2(totales.total_anticipos + cls.totalAnticipos);
    totales.caducados += cls.caducados;
  }
  totales.ajustado = r2(totales.saldo_im - totales.en_transito);

  // Armar grupos de vendedor, ordenados por |total ajustado| desc, "Sin vendedor" al final
  const grupos: VendedorConc[] = [];
  for (const [codVend, clientes] of clientesPorVendedor) {
    clientes.sort((a, b) => Math.abs(b.saldo_ajustado) - Math.abs(a.saldo_ajustado));
    const totalIM = r2(clientes.reduce((a, c) => a + c.saldo_im, 0));
    const totalTr = r2(clientes.reduce((a, c) => a + c.en_transito, 0));
    const totalAnt = r2(clientes.reduce((a, c) => a + c.anticipos_aprobados.reduce((x, an) => x + an.monto, 0), 0));
    grupos.push({
      cod_vendedor: codVend,
      nombre: codVend === COD_SIN_VENDEDOR
        ? 'Sin vendedor'
        : (nombreVendedor.get(codVend) || `Vendedor #${codVend}`),
      total_saldo_im: totalIM,
      total_en_transito: totalTr,
      total_ajustado: r2(totalIM - totalTr),
      total_anticipos: totalAnt,
      clientes,
    });
  }
  grupos.sort((a, b) => {
    if (a.cod_vendedor === COD_SIN_VENDEDOR) return 1;
    if (b.cod_vendedor === COD_SIN_VENDEDOR) return -1;
    return Math.abs(b.total_ajustado) - Math.abs(a.total_ajustado);
  });

  internas.sort((a, b) => Math.abs(b.saldo_im) - Math.abs(a.saldo_im));

  return { vendedores: grupos, internas, totales };
}

// ─── Cache RAM del reporte IM (por empresa) ──────────────────────────────────
// fetchComprobPendientes(emp, 0) tarda ~6,5s y pesa ~316KB: no queremos pegarle
// a IM en cada render del panel. TTL 10min; ?refresh=1 lo bypasea. Los recibos
// en tránsito NO se cachean (query barata a Supabase, siempre en vivo).

const PENDIENTES_TTL_MS = 10 * 60 * 1000;
const pendientesCache = new Map<number, { rows: PendienteIM[]; fetchedAt: number }>();
const pendientesPending = new Map<number, Promise<PendienteIM[]>>();

export async function fetchPendientesCached(codEmpresa: number, force: boolean): Promise<{ rows: PendienteIM[]; fetchedAt: number }> {
  const hit = pendientesCache.get(codEmpresa);
  if (!force && hit && (Date.now() - hit.fetchedAt) < PENDIENTES_TTL_MS) return hit;
  // Dedup de llamadas concurrentes (dos admins abriendo el panel a la vez)
  const pending = pendientesPending.get(codEmpresa);
  if (pending) { const rows = await pending; return pendientesCache.get(codEmpresa) ?? { rows, fetchedAt: Date.now() }; }
  const p = fetchComprobPendientes(codEmpresa, 0)
    .then(rows => {
      pendientesCache.set(codEmpresa, { rows, fetchedAt: Date.now() });
      return rows;
    })
    .finally(() => { pendientesPending.delete(codEmpresa); });
  pendientesPending.set(codEmpresa, p);
  const rows = await p;
  return pendientesCache.get(codEmpresa) ?? { rows, fetchedAt: Date.now() };
}

/** Force-invalidate (uso testing). */
export function invalidatePendientesCache(): void { pendientesCache.clear(); }

/** Tope de filas de la query a comprobantes_pago (holgado: hoy hay decenas). */
const TRANSITO_MAX_ROWS = 2000;

/**
 * Recibos no terminales desde Supabase, más recientes primero.
 *
 * cod_empresa NULL se asume Casa Central (1): los recibos recién subidos no
 * tienen empresa (se setea recién al aprobar).
 * TODO multi-empresa: al habilitar BRS/San Juan en el panel hay que resolver
 * los NULL de otra forma (un recibo sin aprobar de un cliente de BRS también
 * viene NULL y hoy caería en el bucket de Casa Central). Opciones: derivar la
 * empresa del cliente, o pedir cod_empresa al subir el comprobante.
 */
export async function fetchRecibosTransito(codEmpresa: number): Promise<ReciboTransito[]> {
  let q = sb().from('comprobantes_pago')
    .select('id, cod_cliente, monto, fecha_comprobante, created_at, status, cod_empresa, error_msg')
    .eq('tenant_id', TENANT_ID)
    .in('status', ESTADOS_NO_TERMINALES)
    .order('created_at', { ascending: false })
    .limit(TRANSITO_MAX_ROWS);
  if (codEmpresa === 1) {
    q = q.or('cod_empresa.eq.1,cod_empresa.is.null');
  } else {
    q = q.eq('cod_empresa', codEmpresa);
  }
  const { data, error } = await q;
  if (error) throw new Error(`comprobantes_pago: ${error.message}`);
  const rows = (data ?? []) as ReciboTransito[];
  if (rows.length === TRANSITO_MAX_ROWS) {
    console.warn(`[conciliacion] comprobantes_pago devolvió ${TRANSITO_MAX_ROWS} filas (el tope): posible truncación de recibos en tránsito`);
  }
  return rows;
}

/** Trae todo y agrupa. Compartido por el endpoint JSON, el export xlsx y /api/cartera. */
export async function armarConciliacion(codEmpresa: number, refresh: boolean): Promise<{ resultado: ResultadoConciliacion; fetchedAt: number }> {
  const [pend, clientes, recibos, vendedores] = await Promise.all([
    fetchPendientesCached(codEmpresa, refresh),
    fetchClientesIMCached(),
    fetchRecibosTransito(codEmpresa),
    fetchVendedores(),
  ]);
  const resultado = agruparConciliacion(pend.rows, clientes, recibos, vendedores);
  return { resultado, fetchedAt: pend.fetchedAt };
}

// ─── Handlers HTTP ───────────────────────────────────────────────────────────

/**
 * GET /api/conciliacion?cod_empresa=1&refresh=0 — panel de conciliación.
 * Auth admin/gerente. ?refresh=1 fuerza re-consulta a IM (bypass del cache).
 */
export async function getConciliacion(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const user = req.user!;
    if (user.rol !== 'admin' && user.rol !== 'gerente') { res.status(403).json({ error: 'Requiere admin/gerente' }); return; }

    const codEmpresa = Number(req.query.cod_empresa) || 1;
    const refresh = String(req.query.refresh ?? '') === '1';
    const { resultado, fetchedAt } = await armarConciliacion(codEmpresa, refresh);

    res.json({
      ok: true,
      cod_empresa: codEmpresa,
      generado_at: new Date(fetchedAt).toISOString(),
      cache_age_s: Math.max(0, Math.round((Date.now() - fetchedAt) / 1000)),
      ...resultado,
    });
  } catch (err: any) {
    console.error('getConciliacion error:', err);
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

// ─── Export xlsx ─────────────────────────────────────────────────────────────

interface SheetDef { name: string; headers: string[]; rows: (string | number | null)[][] }

function buildXlsxMulti(sheets: SheetDef[]): Buffer {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet([s.headers, ...s.rows]);
    // Autowidth basado en headers + datos (mismo criterio que reportes.ts)
    ws['!cols'] = s.headers.map((h, i) => {
      const maxData = s.rows.reduce((m, r) => Math.max(m, String(r[i] ?? '').length), 0);
      return { wch: Math.min(Math.max(h.length, maxData) + 2, 40) };
    });
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * GET /api/conciliacion/export?cod_empresa=1 — descarga xlsx (admin/gerente).
 * Hojas: Resumen (por vendedor), Detalle (una fila por cliente), Internas.
 */
export async function exportConciliacion(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const user = req.user!;
    if (user.rol !== 'admin' && user.rol !== 'gerente') { res.status(403).json({ error: 'Requiere admin/gerente' }); return; }

    const codEmpresa = Number(req.query.cod_empresa) || 1;
    const { resultado } = await armarConciliacion(codEmpresa, false);

    const resumen: SheetDef = {
      name: 'Resumen',
      headers: ['cod_vendedor', 'vendedor', 'clientes', 'saldo_im', 'en_transito', 'saldo_ajustado', 'anticipos_sin_verificar'],
      rows: [
        ...resultado.vendedores.map(v => [
          v.cod_vendedor, v.nombre, v.clientes.length,
          v.total_saldo_im, v.total_en_transito, v.total_ajustado, v.total_anticipos,
        ] as (string | number | null)[]),
        ['', 'TOTAL', resultado.vendedores.reduce((a, v) => a + v.clientes.length, 0),
          resultado.totales.saldo_im, resultado.totales.en_transito,
          resultado.totales.ajustado, resultado.totales.total_anticipos],
      ],
    };

    const detalle: SheetDef = {
      name: 'Detalle',
      headers: ['vendedor', 'cod_cliente', 'cliente', 'saldo_im', 'en_transito', 'saldo_ajustado', 'aging_dias', 'anticipos_sin_verificar', 'recibos_caducados'],
      rows: resultado.vendedores.flatMap(v => v.clientes.map(c => [
        v.nombre, c.cod_cliente, c.nombre, c.saldo_im, c.en_transito, c.saldo_ajustado, c.aging_dias,
        r2(c.anticipos_aprobados.reduce((a, an) => a + an.monto, 0)), c.caducados,
      ] as (string | number | null)[])),
    };

    const internas: SheetDef = {
      name: 'Internas',
      headers: ['cod_cliente', 'nombre', 'saldo_im', 'n_comprobantes', 'en_transito', 'anticipos_sin_verificar', 'recibos_caducados'],
      rows: resultado.internas.map(i => [
        i.cod_cliente, i.nombre, i.saldo_im, i.n_comprobantes, i.en_transito, i.total_anticipos, i.caducados,
      ]),
    };

    const hoy = new Date().toISOString().slice(0, 10);
    const fileName = `Conciliacion_CtaCte_emp${codEmpresa}_${hoy}.xlsx`;
    const buf = buildXlsxMulti([resumen, detalle, internas]);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('X-Report-Rows', String(detalle.rows.length));
    res.send(buf);
  } catch (err: any) {
    console.error('exportConciliacion error:', err);
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

// ─── Snapshot diario de la cta cte (para cortes exactos del Cruce carpeta) ──
// El reporte comprob_pendientes_clientes es una foto de HOY: sin snapshot, un
// corte al 30/06 corrido el 05/07 es solo aproximable. Un cron (~23:50 ART)
// guarda las filas crudas por día en conciliacion_snapshot (migración 013).

/** Fecha de HOY en Argentina (UTC-3 fijo, AR no tiene horario de verano). */
export function hoyISOArgentina(): string {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Maestro cliente→vendedor congelado dentro del snapshot. */
export type MaestroSnapshot = Record<string, { cod_vendedor: number | null; nombre: string }>;

/**
 * Saca la foto del reporte IM y la guarda (upsert por fecha → idempotente:
 * si el cron corre dos veces el mismo día, pisa con la foto más nueva).
 * Fetch DIRECTO a IM (sin cache): es la foto oficial del día.
 * Congela también el MAESTRO cliente→vendedor del momento (un cliente
 * reasignado de vendedor después del corte no debe mover el cruce histórico).
 * Si IM devuelve 0 filas NO persiste (una foto vacía envenenaría el corte
 * "exacto": todo caería en solo-carpeta).
 */
export async function guardarSnapshotConciliacion(codEmpresa: number, fecha?: string): Promise<{ fecha: string; n_rows: number; guardado: boolean }> {
  const f = fecha ?? hoyISOArgentina();
  const [rows, clientes] = await Promise.all([
    fetchComprobPendientes(codEmpresa, 0),
    fetchClientesIMCached(),
  ]);
  if (rows.length === 0) {
    console.warn(`[snapshot conciliacion] emp${codEmpresa} ${f}: IM devolvió 0 filas — NO se guarda (probable falla de IM)`);
    return { fecha: f, n_rows: 0, guardado: false };
  }
  const maestro: MaestroSnapshot = {};
  for (const c of clientes) {
    maestro[String(c.cod_cliente)] = { cod_vendedor: c.cod_vendedor ?? null, nombre: c.razon_social ?? '' };
  }
  const { error } = await sb().from('conciliacion_snapshot').upsert({
    tenant_id: TENANT_ID,
    cod_empresa: codEmpresa,
    fecha: f,
    rows,
    maestro,
    n_rows: rows.length,
    // created_at explícito: el upsert-update de un refresh intradía debe pisar
    // el timestamp para que el banner "foto de hoy a las HH:MM" sea veraz.
    created_at: new Date().toISOString(),
  }, { onConflict: 'tenant_id,cod_empresa,fecha' });
  if (error) throw new Error(`conciliacion_snapshot upsert: ${error.message}`);
  console.log(`[snapshot conciliacion] emp${codEmpresa} ${f}: ${rows.length} filas guardadas`);
  return { fecha: f, n_rows: rows.length, guardado: true };
}

export interface SnapshotConciliacion {
  rows: PendienteIM[];
  /** null en snapshots viejos sin maestro congelado → usar el vivo + advertir. */
  maestro: MaestroSnapshot | null;
  created_at: string;
}

/**
 * Snapshot completo de una fecha, o null si no existe. Un snapshot con 0
 * filas se trata como INEXISTENTE (jamás debería persistirse, pero si llegó
 * a existir no puede pasar por corte "exacto" con sistema vacío).
 */
export async function getSnapshotConciliacion(codEmpresa: number, fecha: string): Promise<SnapshotConciliacion | null> {
  const { data, error } = await sb().from('conciliacion_snapshot')
    .select('rows, maestro, created_at')
    .eq('tenant_id', TENANT_ID)
    .eq('cod_empresa', codEmpresa)
    .eq('fecha', fecha)
    .maybeSingle();
  if (error) throw new Error(`conciliacion_snapshot select: ${error.message}`);
  const rows: PendienteIM[] = Array.isArray(data?.rows) ? data.rows : [];
  if (!data || rows.length === 0) return null;
  return { rows, maestro: data.maestro ?? null, created_at: String(data.created_at) };
}

/**
 * GET /api/conciliacion/snapshots?cod_empresa=1 — fechas con snapshot (para
 * que la UI marque qué cortes son exactos). Auth admin/gerente.
 */
export async function listSnapshotsConciliacion(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const user = req.user!;
    if (user.rol !== 'admin' && user.rol !== 'gerente') { res.status(403).json({ error: 'Requiere admin/gerente' }); return; }
    const codEmpresa = Number(req.query.cod_empresa) || 1;
    const { data, error } = await sb().from('conciliacion_snapshot')
      .select('fecha, n_rows')
      .eq('tenant_id', TENANT_ID)
      .eq('cod_empresa', codEmpresa)
      .order('fecha', { ascending: false })
      .limit(400);
    if (error) { res.status(500).json({ error: error.message }); return; }
    res.json({ ok: true, cod_empresa: codEmpresa, fechas: (data ?? []).map((r: any) => String(r.fecha)) });
  } catch (err: any) {
    console.error('listSnapshotsConciliacion error:', err);
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}
