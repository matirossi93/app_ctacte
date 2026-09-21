import axios from 'axios';
import { lecturaLimitada } from './lecturasCompartidas.js';

/**
 * LA API NUEVA DE INFOMANAGER (`imapi`, v2).
 *
 * Mati (21/09/2026), sobre incorporar NC y ND: *"capaz que con la nueva API ya podemos"*.
 * Probado en vivo ese día: sí. Lo que destraba, y que la v1 no tiene:
 *
 *   · `id_comp_asoc` / `pto_vta_comp_asoc` + `num_comp_asoc` — comprobante asociado NATIVO. Hoy
 *     la nota queda atada a su factura por un texto en observaciones ("SEGUN FACTURA 50401").
 *   · `id_item_origen` — qué renglón de la factura corrige cada renglón de la nota.
 *   · `numero: 0` — lo numera el sistema. Era el choque de serie que frenó la NC B 30079 el
 *     11/09/2026 y nos dejó calculando el correlativo a mano.
 *   · `genero_re_auto: S` con `tipo_nc: DE` — genera la recepción por devolución y reingresa el
 *     stock, que hoy se hace a mano.
 *
 * 🔴 SE AUTENTICA DISTINTO, y por eso este módulo existe aparte de `infomanager.ts`:
 *
 *   |            | vieja (`/api/v1` en impedidos)      | nueva (`imapi`)                        |
 *   |------------|-------------------------------------|----------------------------------------|
 *   | token      | `POST /auth/login` → JWT de ~24 h   | `POST /oauth/token` → **15 minutos**   |
 *   | por request| `Authorization: Bearer`             | `Authorization: Bearer` **+ `X-Api-Key`** |
 *
 * 🪤 Copiar acá el cache de 23 h de la vieja haría que el cliente sirva 401 durante 22 h 45 m.
 * Es la misma trampa anotada para el `im-proxy`; este cliente nace con el TTL que corresponde y
 * respeta el `expires_in` que manda el servidor en vez de un número fijo nuestro.
 */
const VARIABLES = ['IM_V2_BASE_URL', 'IM_V2_CLIENT_ID', 'IM_V2_CLIENT_SECRET', 'IM_V2_API_KEY'] as const;

const conf = () => ({
  base: (process.env.IM_V2_BASE_URL || 'https://app.infomanager.com.ar/imapi').replace(/\/+$/, ''),
  id: process.env.IM_V2_CLIENT_ID || '',
  secret: process.env.IM_V2_CLIENT_SECRET || '',
  key: process.env.IM_V2_API_KEY || '',
});

/**
 * ¿Están las credenciales? Sin ellas la app funciona igual: lo que dependa de v2 se apaga solo.
 * Se consulta antes de ofrecer una capacidad, no se descubre con un 500 en la cara del usuario.
 */
export function imV2Configurada(): boolean {
  const c = conf();
  return !!(c.id && c.secret && c.key);
}

function faltantes(): string[] {
  const c = conf();
  const falta: string[] = [];
  if (!c.id) falta.push('IM_V2_CLIENT_ID');
  if (!c.secret) falta.push('IM_V2_CLIENT_SECRET');
  if (!c.key) falta.push('IM_V2_API_KEY');
  return falta;
}

/** El error de la API nueva: `{error:{code,message,traceId}}`. El traceId es lo que pide el soporte. */
export class ErrorV2 extends Error {
  constructor(
    mensaje: string,
    readonly status: number | null,
    readonly code: string | null,
    readonly traceId: string | null,
  ) { super(mensaje); this.name = 'ErrorV2'; }
}

let _token: { valor: string; venceAt: number } | null = null;
let _pidiendo: Promise<string> | null = null;

/** Para los tests y para forzar un login nuevo si alguna vez hace falta. */
export function _resetV2(): void { _token = null; _pidiendo = null; }

/**
 * 🪤 Un minuto de margen: si se pide el token justo cuando faltan segundos, la llamada que lo
 * usa puede salir con el token ya vencido y volver 401 sin motivo aparente.
 */
const MARGEN_MS = 60_000;

export async function tokenV2(): Promise<string> {
  const falta = faltantes();
  if (falta.length) throw new ErrorV2(`Falta configurar ${falta.join(', ')} para usar la API v2 de InfoManager.`, null, 'SIN_CONFIGURAR', null);
  if (_token && Date.now() < _token.venceAt - MARGEN_MS) return _token.valor;
  if (_pidiendo) return _pidiendo;
  const c = conf();
  _pidiendo = (async () => {
    const r = await axios.post(`${c.base}/oauth/token`,
      { grant_type: 'client_credentials', client_id: c.id, client_secret: c.secret },
      { timeout: 20000, headers: { 'Content-Type': 'application/json' } });
    const valor = r.data?.access_token;
    if (!valor) throw new ErrorV2('InfoManager no devolvió el token de la API v2.', null, 'SIN_TOKEN', null);
    // 🔑 El vencimiento sale del servidor. Si mañana lo bajan a 2 minutos, esto se entera solo.
    const dura = Number(r.data?.expires_in);
    _token = { valor, venceAt: Date.now() + (Number.isFinite(dura) && dura > 0 ? dura : 900) * 1000 };
    return valor;
  })().finally(() => { _pidiendo = null; });
  return _pidiendo;
}

function comoErrorV2(e: any): ErrorV2 {
  if (e instanceof ErrorV2) return e;
  const status = e?.response?.status ?? null;
  const cuerpo = e?.response?.data?.error;
  const code = cuerpo?.code ?? null;
  const traceId = cuerpo?.traceId ?? null;
  const detalle = cuerpo?.message ?? e?.response?.data?.mensaje ?? e?.message ?? 'sin detalle';
  // El traceId va EN el mensaje: es lo primero que pide el soporte de IM y, si sólo viviera en
  // una propiedad, se perdería en cuanto el error se loguee como texto.
  return new ErrorV2(
    `InfoManager v2 ${status ?? ''} ${code ?? ''}: ${detalle}${traceId ? ` · traceId ${traceId}` : ''}`.trim(),
    status, code, traceId);
}

/**
 * Un GET a la API nueva. Pasa por el mismo pool que el resto de las lecturas de IM: la cuota es
 * de la empresa, no de cada API, y saturarla rompe la facturación (incidente del 16/09/2026).
 */
export async function getV2<T = any>(ruta: string, params?: Record<string, unknown>): Promise<T> {
  const c = conf();
  const jwt = await tokenV2();
  return lecturaLimitada(async () => {
    try {
      const r = await axios.get(`${c.base}${ruta}`, {
        params, timeout: 25000,
        headers: { Authorization: `Bearer ${jwt}`, 'X-Api-Key': c.key },
      });
      return r.data as T;
    } catch (e) { throw comoErrorV2(e); }
  });
}

/** Las variables que hay que cargar en el servidor. Las usa el diagnóstico para decir cuál falta. */
export const VARIABLES_V2 = VARIABLES;
