import { AsyncLocalStorage } from 'node:async_hooks';
/** Cache de lecturas; una respuesta vieja nunca reemplaza otra generación. */
export class LecturasCompartidas<T> {
  private generacion = 0;
  private secuencia = 0;
  private valores = new Map<string, { at: number; dato: T }>();
  private pendientes = new Map<string, { token: number; forzado: boolean; promesa: Promise<T> }>();
  constructor(private ttl = 90_000, private maximo = 40) {}
  invalidar() { this.generacion++; this.valores.clear(); this.pendientes.clear(); }
  obtener(clave: string, leer: () => Promise<T>, opciones: { actualizar?: boolean; verificar?: boolean; cachear?: boolean } = {}): Promise<T> {
    const viejo = this.valores.get(clave);
    if (!opciones.actualizar && !opciones.verificar && viejo && Date.now() - viejo.at < this.ttl) return Promise.resolve(viejo.dato);
    const previo = this.pendientes.get(clave);
    if (!opciones.verificar && previo && (!opciones.actualizar || previo.forzado)) return previo.promesa;
    const generacion = this.generacion, token = ++this.secuencia;
    const promesa = Promise.resolve().then(leer).then(dato => {
      if (generacion === this.generacion && this.pendientes.get(clave)?.token === token && opciones.cachear !== false) {
        if (this.valores.size >= this.maximo) this.valores.delete(this.valores.keys().next().value!);
        this.valores.set(clave, { at: Date.now(), dato });
      }
      return dato;
    }).finally(() => { if (this.pendientes.get(clave)?.token === token) this.pendientes.delete(clave); });
    this.pendientes.set(clave, { token, forzado: !!opciones.actualizar, promesa });
    return promesa;
  }
}

export class LecturaNoEnviada extends Error { readonly retryable = false; }
let activas = 0;
let activasDeFondo = 0;
let pausaHasta = 0;
interface EnCola { fondo: boolean; entrar: () => void }
const esperando: EnCola[] = [];
const LIMITE = 4;
/**
 * 🔴 De los 4 lugares, el trabajo de fondo puede usar UNO. Los otros tres quedan siempre para
 * quien está esperando una pantalla.
 *
 * 16/09/2026: al reiniciar el contenedor arranca el warm de 6 meses (ventas + items de cada uno,
 * 35-105 s por mes) y se comía los 4 lugares. Mientras corría, la oficina facturó 4 pedidos por
 * $1.042.470: las facturas salieron, los remitos quedaron colgados y la pantalla dijo "No se
 * pudo facturar. No se sabe qué llegó a emitirse". Un cache que se llena solo no puede costar eso.
 */
const LIMITE_FONDO = 1;
const ESPERA_MS = 5_000;
/** El de fondo no tiene a nadie del otro lado: prefiere esperar a fallar y dejar el cache frío. */
const ESPERA_FONDO_MS = 60_000;

/**
 * Marca lo que corre acá adentro como trabajo de fondo (warms y crons que llenan cache).
 *
 * Va por AsyncLocalStorage y no por parámetro porque entre el cron y `lecturaLimitada` hay media
 * docena de capas (snapshotCache → infomanager → imGetRetry) que no tienen nada que ver con esto:
 * pasarles un flag a todas sería tocar medio backend para una decisión de una sola función.
 */
const contexto = new AsyncLocalStorage<{ fondo: true }>();
export function enSegundoPlano<T>(correr: () => Promise<T>): Promise<T> {
  return contexto.run({ fondo: true }, correr);
}

const hayLugar = (fondo: boolean) => activas < LIMITE && (!fondo || activasDeFondo < LIMITE_FONDO);

/**
 * La hora de acá, redondeada al minuto SIGUIENTE: "hasta las 11:36" nunca es antes de tiempo.
 * 24/09/2026: la pantalla de facturar decía "hasta 2026-09-24T14:35:25.498Z" (UTC).
 */
const horaLocal = (ms: number) => new Date(Math.ceil(ms / 60_000) * 60_000)
  .toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'America/Argentina/Buenos_Aires' });

/**
 * Despierta al PRIMERO DE LA COLA QUE PUEDA entrar. 🪤 No al primero a secas: un warm esperando
 * lugar de fondo taparía al usuario que está detrás y sí tiene lugar.
 */
function despertar() {
  const i = esperando.findIndex(e => hayLugar(e.fondo));
  if (i >= 0) esperando.splice(i, 1)[0].entrar();
}

/** Se aplica a intentos GET, nunca a POST ni al tiempo entre reintentos. */
export async function lecturaLimitada<T>(leer: () => Promise<T>): Promise<T> {
  const fondo = contexto.getStore()?.fondo === true;
  const plazo = fondo ? ESPERA_FONDO_MS : ESPERA_MS;
  await new Promise<void>((resolve, reject) => {
    const vence = Date.now() + plazo;
    let terminado = false;
    const reloj = setTimeout(() => {
      if (terminado) return;
      terminado = true;
      const idx = esperando.indexOf(cola);
      if (idx >= 0) esperando.splice(idx, 1);
      reject(new LecturaNoEnviada('InfoManager está ocupado. No se envió esta consulta.'));
    }, plazo);
    const entrar = () => {
      if (terminado) return;
      if (Date.now() < pausaHasta) {
        terminado = true; clearTimeout(reloj);
        reject(new LecturaNoEnviada(`InfoManager pidió una pausa hasta las ${horaLocal(pausaHasta)}. No se consultó de nuevo.`)); return;
      }
      if (Date.now() >= vence) return;
      if (!hayLugar(fondo)) { esperando.push(cola); return; }
      terminado = true; clearTimeout(reloj); activas++; if (fondo) activasDeFondo++; resolve();
    };
    const cola: EnCola = { fondo, entrar };
    entrar();
  });
  try { return await leer(); }
  finally { activas--; if (fondo) activasDeFondo--; despertar(); }
}
export function pausarLecturas(ms: number) { pausaHasta = Math.max(pausaHasta, Date.now() + Math.max(0, ms)); }
