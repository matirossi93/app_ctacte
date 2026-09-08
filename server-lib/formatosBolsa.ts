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

/** Días de historia que se miran. Un mes da volumen suficiente sin irse de tiempo. */
const DIAS_HISTORIA = 30;
/** Cada cuánto se recalcula. Los formatos no cambian de un día para el otro. */
const TTL_MS = 12 * 60 * 60 * 1000;
/** Mínimo de renglones de un artículo para animarse a decir cuál es su bolsa. */
const MIN_RENGLONES = 20;
/** Y mínimo de veces que tiene que repetirse la cantidad candidata. */
const MIN_REPETICIONES = 3;

let _formatos: Map<number, number> = new Map();
let _at = 0;
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
  const [ventas, cat] = await Promise.all([fetchVentas(desde, hasta), fetchArticulosCatalogo()]);
  const pr = ventas.filter((v: any) =>
    String(v.tipo_comprobante ?? '').trim() === 'PR' &&
    String(v.anulada ?? '').trim().toUpperCase() !== 'S');
  const ids = new Set(pr.map((p: any) => String(p.id)));
  const dias = [...new Set(pr.map((p: any) => String(p.fecha ?? '').slice(0, 10)).filter(Boolean))].sort();

  const porArticulo = new Map<number, number[]>();
  // De a cuatro días, igual que el resto del panel: no se golpea a IM con 25 requests juntas.
  for (let i = 0; i < dias.length; i += 4) {
    const tandas = await Promise.all(dias.slice(i, i + 4).map(f => fetchVentasItems(f, f).catch(() => [] as any[])));
    for (const items of tandas) {
      for (const it of items) {
        if (!ids.has(String((it as any).id_comprobante))) continue;
        const cod = Number((it as any).cod_articulo);
        const art = cat.get(cod);
        if (!art || !esKilo(art.unidad_de_medida)) continue;      // sólo granel
        const q = Number((it as any).cantidad);
        if (!(q > 0)) continue;
        if (!porArticulo.has(cod)) porArticulo.set(cod, []);
        porArticulo.get(cod)!.push(q);
      }
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
export function formatosDeBolsa(): Map<number, number> {
  if (!_calculando && Date.now() - _at > TTL_MS) {
    _calculando = calcular()
      .then((m) => { _formatos = m; _at = Date.now(); })
      .catch((e: any) => { console.warn('[formatosBolsa] no pude calcular los formatos:', e?.message); })
      .finally(() => { _calculando = null; });
  }
  return _formatos;
}

/** Para los tests y para forzar un recálculo después de tocar el catálogo. */
export function _resetFormatos(valores?: Map<number, number>) {
  _formatos = valores ?? new Map();
  _at = valores ? Date.now() : 0;
  _calculando = null;
}
