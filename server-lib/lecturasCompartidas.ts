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
let pausaHasta = 0;
const esperando: Array<() => void> = [];
const LIMITE = 4;
/** Se aplica a intentos GET, nunca a POST ni al tiempo entre reintentos. */
export async function lecturaLimitada<T>(leer: () => Promise<T>): Promise<T> {
  await new Promise<void>((resolve, reject) => {
    const vence = Date.now() + 5_000;
    let terminado = false;
    const reloj = setTimeout(() => {
      if (terminado) return;
      terminado = true;
      const idx = esperando.indexOf(entrar);
      if (idx >= 0) esperando.splice(idx, 1);
      reject(new LecturaNoEnviada('InfoManager está ocupado. No se envió esta consulta.'));
    }, 5_000);
    const entrar = () => {
      if (terminado) return;
      if (Date.now() < pausaHasta) {
        terminado = true; clearTimeout(reloj);
        reject(new LecturaNoEnviada(`InfoManager pidió una pausa hasta ${new Date(pausaHasta).toISOString()}. No se consultó de nuevo.`)); return;
      }
      if (Date.now() >= vence) return;
      if (activas >= LIMITE) { esperando.push(entrar); return; }
      terminado = true; clearTimeout(reloj); activas++; resolve();
    };
    entrar();
  });
  try { return await leer(); }
  finally { activas--; esperando.shift()?.(); }
}
export function pausarLecturas(ms: number) { pausaHasta = Math.max(pausaHasta, Date.now() + Math.max(0, ms)); }
