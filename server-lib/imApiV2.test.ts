import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';

/**
 * EL CLIENTE DE LA API NUEVA DE INFOMANAGER (imapi / v2).
 *
 * Mati (21/09/2026), sobre NC y ND: *"veamos a ver si ya podemos incorporar... capaz que con la
 * nueva API ya podemos"*. Se probó en vivo ese día: sí se puede.
 *
 * 🔴 NO es la misma autenticación que la API vieja y por eso tiene módulo propio:
 *   · La vieja: `POST /auth/login` con client_id+secret → un JWT que dura ~24 h.
 *   · La nueva: `POST /oauth/token` (client_credentials) → token de **15 MINUTOS**, y encima
 *     hay que mandar el header `X-Api-Key` en CADA llamada.
 *
 * 🪤 Copiar el cache de 23 h de la vieja acá serviría 401 durante 22 h 45 m. Es la trampa que
 * ya está anotada para el `im-proxy`; este cliente nace con el TTL correcto.
 */
vi.mock('axios', () => ({ default: { post: vi.fn(), get: vi.fn() } }));

const CONF = {
  IM_V2_BASE_URL: 'https://im.example.invalid/imapi',
  IM_V2_CLIENT_ID: 'cli_test',
  IM_V2_CLIENT_SECRET: 'secreto',
  IM_V2_API_KEY: 'im5k_test',
};
for (const [k, v] of Object.entries(CONF)) process.env[k] = v;

const { tokenV2, _resetV2, imV2Configurada, getV2, postV2, ErrorV2 } = await import('./imApiV2.js');

/** Simula el /oauth/token: cada llamada devuelve un token distinto para poder distinguirlos. */
let emitidos = 0;
function mockToken(expiresIn = 900) {
  vi.mocked(axios.post).mockImplementation(async (url: string) => {
    if (String(url).endsWith('/oauth/token')) {
      emitidos += 1;
      return { data: { access_token: `tok-${emitidos}`, token_type: 'Bearer', expires_in: expiresIn, scope: 'notas:write' } } as any;
    }
    throw new Error(`POST inesperado: ${url}`);
  });
}

beforeEach(() => { vi.clearAllMocks(); emitidos = 0; _resetV2(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe('el token de la API nueva', () => {
  it('🔑 se pide una sola vez y se reusa mientras esté vigente', async () => {
    mockToken();
    expect(await tokenV2()).toBe('tok-1');
    vi.advanceTimersByTime(5 * 60_000);
    expect(await tokenV2()).toBe('tok-1');
    expect(emitidos).toBe(1);
  });

  it('🔴 se renueva ANTES de los 15 minutos: con el de 23 h de la API vieja serviría 401 casi un día', async () => {
    mockToken(900);
    expect(await tokenV2()).toBe('tok-1');
    // A los 14 minutos ya tiene que haber pedido uno nuevo: no se espera al vencimiento exacto.
    vi.advanceTimersByTime(14 * 60_000);
    expect(await tokenV2()).toBe('tok-2');
  });

  it('respeta el expires_in que mande el servidor, no un número fijo nuestro', async () => {
    mockToken(120);                 // si mañana lo bajan a 2 minutos
    expect(await tokenV2()).toBe('tok-1');
    vi.advanceTimersByTime(90_000);
    expect(await tokenV2()).toBe('tok-2');
  });

  it('🪤 dos llamadas simultáneas piden UN solo token, no dos', async () => {
    mockToken();
    const [a, b] = await Promise.all([tokenV2(), tokenV2()]);
    expect([a, b]).toEqual(['tok-1', 'tok-1']);
    expect(emitidos).toBe(1);
  });
});

describe('las llamadas', () => {
  it('🔑 van con el Bearer Y con la X-Api-Key: sin la key todo v2 da 401', async () => {
    mockToken();
    vi.mocked(axios.get).mockResolvedValue({ data: { results: [] } } as any);
    await getV2('/api/v2/localidades', { page: 1 });
    const [url, cfg]: any = vi.mocked(axios.get).mock.calls[0];
    expect(url).toBe(`${CONF.IM_V2_BASE_URL}/api/v2/localidades`);
    expect(cfg.headers.Authorization).toBe('Bearer tok-1');
    expect(cfg.headers['X-Api-Key']).toBe(CONF.IM_V2_API_KEY);
    expect(cfg.params).toEqual({ page: 1 });
  });

  it('🔑 el error nuevo trae code y traceId, y eso es lo que pide el soporte', async () => {
    mockToken();
    vi.mocked(axios.get).mockRejectedValue({
      response: { status: 502, data: { error: { code: 'UPSTREAM_ERROR', message: 'No se pudo autenticar contra el sistema de gestión', traceId: 'abc-123' } } },
    });
    const e = await getV2('/api/v2/localidades').catch((x: any) => x);
    expect(e).toBeInstanceOf(ErrorV2);
    expect(e.status).toBe(502);
    expect(e.code).toBe('UPSTREAM_ERROR');
    expect(e.traceId).toBe('abc-123');
    expect(String(e.message)).toContain('abc-123');
  });
});

describe('sin configurar', () => {
  it('🔴 no rompe la app: se apaga sola y lo dice', async () => {
    const guardado = process.env.IM_V2_API_KEY;
    delete process.env.IM_V2_API_KEY;
    _resetV2();
    expect(imV2Configurada()).toBe(false);
    await expect(tokenV2()).rejects.toThrow(/IM_V2_API_KEY/);
    process.env.IM_V2_API_KEY = guardado;
    _resetV2();
    expect(imV2Configurada()).toBe(true);
  });
});

/**
 * EL POST — lo único irreversible de este cliente.
 *
 * `Idempotency-Key` es lo que impide que un corte de red emita DOS notas por la misma
 * corrección: si el reintento llega con la misma clave, InfoManager devuelve la nota que ya
 * creó en vez de crear otra. La API vieja no lo tiene, y por eso el emisor de la app nunca
 * reintenta una emisión sin respuesta.
 */
describe('el POST', () => {
  it('🔴 va con Idempotency-Key, que es lo que evita emitir dos veces por un corte', async () => {
    mockToken();
    vi.mocked(axios.post).mockImplementation(async (url: string) => {
      if (String(url).endsWith('/oauth/token')) { emitidos += 1; return { data: { access_token: `tok-${emitidos}`, expires_in: 900 } } as any; }
      return { data: { id: 99 } } as any;
    });
    await postV2('/api/v2/notas-credito', { fecha: '2026-09-21' }, 'clave-unica-123');
    const llamada = vi.mocked(axios.post).mock.calls.find(c => String(c[0]).includes('/notas-credito'))!;
    const cfg: any = llamada[2];
    expect(cfg.headers['Idempotency-Key']).toBe('clave-unica-123');
    expect(cfg.headers['X-Api-Key']).toBe(CONF.IM_V2_API_KEY);
    expect(cfg.headers.Authorization).toBe('Bearer tok-1');
    expect(llamada[1]).toEqual({ fecha: '2026-09-21' });
  });

  it('🔴 sin clave de idempotencia NO se envía: una nota duplicada es plata real', async () => {
    mockToken();
    await expect(postV2('/api/v2/notas-credito', {}, '')).rejects.toThrow(/idempotencia/i);
    expect(vi.mocked(axios.post).mock.calls.filter(c => String(c[0]).includes('/notas-credito'))).toHaveLength(0);
  });

  it('🪤 el POST NO pasa por el pool de lecturas: una emisión no espera detrás de una pantalla', async () => {
    // El pool acota los GET para no fundir la cuota. Encolar ahí una emisión significaría que
    // una nota puede fallar por "InfoManager está ocupado" con la factura ya corregida a medias.
    mockToken();
    vi.mocked(axios.post).mockImplementation(async (url: string) => {
      if (String(url).endsWith('/oauth/token')) { emitidos += 1; return { data: { access_token: `tok-${emitidos}`, expires_in: 900 } } as any; }
      return { data: { id: 7 } } as any;
    });
    const r = await postV2('/api/v2/notas-credito', {}, 'k1');
    expect(r).toEqual({ id: 7 });
  });
});

/**
 * 🔴 21/09/2026, primera emisión de prueba. El emisor devolvió sólo *"InfoManager v2 400:
 * Ocurrió un error al grabar información"* y hubo que repetir la llamada a mano para ver el
 * cuerpo crudo. Ahí estaba la causa, en un campo que este cliente descartaba:
 *
 *   "detalles": "Validaciones: \n• El usuario 'api_servicio' no tiene un depósito
 *                predeterminado asignado. Ingrese un cod_deposito válido."
 *
 * Un rechazo que no dice qué rechazó obliga a adivinar sobre lo único irreversible del circuito.
 * InfoManager pone el motivo en `detalles` (v1) o en `error.message` (v2): van los dos.
 */
describe('el mensaje de error', () => {
  it('🔴 conserva `detalles`, que es donde InfoManager pone la validación que falló', async () => {
    mockToken();
    vi.mocked(axios.get).mockRejectedValue({
      response: { status: 400, data: {
        mensaje: 'Ocurrió un error al grabar información.',
        detalles: "Validaciones: \n• El usuario 'api_servicio' no tiene un depósito predeterminado asignado.",
      } },
    });
    const e: any = await getV2('/api/v2/notas-credito').catch((x: any) => x);
    expect(e.message).toContain('depósito predeterminado');
  });

  it('también sirve cuando el detalle viene como lista de campos', async () => {
    mockToken();
    vi.mocked(axios.get).mockRejectedValue({
      response: { status: 400, data: {
        mensaje: 'Parámetros inválidos.',
        errores: [{ campo: 'fechaDesde', mensajes: ['The fechaDesde field is required.'] }],
      } },
    });
    const e: any = await getV2('/api/v2/x').catch((x: any) => x);
    expect(e.message).toContain('fechaDesde');
  });
});
