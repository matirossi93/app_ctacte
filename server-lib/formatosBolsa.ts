/**
 * El formato de bolsa de cada producto a GRANEL, deducido de lo que se pide todos los días.
 *
 * 🔑 Por qué hace falta deducirlo: InfoManager **no lo tiene**. Un producto a granel sale del
 * catálogo con `unidad_de_medida: Kilos` y `equivalencia_um: 1`, así que no hay contra qué
 * comparar la cantidad de un renglón. Pero la bolsa existe en la vida real: Mati confirmó el
 * 08/09/2026 que la de alpiste es de **30 kg**, y los pedidos lo muestran solos —
 * `5×19 · 10×8 · 25×6 · 30×23 · 60 · 90 · 150 · 210`: el 30 es la bolsa y 60/90/150/210 son
 * varias bolsas.
 *
 * Así que el formato se saca de los datos: **la cantidad de 20 kg o más que más se repite**,
 * pidiendo al menos 3 repeticiones para no inventar un formato con dos ventas sueltas.
 * Verificado contra 30 días de IM (10/08→08/09/2026): salen 33 productos con formato, y da lo
 * que la oficina sabe de memoria — LENTEJA 25, AVENA INSTANTANEA 20, MEZCLA FINA 30,
 * PISINGALLO 30, GARBANZO 30.
 *
 * 🪤 Cuesta ~30 s calcularlo (25 días de renglones contra IM), así que NO se calcula dentro de
 * la request: se devuelve lo que haya en el cache —aunque esté vencido— y el refresco corre
 * aparte. Mientras no haya nada, el control de granel simplemente no marca. Un aviso que llega
 * tarde no molesta a nadie; una pantalla que tarda 30 s en abrir, sí.
 */
import { fetchVentas, fetchVentasItems, fetchArticulosCatalogo, fechaArgentina } from './infomanager.js';
import { esKilo } from './fraccionado.js';
import { sb, TENANT_ID, hasSupabase } from './supabase.js';

/** Días de historia que se miran. Un mes da volumen suficiente sin irse de tiempo. */
const DIAS_HISTORIA = 30;
/** Cada cuánto se recalcula. Los formatos no cambian de un día para el otro. */
const TTL_MS = 12 * 60 * 60 * 1000;
/** Mínimo de renglones de un artículo para animarse a decir cuál es su bolsa. */
const MIN_RENGLONES = 20;
/** Y mínimo de veces que tiene que repetirse la cantidad candidata. */
const MIN_REPETICIONES = 3;

/**
 * 🔑 LOS QUE SABEMOS DE MEMORIA, que mandan sobre lo deducido.
 *
 * La deducción necesita 20 renglones del artículo en 30 días; un producto que se vende poco no
 * llega nunca a esa muestra y termina fraccionado en paquetes de 10 kg. Mati (16/09/2026):
 * *"está mal el fraccionado en el girasol pelado, la bolsa viene por 25 kg y en la app se está
 * fraccionando en cantidades más chicas"*.
 *
 * 🪤 Esto va acá y no en InfoManager porque IM no tiene el dato: un granel sale con
 * `unidad_de_medida: Kilos` y `equivalencia_um: 1`. Si la lista crece, conviene una pantalla para
 * cargarlos; con siete, una constante a la vista es más fácil de auditar que una tabla.
 *
 * 🪤 Los datos de venta NO sirven para verificarlos, y por eso se cargan a mano: lo más pedido de
 * alpiste es 30 kg y la bolsa es de 25 porque *"veníamos facturando esos kg extra fraccionados"*
 * (Mati, 16/09/2026) — o sea que el 30 es una bolsa más 5 sueltos, no el formato.
 *
 * 🔄 18/09/2026: YA NO SE TOCA ESTA LISTA. Mati: *"van cambiando los kilajes de las bolsas, no
 * son siempre iguales"*, y un formato escrito en el código envejecía en silencio —el 16/09 acá
 * decía que la AVENA INSTANTANEA venía por 30 y venía por 20—. Ahora el kilaje se carga desde la
 * pantalla de fraccionado y vive en la tabla `formatos_bolsa` (migración 048), que sembró estos
 * mismos ocho valores.
 *
 * Queda como RESPALDO y nada más: si la tabla no responde —Supabase caído, o un despliegue que
 * llegó antes que la migración— es mejor tener ocho formatos viejos que ninguno, porque sin
 * ninguno medio listado sale a fraccionarse a mano. Los cambios van a la tabla, no acá.
 */
export const FORMATOS_CONOCIDOS = new Map<number, number>([
  [459, 25],   // GIRASOL PELADO
  [400, 25],   // ALPISTE
  [402, 25],   // MIJO
  [401, 40],   // LINO
  [723, 30],   // POROTO ALUBIA
  [703, 30],   // AVENA ARROLLADA
  [704, 20],   // AVENA INSTANTANEA
  [403, 40],   // SORGO
]);

/**
 * Los cargados a mano. TTL corto a propósito: se corrigen desde la pantalla y el que acaba de
 * escribir 40 tiene que ver el listado rearmado, no el de hace media hora.
 */
const MANUALES_TTL_MS = 30_000;
let _manuales: Map<number, number> | null = null;
let _manualesAt = 0;
let _leyendoManuales: Promise<Map<number, number> | null> | null = null;

/** Lo que la oficina cargó a mano. `null` = no se pudo leer (distinto de "no hay ninguno"). */
async function leerManuales(): Promise<Map<number, number> | null> {
  if (!hasSupabase()) return null;
  const { data, error } = await sb()
    .from('formatos_bolsa').select('cod_articulo, kg').eq('tenant_id', TENANT_ID);
  if (error) {
    console.warn('[formatosBolsa] no pude leer los kilajes cargados:', error.message);
    return null;
  }
  const m = new Map<number, number>();
  for (const f of data ?? []) {
    const cod = Number((f as any).cod_articulo);
    const kg = Number((f as any).kg);
    if (Number.isFinite(cod) && kg > 0) m.set(cod, kg);
  }
  return m;
}

/** Vuelve a leer la tabla en la próxima consulta. La llama el endpoint que guarda un kilaje. */
export function invalidarFormatosManuales(): void { _manuales = null; _manualesAt = 0; }

async function manualesVigentes(): Promise<Map<number, number> | null> {
  if (_manuales && Date.now() - _manualesAt < MANUALES_TTL_MS) return _manuales;
  _leyendoManuales ??= leerManuales()
    .then(m => { if (m) { _manuales = m; _manualesAt = Date.now(); } return m ?? _manuales; })
    .catch(e => { console.warn('[formatosBolsa] kilajes cargados:', e?.message); return _manuales; })
    .finally(() => { _leyendoManuales = null; });
  return _leyendoManuales;
}

let _formatos: Map<number, number> = new Map();
let _at = 0;
let _ultimoIntento = 0;
let _calculando: Promise<void> | null = null;

/** La cantidad de 20 kg o más que más se repite. `null` si no hay una clara. */
export function formatoDominante(cantidades: number[]): number | null {
  if (cantidades.length < MIN_RENGLONES) return null;
  const cuenta = new Map<number, number>();
  for (const q of cantidades) if (q >= 20) cuenta.set(q, (cuenta.get(q) ?? 0) + 1);
  if (!cuenta.size) return null;
  const [valor, veces] = [...cuenta.entries()].sort((a, b) => b[1] - a[1])[0];
  return veces >= MIN_REPETICIONES ? valor : null;
}

async function calcular(): Promise<Map<number, number>> {
  const hasta = fechaArgentina();
  const desde = fechaArgentina(Date.now() - (DIAS_HISTORIA - 1) * 864e5);
  // Un solo GET de este trabajo en vuelo: deja capacidad del pool para la oficina.
  const ventas = await fetchVentas(desde, hasta);
  const cat = await fetchArticulosCatalogo();
  const pr = ventas.filter((v: any) =>
    String(v.tipo_comprobante ?? '').trim() === 'PR' &&
    String(v.anulada ?? '').trim().toUpperCase() !== 'S');
  const ids = new Set(pr.map((p: any) => String(p.id)));
  const dias = [...new Set(pr.map((p: any) => String(p.fecha ?? '').slice(0, 10)).filter(Boolean))].sort();

  const porArticulo = new Map<number, number[]>();
  // El refresco ya corre una sola vez por proceso (_calculando). Serializar sus días impide
  // que ocupe los cuatro slots GET y haga vencer la cola de una consulta interactiva.
  for (const dia of dias) {
    const items = await fetchVentasItems(dia, dia);
    for (const it of items) {
      if (!ids.has(String((it as any).id_comprobante))) continue;
      const cod = Number((it as any).cod_articulo);
      const art = cat.get(cod);
      if (!art || !esKilo(art.unidad_de_medida)) continue;
      const q = Number((it as any).cantidad);
      if (!(q > 0)) continue;
      if (!porArticulo.has(cod)) porArticulo.set(cod, []);
      porArticulo.get(cod)!.push(q);
    }
  }

  const formatos = new Map<number, number>();
  for (const [cod, cants] of porArticulo) {
    const f = formatoDominante(cants);
    if (f) formatos.set(cod, f);
  }
  return formatos;
}

/**
 * Los formatos que haya, sin esperar.
 *
 * Devuelve el mapa cacheado (vacío la primera vez) y dispara el recálculo en segundo plano si
 * está vencido. Un formato viejo sigue sirviendo: las bolsas no cambian de tamaño.
 */
export async function formatosDeBolsa(): Promise<Map<number, number>> {
  if (!_calculando && Date.now() - _at > TTL_MS && Date.now() - _ultimoIntento > 60_000) {
    _ultimoIntento = Date.now();
    _calculando = calcular()
      .then((m) => { _formatos = m; _at = Date.now(); })
      .catch((e: any) => { console.warn('[formatosBolsa] no pude calcular los formatos:', e?.message); })
      .finally(() => { _calculando = null; });
  }
  /**
   * 🔑 LA ESCALERA, de menos a más confiable —cada uno pisa al anterior:
   *
   *   deducido de los pedidos  <  respaldo del código  <  cargado a mano
   *
   * La muestra de 30 días puede estar incompleta o mentir (lo más pedido de alpiste es 30 y la
   * bolsa es de 25). El que abrió la bolsa y escribió el número en la pantalla, no.
   *
   * 🪤 El respaldo del código entra SÓLO si la tabla no se pudo leer: si se leyó y el
   * artículo no está, es porque alguien lo borró a propósito, y volver a meter el valor viejo
   * haría que borrarlo no sirva de nada.
   */
  const manuales = await manualesVigentes();
  return manuales
    ? new Map([..._formatos, ...manuales])
    : new Map([..._formatos, ...FORMATOS_CONOCIDOS]);
}

/** Para los tests y para forzar un recálculo después de tocar el catálogo. */
export function _resetFormatos(valores?: Map<number, number>) {
  _formatos = valores ?? new Map();
  _at = valores ? Date.now() : 0;
  _ultimoIntento = 0;
  _calculando = null;
  invalidarFormatosManuales();
}
