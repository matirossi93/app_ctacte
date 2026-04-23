import axios, { AxiosInstance } from 'axios';

const BASE = process.env.INFOMANAGER_BASE_URL || 'https://impedidos.infomanager.com.ar/api/v1';
const CLIENT_ID = process.env.INFOMANAGER_CLIENT_ID || 'ck_elmanantialsrl_base';
const CLIENT_SECRET = process.env.INFOMANAGER_CLIENT_SECRET || 'e4MCtm6L_PzdnTL';

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
    timeout: 60000,
    headers: { Authorization: `Bearer ${t}` }
  });
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
  const limit = opts?.limit ?? 500;
  const all: VentaRaw[] = [];
  let page = 1;
  while (true) {
    // InfoManager usa fechaDesde/fechaHasta (NO desde/hasta)
    const params: Record<string, string | number> = { fechaDesde: desde, fechaHasta: hasta, page, limit };
    if (opts?.codEmpresa) params.codEmpresa = opts.codEmpresa;
    const { data } = await cli.get('/ventas', { params });
    const rows: VentaRaw[] = data?.results ?? data?.ventas ?? (Array.isArray(data) ? data : []);
    all.push(...rows);
    const totalItems = data?.totalItems ?? null;
    const nextPage = data?.nextPage ?? null;
    if (!rows.length || !nextPage) break;
    if (totalItems != null && all.length >= totalItems) break;
    page += 1;
    if (page > 200) {
      console.warn(`fetchVentas: safety break en page ${page}, total=${all.length}`);
      break;
    }
  }
  return all;
}

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
    const id = String(data?.id ?? data?.recibo_id ?? data?.rc_id ?? '');
    return { ok: true, raw: data, id };
  } catch (err: any) {
    const raw = err?.response?.data;
    const status = err?.response?.status;
    return { ok: false, error: `HTTP ${status ?? '?'}: ${err?.message ?? 'unknown'}`, raw };
  }
}

/** @deprecated Usar getFormaPagoIM de ./mediosPago.js — este re-export queda por compat */
export { getFormaPagoIM as formaPagoUIToIM } from './mediosPago.js';

export async function fetchComprobPendientes(codEmpresa: number, codCliente?: number): Promise<any[]> {
  const cli = await imClient();
  const params: Record<string, any> = { tag: 'todos', codEmpresa, codCliente: codCliente ?? 0 };
  const { data } = await cli.get('/reportes/comprob_pendientes_clientes', { params });
  return Array.isArray(data) ? data : (data?.results ?? []);
}

export async function fetchVendedores(): Promise<Array<{ cod_vendedor: number; nombre: string }>> {
  const cli = await imClient();
  const { data } = await cli.get('/vendedores');
  return Array.isArray(data) ? data : (data?.results ?? []);
}
