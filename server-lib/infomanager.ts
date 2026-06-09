import axios, { AxiosInstance } from 'axios';

const BASE = process.env.INFOMANAGER_BASE_URL || 'https://impedidos.infomanager.com.ar/api/v1';
const CLIENT_ID = process.env.INFOMANAGER_CLIENT_ID || 'ck_elmanantialsrl_base';
const CLIENT_SECRET = process.env.INFOMANAGER_CLIENT_SECRET || '';
if (!CLIENT_SECRET) {
  console.error('FATAL: INFOMANAGER_CLIENT_SECRET no está definida en el entorno. Abortando.');
  process.exit(1);
}

let _token: { jwt: string; expiresAt: number } | null = null;
let _pending: Promise<string> | null = null;

export async function imToken(): Promise<string> {
  if (_token && Date.now() < _token.expiresAt - 5 * 60 * 1000) return _token.jwt;
  if (_pending) return _pending;
  _pending = (async () => {
    const res = await axios.post(`${BASE}/auth/login`, {
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET
    }, { timeout: 15000 });
    const jwt = res.data.token;
    _token = { jwt, expiresAt: Date.now() + 23 * 60 * 60 * 1000 };
    return jwt;
  })().finally(() => { _pending = null; });
  return _pending;
}

export async function imClient(): Promise<AxiosInstance> {
  const t = await imToken();
  return axios.create({
    baseURL: BASE,
    // 25s para fallar antes que el reverse-proxy de EasyPanel corte a ~30s.
    // Si IM no responde en ese tiempo, axios tira error y el backend puede
    // responder JSON estructurado en lugar de quedar colgado y devolver HTML 502.
    timeout: 25000,
    headers: { Authorization: `Bearer ${t}` }
  });
}

/**
 * Reintenta una llamada IDEMPOTENTE (GET) ante fallos TRANSITORIOS de IM:
 * timeout (ECONNABORTED), error de red sin respuesta, 5xx o 429. NO reintenta
 * 4xx (errores del cliente, no transitorios). Backoff exponencial 1s/2s/4s.
 * IM tuvo episodios de sobrecarga documentados; un transient de 10-20s a mitad
 * de una página paginada tiraba el sync entero. SOLO para GET — NO usar en
 * POST/crearRecibo sin hacerlo idempotente primero.
 */
async function imGetRetry<T>(fn: () => Promise<T>, label: string, attempts = 3): Promise<T> {
  let lastErr: any;
  for (let intento = 1; intento <= attempts; intento++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const status = err?.response?.status;
      const transitorio = status === undefined || status >= 500 || status === 429
        || ['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(err?.code);
      if (!transitorio || intento === attempts) break;
      const backoff = 1000 * Math.pow(2, intento - 1); // 1s, 2s, 4s
      console.warn(`[IM retry] ${label}: intento ${intento}/${attempts} falló (${status ?? err?.code ?? err?.message}); reintento en ${backoff}ms`);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

export interface VentaRaw {
  id?: number | string;
  tipo?: string;
  tipo_comprobante?: string;
  cod_vendedor?: number;
  cod_cliente?: number;
  cod_empresa?: number;
  fa_total?: number;
  total?: number;
  neto?: number;
  fa_fecha?: string;
  fecha?: string;
  anulada?: 'S' | 'N';
  punto_de_venta?: number;
  numero?: number;
}

/**
 * Fetch paginado de /ventas entre fechas.
 * InfoManager pagina con page + limit. Iteramos hasta que no haya nextPage.
 */
export async function fetchVentas(desde: string, hasta: string, opts?: { codEmpresa?: number; limit?: number }): Promise<VentaRaw[]> {
  const cli = await imClient();
  const limit = opts?.limit ?? 5000;
  const all: VentaRaw[] = [];
  let page = 1;
  while (true) {
    // InfoManager usa fechaDesde/fechaHasta (NO desde/hasta)
    const params: Record<string, string | number> = { fechaDesde: desde, fechaHasta: hasta, page, limit };
    if (opts?.codEmpresa) params.codEmpresa = opts.codEmpresa;
    const { data } = await imGetRetry(() => cli.get('/ventas', { params }), `ventas p${page}`);
    const rows: VentaRaw[] = data?.results ?? data?.ventas ?? (Array.isArray(data) ? data : []);
    all.push(...rows);
    // Si la página vino llena (== limit), asumimos que hay más. Si vino
    // incompleta, terminamos. nextPage de IM no es confiable.
    if (rows.length < limit) break;
    page += 1;
    if (page > 200) {
      console.warn(`fetchVentas: safety break en page ${page}, total=${all.length}`);
      break;
    }
  }
  return all;
}

/**
 * Item (línea) de venta. Shape mínimo confirmado:
 *  - id, id_comprobante, cod_articulo, cantidad
 * Otros campos posibles según uso en proyectos hermanos:
 *  - precio, importe (uno de los dos suele venir).
 * Si ninguno viene, comisiones.ts hace fallback prorrateando fa_total.
 */
export interface VentaItem {
  id?: string | number;
  id_comprobante: number;
  cod_articulo: number | string;
  cantidad: number | string;
  precio?: number | string;
  importe?: number | string;
}

/**
 * GET /api/v1/ventas/items — paginado por rango de fechas.
 * Devuelve TODAS las líneas de las ventas del rango (1 fila por línea).
 */
export async function fetchVentasItems(desde: string, hasta: string, opts?: { codEmpresa?: number; limit?: number }): Promise<VentaItem[]> {
  const cli = await imClient();
  // limit alto para minimizar requests. semillerobi-next y semillero-existencias
  // usan limit=10000 con éxito en /ventas y /ventas/items.
  const limit = opts?.limit ?? 5000;
  const all: VentaItem[] = [];
  let page = 1;
  while (true) {
    const params: Record<string, string | number> = { fechaDesde: desde, fechaHasta: hasta, page, limit };
    if (opts?.codEmpresa) params.codEmpresa = opts.codEmpresa;
    const { data } = await imGetRetry(() => cli.get('/ventas/items', { params }), `ventas/items p${page}`);
    const rows: VentaItem[] = data?.results ?? data?.items ?? (Array.isArray(data) ? data : []);
    all.push(...rows);
    // Estrategia robusta: si la página vino llena (== limit), asumimos que
    // hay más. Si vino incompleta, terminamos. No confío en data.nextPage
    // porque no siempre está documentado y varía entre endpoints de IM.
    if (rows.length < limit) break;
    page += 1;
    if (page > 200) {
      console.warn(`fetchVentasItems: safety break en page ${page}, total=${all.length}`);
      break;
    }
  }
  return all;
}

/**
 * Catálogo mini de artículos cacheado en memoria (TTL 1h).
 * Devuelve Map<cod_articulo, { cod_rubro, descripcion }>.
 *
 * Lo usamos para resolver el rubro de cada línea al calcular comisión.
 * Usa `/articulos/stock` que devuelve TODOS los artículos en una sola
 * request (~3-5s) — mucho más rápido que paginar `/articulos` (>25s con
 * riesgo de timeout, según experiencia documentada en proyecto-alerta-stock).
 * Los hits siguientes son <1ms desde el cache.
 */
interface ArticuloMini { cod_rubro: number | null; descripcion: string; precio_venta: number }
let _articulosCache: { map: Map<number, ArticuloMini>; fetchedAt: number } | null = null;
const ARTICULOS_TTL_MS = 60 * 60 * 1000;

export async function fetchArticulosCatalogo(force = false): Promise<Map<number, ArticuloMini>> {
  if (!force && _articulosCache && (Date.now() - _articulosCache.fetchedAt) < ARTICULOS_TTL_MS) {
    return _articulosCache.map;
  }
  const cli = await imClient();
  const map = new Map<number, ArticuloMini>();
  // /articulos/stock devuelve consolidado de las 3 sucursales, 1 fila por
  // (artículo, depósito). Solo necesitamos cod_articulo → cod_rubro, los
  // duplicados se sobrescriben sin problema (todos comparten rubro).
  const { data } = await imGetRetry(() => cli.get('/articulos/stock'), 'articulos/stock');
  const rows: any[] = data?.results ?? data?.articulos ?? (Array.isArray(data) ? data : []);
  for (const r of rows) {
    const cod = Number(r.cod_articulo ?? r.cod ?? r.codigo);
    if (!Number.isFinite(cod)) continue;
    const codRubroRaw = r.cod_rubro ?? r.codRubro ?? r.rubro_cod;
    const codRubro = codRubroRaw != null ? Number(codRubroRaw) : null;
    const precioRaw = r.precio_venta ?? r.precioVenta ?? r.precio ?? 0;
    const precio = Number(precioRaw);
    map.set(cod, {
      cod_rubro: Number.isFinite(codRubro as number) ? codRubro : null,
      descripcion: String(r.descripcion ?? r.nombre ?? '').trim(),
      precio_venta: Number.isFinite(precio) ? precio : 0,
    });
  }
  _articulosCache = { map, fetchedAt: Date.now() };
  return map;
}

export function invalidateArticulosCatalogo(): void { _articulosCache = null; }

/**
 * POST /api/v1/recibo — emitir recibo en InfoManager.
 * Shape exacto del swagger (todos strings, patterns obligatorios).
 */
export type FormaPagoIM = 'EF' | 'TJ' | 'OT';

export interface ReciboPago {
  forma_pago: FormaPagoIM;          // EF=efectivo, TJ=tarjeta, OT=otro (transferencia, MP, cheque)
  importe: string;                   // "0.00"
  cod_cuenta: string;                // cuenta contable (depende del medio); configurable por env
  cod_unidad_negocio?: string;
  tarjeta_numero?: string;           // solo TJ
  tarjeta_numero_cupon?: string;     // solo TJ
  // Campos NO documentados en swagger oficial — los enviamos sólo si
  // IM_RECIBO_FECHAS_PAGO=true. Verificado 12/05/2026: IM acepta sin error
  // pero los ignora al grabar. Quedan en el código por si el proveedor IM
  // agrega soporte oficial (ver mail al proveedor en
  // c:/tmp/mail_soporte_infomanager.md). Ronda 2 probó 8 variantes más
  // (fecha_emision, fec_em, fechaEmision, etc) — todas ignoradas igual.
  fec_emision?: string;              // "YYYY-MM-DD"
  fec_pago?: string;                 // "YYYY-MM-DD"
}

export interface ReciboComprobante {
  id: string;                        // id único del comprobante (desde /reportes/comprob_pendientes_clientes)
  importe_a_pagar: string;
}

export interface CrearReciboInput {
  cod_empresa: string;               // "1" | "2" | "3"
  fecha: string;                     // "YYYY-MM-DD"
  centro_costo: 'S' | 'N';
  cod_cliente: string;
  usuario: string;                    // debe existir en InfoManager
  detalle?: string;
  moneda: string;                    // "P" = pesos
  cotizacion: string;                // "1.0" para P
  pagos: ReciboPago[];
  comprobantes: ReciboComprobante[];
}

export async function crearRecibo(input: CrearReciboInput): Promise<{ ok: true; raw: any; id?: string } | { ok: false; error: string; raw?: any }> {
  try {
    const cli = await imClient();
    const { data } = await cli.post('/recibo', input);
    // IM devuelve { recibo: { id, numero, pagos: [{id, ...}], ... }, isCreated }
    // El id interno es data.recibo.id; el numero visible (para usuario) es data.recibo.numero.
    const id = String(
      data?.recibo?.id ?? data?.id ?? data?.recibo_id ?? data?.rc_id
      ?? data?.recibo?.numero ?? data?.numero ?? ''
    );
    console.log('[crearRecibo] OK · id=' + (id || '(vacío!)') + ' numero=' + (data?.recibo?.numero ?? '?'));
    return { ok: true, raw: data, id };
  } catch (err: any) {
    const raw = err?.response?.data;
    const status = err?.response?.status;
    return { ok: false, error: `HTTP ${status ?? '?'}: ${err?.message ?? 'unknown'}`, raw };
  }
}

/**
 * Debug: probar endpoints no documentados de edición de recibo y/o pago.
 * El cliente desktop de IM permite editar Fec.Em./Fec.Pago de un recibo
 * creado — por lo tanto debe existir un endpoint oculto.
 *
 * Hallazgo clave: IM devuelve cada pago con su propio `id`. Probablemente
 * exista un endpoint `/pagos/{id}` o `/recibo/{recibo_id}/pago/{pago_id}`
 * para editar pagos individualmente.
 *
 * Esta función prueba varias URLs/métodos contra el recibo Y el pago, y
 * devuelve qué respondió cada uno (404 = no existe, 200 = endpoint válido,
 * 405 = endpoint válido pero método no permitido).
 */
export async function probarEditarReciboIM(reciboId: string, fecha: string, pagoId?: string): Promise<any> {
  const cli = await imClient();
  const intentos: Array<{ method: string; url: string; body?: any }> = [
    // ── Probar GET para descubrir endpoints válidos (200 = existe) ─────────
    { method: 'GET', url: `/recibo/${reciboId}` },
    { method: 'GET', url: `/recibos/${reciboId}` },
    { method: 'GET', url: `/recibo/${reciboId}/pagos` },
    // ── Editar recibo (header completo) ────────────────────────────────────
    { method: 'PUT', url: `/recibo/${reciboId}`, body: { fecha } },
    { method: 'PATCH', url: `/recibo/${reciboId}`, body: { fecha } },
    { method: 'PUT', url: `/recibos/${reciboId}`, body: { fecha } },
  ];
  // ── Si tenemos el ID del pago, probar editarlo directo ─────────────────
  if (pagoId) {
    intentos.push(
      { method: 'GET', url: `/pago/${pagoId}` },
      { method: 'GET', url: `/pagos/${pagoId}` },
      { method: 'PUT', url: `/pago/${pagoId}`, body: { fec_emision: fecha, fec_pago: fecha } },
      { method: 'PATCH', url: `/pago/${pagoId}`, body: { fec_emision: fecha, fec_pago: fecha } },
      { method: 'PUT', url: `/pagos/${pagoId}`, body: { fec_emision: fecha, fec_pago: fecha } },
      { method: 'PATCH', url: `/pagos/${pagoId}`, body: { fec_emision: fecha, fec_pago: fecha } },
      { method: 'PUT', url: `/recibo/${reciboId}/pago/${pagoId}`, body: { fec_emision: fecha, fec_pago: fecha } },
      { method: 'PATCH', url: `/recibo/${reciboId}/pago/${pagoId}`, body: { fec_emision: fecha, fec_pago: fecha } },
    );
  }
  const resultados: any[] = [];
  for (const i of intentos) {
    try {
      const res = i.body !== undefined
        ? await (cli as any).request({ method: i.method, url: i.url, data: i.body })
        : await (cli as any).request({ method: i.method, url: i.url });
      resultados.push({
        method: i.method, url: i.url, status: res.status,
        ok: true, data: typeof res.data === 'object' ? JSON.stringify(res.data).slice(0, 500) : String(res.data).slice(0, 500),
      });
    } catch (err: any) {
      resultados.push({
        method: i.method, url: i.url, status: err?.response?.status ?? null,
        ok: false, error: err?.message?.slice(0, 200), data: err?.response?.data ? JSON.stringify(err.response.data).slice(0, 300) : null,
      });
    }
  }
  return resultados;
}

/** @deprecated Usar getFormaPagoIM de ./mediosPago.js — este re-export queda por compat */
export { getFormaPagoIM as formaPagoUIToIM } from './mediosPago.js';

export async function fetchComprobPendientes(codEmpresa: number, codCliente?: number): Promise<any[]> {
  const cli = await imClient();
  const params: Record<string, any> = { tag: 'todos', codEmpresa, codCliente: codCliente ?? 0 };
  const { data } = await imGetRetry(() => cli.get('/reportes/comprob_pendientes_clientes', { params }), `comprob_pendientes emp${codEmpresa}`);
  return Array.isArray(data) ? data : (data?.results ?? []);
}

// Cache RAM de /vendedores: la lista cambia con muy baja frecuencia (Matías
// agrega un vendedor cada varios meses) y se llamaba en cada /api/goals,
// gastando ~800ms de latencia IM por request. TTL 1h. Reinicia el container
// para forzar refresh inmediato si hace falta.
let vendedoresCache: { data: Array<{ cod_vendedor: number; nombre: string }>; fetchedAt: number } | null = null;
const VENDEDORES_TTL_MS = 60 * 60 * 1000;

export async function fetchVendedores(): Promise<Array<{ cod_vendedor: number; nombre: string }>> {
  const now = Date.now();
  if (vendedoresCache && (now - vendedoresCache.fetchedAt) < VENDEDORES_TTL_MS) {
    return vendedoresCache.data;
  }
  const cli = await imClient();
  const { data } = await imGetRetry(() => cli.get('/vendedores'), 'vendedores');
  const rows = Array.isArray(data) ? data : (data?.results ?? []);
  vendedoresCache = { data: rows, fetchedAt: now };
  return rows;
}

/** Force-invalidate (uso testing o por endpoint admin si hace falta). */
export function invalidateVendedoresCache(): void { vendedoresCache = null; }

export interface PlanCuenta {
  cod_cuenta: string;
  nombre: string;
  [k: string]: any;
}

/** Trae el plan de cuentas completo (~316 cuentas). */
export async function fetchPlanCuentas(): Promise<PlanCuenta[]> {
  const cli = await imClient();
  const { data } = await imGetRetry(() => cli.get('/planes'), 'planes');
  const rows = Array.isArray(data) ? data : (data?.results ?? []);
  // InfoManager puede usar "id" o "cod_cuenta" según el recurso — normalizo.
  return rows.map((r: any) => ({
    ...r,
    cod_cuenta: String(r.cod_cuenta ?? r.id ?? r.codigo ?? ''),
    nombre: String(r.nombre ?? r.descripcion ?? ''),
  }));
}

export interface ClienteIM {
  cod_cliente: number;
  razon_social?: string;
  localidad?: string | null;
  cod_vendedor?: number | null;
  telefono?: string | null;
  whatsapp?: string | null;
  [k: string]: any;
}

/**
 * Trae la lista de clientes desde InfoManager. Endpoint paginado (requiere page+limit).
 * Iteramos hasta que la página vuelva vacía o con menos elementos que limit.
 * Sin doc formal del shape, soportamos varios nombres comunes de columna
 * (telefono/tel_fijo/tel, celular/whatsapp/movil) y normalizamos a
 * `{telefono, whatsapp}`. Si IM no trae contactos, devuelve nulls graciosamente.
 */
export async function fetchClientesIM(): Promise<ClienteIM[]> {
  const cli = await imClient();
  const PAGE_SIZE = 500;
  const MAX_PAGES = 20; // safety cap: soporta hasta 10k clientes
  const all: any[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data } = await imGetRetry(() => cli.get('/clientes', { params: { page, limit: PAGE_SIZE } }), `clientes p${page}`);
    const rows = Array.isArray(data) ? data
      : (data?.results ?? data?.clientes ?? data?.data ?? data?.items ?? []);
    if (!rows.length) break;
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return all.map((r: any) => {
    const cod = Number(r.cod_cliente ?? r.codigo ?? r.id ?? r.cod ?? 0);
    const telFijo = r.telefono ?? r.tel_fijo ?? r.tel ?? r.telefonos ?? null;
    const cel = r.celular ?? r.whatsapp ?? r.movil ?? r.cel ?? null;
    const codVend = r.cod_vendedor ?? r.codVendedor ?? r.vendedor_cod ?? null;
    return {
      ...r,
      cod_cliente: cod,
      razon_social: r.razon_social ?? r.nombre ?? '',
      localidad: r.localidad ?? r.ciudad ?? null,
      cod_vendedor: codVend != null && Number.isFinite(Number(codVend)) ? Number(codVend) : null,
      telefono: telFijo ? String(telFijo) : null,
      whatsapp: cel ? String(cel) : (telFijo ? String(telFijo) : null),
    };
  }).filter((c: ClienteIM) => c.cod_cliente > 0);
}

// Cache RAM de /clientes de InfoManager. El maestro cambia poco y paginar 20
// páginas en cada lookup del picker de Recibos era caro. TTL 30min; reiniciar
// el container o llamar invalidateClientesIMCache() fuerza refresh inmediato.
let clientesIMCache: { data: ClienteIM[]; fetchedAt: number } | null = null;
let clientesIMPending: Promise<ClienteIM[]> | null = null;
const CLIENTES_IM_TTL_MS = 30 * 60 * 1000;

export async function fetchClientesIMCached(force = false): Promise<ClienteIM[]> {
  if (!force && clientesIMCache && (Date.now() - clientesIMCache.fetchedAt) < CLIENTES_IM_TTL_MS) {
    return clientesIMCache.data;
  }
  if (clientesIMPending) return clientesIMPending;
  clientesIMPending = fetchClientesIM()
    .then(rows => { clientesIMCache = { data: rows, fetchedAt: Date.now() }; return rows; })
    .catch(err => {
      console.error('[fetchClientesIMCached]', err?.message ?? err);
      // Si ya teníamos cache (aunque vencido), lo devolvemos antes que nada.
      return clientesIMCache?.data ?? [];
    })
    .finally(() => { clientesIMPending = null; });
  return clientesIMPending;
}

export function invalidateClientesIMCache(): void { clientesIMCache = null; }
