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
  /**
   * 🔴 EL MOTIVO REAL VIVE EN VARIOS LADOS Y SE JUNTAN TODOS. El 21/09/2026 la primera
   * emisión de prueba devolvió sólo "Ocurrió un error al grabar información" y hubo que repetir
   * la llamada a mano para ver el cuerpo: la causa estaba en `detalles` —"el usuario
   * 'api_servicio' no tiene un depósito predeterminado asignado"— que este parseo descartaba.
   * Un rechazo que no dice qué rechazó obliga a adivinar sobre lo único irreversible que hay.
   */
  const d = e?.response?.data ?? {};
  const listado = Array.isArray(d?.errores)
    ? d.errores.map((x: any) => `${x?.campo ?? ''}: ${(x?.mensajes ?? []).join(' ')}`.trim()).join(' · ')
    : '';
  const detalle = [cuerpo?.message, d?.mensaje, d?.detalles, listado]
    .map(x => String(x ?? '').trim()).filter(Boolean).join(' — ') || e?.message || 'sin detalle';
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

/**
 * Lo que InfoManager acepta como `Idempotency-Key`, dicho por él mismo el 22/09/2026:
 * *"Idempotency-Key inválida: usar 8 a 128 caracteres [A-Za-z0-9_-]"*.
 */
const FORMATO_IDEMPOTENCIA = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * La clave de idempotencia de una emisión, armada con partes que identifican LA OPERACIÓN.
 *
 * 🔴 TIENE QUE SER ESTABLE ENTRE REINTENTOS: es lo único que impide que un corte de red emita
 * dos notas por la misma corrección. Por eso todo acá es determinístico —se sanea y se rellena
 * siempre igual— y por eso no hay ningún `randomUUID()` de respaldo: una clave nueva por intento
 * es exactamente lo contrario de lo que se necesita.
 *
 * 🪤 Los dos puntos NO entran, y era el separador que usaba el emisor de notas: la primera NC
 * que salió por este camino murió con `IDEMPOTENCY_KEY_INVALID` sin llegar a InfoManager.
 */
export function claveIdempotente(...partes: Array<string | number>): string {
  if (!partes.length) throw new Error('No hay con qué armar la clave de idempotencia de la emisión.');
  const saneadas = partes.map(p => String(p ?? '').replace(/[^A-Za-z0-9_-]/g, '-'));
  /**
   * 🪤 Una parte vacía NO se saltea: saltearla hace que `('op', 1)` y `('op-1', '')` den la misma
   * clave, y dos emisiones distintas con la misma clave significa que la segunda nunca sale —
   * InfoManager devuelve la primera. Si una parte vino vacía, el que llama tiene un problema y
   * hay que enterarse antes de emitir, no después.
   */
  if (saneadas.some(p => !p.replace(/-/g, ''))) {
    throw new Error('No hay con qué armar la clave de idempotencia de la emisión.');
  }
  const limpia = saneadas.join('-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  if (!limpia) throw new Error('No hay con qué armar la clave de idempotencia de la emisión.');
  /**
   * 🪤 Corta es tan inválida como larga, y el relleno NO puede ser cualquiera: rellenar con `0`
   * haría que `op-7` + `0` y `op-70` + `0` terminen en la misma clave, y dos operaciones
   * distintas con la misma clave significa que la segunda nota no se emite nunca.
   *
   * El guión sí sirve: arriba se recortan los de los extremos, así que **ninguna clave natural
   * termina en guión** y el relleno queda distinguible de lo que se armó de verdad.
   */
  return limpia.length < 8 ? limpia.padEnd(8, '-') : limpia.slice(0, 128);
}

/**
 * Un POST a la API nueva. 🔴 ES LO IRREVERSIBLE: emite comprobantes fiscales.
 *
 * 🔑 `Idempotency-Key` es obligatoria acá y no tiene default: es lo único que impide que un
 * corte de red emita DOS notas por la misma corrección. Si el reintento llega con la misma
 * clave, InfoManager devuelve la nota que ya creó en vez de crear otra. La API vieja no lo
 * tiene, y por eso el emisor v1 nunca reintenta una emisión que se quedó sin respuesta.
 *
 * 🪤 NO pasa por `lecturaLimitada`. Ese pool acota los GET para no fundir la cuota, pero
 * encolar ahí una emisión significaría que una nota puede fallar con "InfoManager está ocupado"
 * cuando la corrección ya arrancó. Una emisión espera lo que haga falta; una pantalla no.
 */
export async function postV2<T = any>(ruta: string, cuerpo: unknown, idempotencyKey: string): Promise<T> {
  if (!String(idempotencyKey ?? '').trim()) {
    throw new ErrorV2('Falta la clave de idempotencia: sin ella una emisión cortada puede duplicar la nota. No se envió nada.', null, 'SIN_IDEMPOTENCIA', null);
  }
  // 🪤 El formato lo valida InfoManager y se verifica ACÁ primero: mandarla mal gasta el viaje y
  // vuelve como `IDEMPOTENCY_KEY_INVALID`, un error que no dice nada de la corrección que se
  // estaba haciendo. Pasó el 22/09/2026 con la NC de ARRIETA: la clave llevaba `:`.
  if (!FORMATO_IDEMPOTENCIA.test(String(idempotencyKey).trim())) {
    throw new ErrorV2(
      `La clave de idempotencia "${idempotencyKey}" no tiene el formato que acepta InfoManager (8 a 128 caracteres, sólo letras, números, guión y guión bajo). No se envió nada.`,
      null, 'IDEMPOTENCIA_MAL_FORMADA', null);
  }
  const c = conf();
  const jwt = await tokenV2();
  try {
    const r = await axios.post(`${c.base}${ruta}`, cuerpo, {
      timeout: 40000,
      headers: {
        Authorization: `Bearer ${jwt}`,
        'X-Api-Key': c.key,
        'Content-Type': 'application/json',
        'Idempotency-Key': String(idempotencyKey).trim(),
      },
    });
    return r.data as T;
  } catch (e) { throw comoErrorV2(e); }
}

/** Las variables que hay que cargar en el servidor. Las usa el diagnóstico para decir cuál falta. */
export const VARIABLES_V2 = VARIABLES;
