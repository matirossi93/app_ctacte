/**
 * Control de listas de precios en los pedidos de vendedor.
 *
 * EL PROBLEMA (26/08/2026): los vendedores eligen la lista 1/2/3/4 producto por producto
 * según la cantidad. Se equivocan seguido y facturación tiene que controlar renglón por
 * renglón antes de facturar. Este módulo calcula, para cada renglón, a qué lista tenía
 * derecho de verdad, y avisa cuando no coincide con la que eligió el vendedor.
 *
 * LAS REGLAS (planilla "CONDICIONES LISTA SEMILLERO" + audio de Mati del 26/08):
 *
 * 1. Cada producto o línea tiene su propia condición por lista (ver tabla listas_reglas).
 * 2. PROMO GENERAL: si el pedido junta 10 bultos SURTIDOS, se habilita la Lista 2 para
 *    TODO el pedido. Ojo: es a nivel pedido, no de renglón.
 * 3. Las promos se SUPERPONEN: encima de la L2 general, un producto puede subir a L3/L4
 *    si cumple su condición propia. En el mismo pedido conviven listas distintas.
 * 4. Un artículo a granel de 20 kg o más cuenta como UN bulto para llegar a los 10
 *    (uno solo: 60 kg siguen siendo 1 bulto, no 3 — confirmado por Mati).
 *
 * Lista más alta = mejor precio para el cliente (L4 es la más barata).
 *
 * ALCANCE: casa central. Lo que no matchea ninguna regla no se valida — son artículos de
 * las sucursales minoristas y los espejos fraccionados "X KG". El silencio es deliberado:
 * un validador que grita en falso lo apagan a la semana.
 */

/** Un granel de 20 kg o más cuenta como 1 bulto para la promo general. */
export const KG_PARA_CONTAR_BULTO = 20;
/** Bultos surtidos que habilitan la Lista 2 para todo el pedido. */
export const BULTOS_PROMO_GENERAL = 10;
/** Lista 1: la más cara. Siempre se puede vender ahí, así que es el piso. */
export const LISTA_BASE = 12;

export interface ReglaLista {
  nombre: string;
  match_tipo: 'subrubro' | 'articulo';
  match_valor: string;
  cod_lista: number;
  condicion: 'libre' | 'promo_general' | 'min' | 'max' | 'excluido';
  umbral: number | null;
  unidad: 'bulto' | 'kg' | null;
  ambito: 'articulo' | 'linea' | 'pedido' | null;
}

/** Lo que necesitamos saber de un artículo para evaluarlo. */
export interface ArticuloInfo {
  cod_articulo: number;
  descripcion: string;
  subrubro: string;
  es_bulto: boolean;
  /** Kilos que trae el bulto. 0 si se vende a granel. */
  kg_por_bulto: number;
  /**
   * El gemelo fraccionado "X KG" de un producto que también viene en bolsa (código 10xxx
   * en IM: "CONEJO x KG - CONECAR" al lado de "CONEJO X 25 KG - CONECAR"). Es venta
   * minorista al público, así que queda fuera del control salvo que Mati le haya puesto
   * una regla por código propio — hay tres en la planilla (avena y trigo forrajero, Mani King).
   */
  es_fraccionado: boolean;
}

export interface RenglonPedido {
  cod_articulo: number;
  cantidad: number;
  /** La que eligió el vendedor. */
  cod_lista: number;
  /** Descuento porcentual que puso el vendedor en este renglón (0 a 100). */
  descuento?: number;
}

/**
 * Cuánto descuento se puede hacer sobre un renglón. Reglas de Mati del 27/08:
 *   · CEREALES PARA DESAYUNO — 25% desde 1 unidad, 30% desde 5, 35% desde 10, 40% desde 30,
 *     contando el SURTIDO de la línea, y únicamente si el renglón va en Lista 1.
 *   · LINEA FLECKY y LINEA GRAN CAMPEON — 2%, sólo si el renglón ya está en su mejor lista,
 *     y sólo con pago contado (no lo sabe el sistema: se avisa).
 *   · El resto de los artículos NO tiene descuentos habilitados.
 * Los porcentajes son TOPES: poner menos está bien, pasarse no.
 */
export interface ReglaDescuento {
  nombre: string;
  match_tipo: 'subrubro' | 'articulo';
  match_valor: string;
  /** Desde qué cantidad aplica este tope. */
  desde_cantidad: number;
  /** 'linea' = suma todos los renglones de la línea; 'articulo' = sólo este renglón. */
  ambito: 'articulo' | 'linea';
  porcentaje_max: number;
  /** Si está, el descuento SOLO vale en esa lista (los cereales, únicamente L1). */
  requiere_lista: number | null;
  /** Si es true, sólo vale cuando el renglón ya está en la mejor lista a la que llega. */
  requiere_mejor_lista: boolean;
  /** Recordatorio para el vendedor cuando usa el descuento (ej: "tiene que ser contado"). */
  aviso: string | null;
}

export type Severidad = 'ok' | 'margen' | 'cliente' | 'sin_regla';

export interface AvisoRenglon {
  /**
   * Posicion del renglon en el pedido. Existe porque el mismo articulo puede ir en DOS
   * renglones (distinta lista, distinto descuento) y entonces cod_articulo ya no alcanza
   * para saber de cual de los dos habla el aviso.
   */
  idx: number;
  cod_articulo: number;
  lista_elegida: number;
  lista_sugerida: number | null;
  severidad: Severidad;
  /** null cuando está todo bien. */
  mensaje: string | null;
  /** Descuento que puso el vendedor. */
  descuento: number;
  /** Tope permitido para este renglón según las reglas. 0 = no tiene descuentos habilitados. */
  descuento_max: number;
  /** Se pasó del tope: qué está mal y cuánto puede. null si está bien. */
  mensaje_descuento: string | null;
  /** Condición que el sistema no puede verificar solo (ej: que el pago sea contado). */
  nota_descuento: string | null;
}

export interface ResultadoPedido {
  /** Bultos totales del pedido (incluye los granel que llegan a 20 kg). */
  bultos: number;
  promo_general: boolean;
  avisos: AvisoRenglon[];
}

const NOMBRE_LISTA: Record<number, string> = { 9: 'Minorista', 11: 'Sucursales', 12: 'L1', 13: 'L2', 14: 'L3', 15: 'L4' };
export const nombreLista = (cod: number) => NOMBRE_LISTA[cod] ?? `lista ${cod}`;

/**
 * ¿El artículo se vende por bulto o por kilo?
 *
 * Ninguno de los dos campos de IM sirve solo: `unidad_de_medida` está vacío en el 72% del
 * catálogo (y donde está cargado tiene errores gruesos — hay un shampoo de 250cc marcado
 * como "Bolsas"), y `equivalencia_um` está en 0 en el 57%. Así que combinamos los tres,
 * en orden de confiabilidad, arrancando por el criterio que dio Mati: si la descripción
 * trae la multiplicación con los kilos ("GRAN CAMPEON ROJO X 21 KILOS"), es bulto.
 */
/** "X 21 KG", "x 25 Kg", "X20KG" — bolsa cerrada, y el número son los kilos que trae. */
const RE_BULTO_KG = /X\s*(\d+(?:[.,]\d+)?)\s*(?:KG|KILOS?|K)\b/i;
/** "160gr x 30u", "4KG x 2u" — caja o pack cerrado; el número son unidades, no kilos. */
const RE_BULTO_UD = /X\s*(\d+(?:[.,]\d+)?)\s*(?:U|UD|UDS|UNID)\b/i;
/** "15X80 GR" — fardo de 15 sobres de 80 gr. El número que importa va ANTES de la X. */
const RE_BULTO_PACK = /(\d+)\s*X\s*\d+(?:[.,]\d+)?\s*(?:GR|G|CC|ML)\b/i;
/** "X 250 CC", "X 20 ML" — es el envase de UNA unidad de consumo, no un bulto. */
const RE_ENVASE = /X\s*\d+(?:[.,]\d+)?\s*(?:CC|ML|GR|G)\b/i;
/** "CONEJO x KG - CONECAR" — "X KG" SIN número es el gemelo fraccionado, venta minorista. */
const RE_FRACCIONADO = /X\s*(?:KG|KILOS?)\s*(?:-|$)/i;

export function clasificarArticulo(raw: {
  cod_articulo: number; descripcion?: string | null; subrubro?: string | null;
  unidad_de_medida?: string | null; equivalencia_um?: number | string | null;
}): ArticuloInfo {
  const descripcion = String(raw.descripcion ?? '').trim();
  const eq = Number(raw.equivalencia_um ?? 0) || 0;
  const um = String(raw.unidad_de_medida ?? '').trim().toLowerCase();
  const base = {
    cod_articulo: raw.cod_articulo, descripcion, subrubro: String(raw.subrubro ?? '').trim(),
    es_fraccionado: RE_FRACCIONADO.test(descripcion) && !RE_BULTO_KG.test(descripcion),
  };
  const bulto = (kg: number) => ({ ...base, es_bulto: true, kg_por_bulto: kg });

  // 1. La descripción manda: "X 21 KG" = bolsa de 21 kilos. Es el criterio que dio Mati.
  const mKg = RE_BULTO_KG.exec(descripcion);
  if (mKg) return bulto(Number(String(mKg[1]).replace(',', '.')));
  // 2. Caja o pack cerrado: es bulto, pero el número son unidades — los kilos salen de eq.
  if (RE_BULTO_UD.test(descripcion) || RE_BULTO_PACK.test(descripcion)) return bulto(eq >= 2 ? eq : 0);
  // 3. 🪤 Envase de consumo ("X 250 CC"): NO es bulto, por más que IM diga otra cosa. Hay
  //    shampoos y antiparasitarios cargados con unidad_de_medida "Bolsas" en el catálogo.
  if (RE_ENVASE.test(descripcion)) return { ...base, es_bulto: false, kg_por_bulto: 0 };
  // 4. Sin presentación en el nombre: una equivalencia de 2 o más ya es un bulto.
  if (eq >= 2) return bulto(eq);
  // 5. Último recurso, la unidad de medida cargada a mano.
  if (/bols|bulto|fardo|caja/.test(um)) return bulto(eq > 0 ? eq : 0);
  return { ...base, es_bulto: false, kg_por_bulto: 0 };
}

/** Cuántos bultos y cuántos kilos representa un renglón. */
function medirRenglon(r: RenglonPedido, art: ArticuloInfo | undefined) {
  if (art?.es_bulto) {
    return { bultos: r.cantidad, kilos: art.kg_por_bulto > 0 ? r.cantidad * art.kg_por_bulto : 0 };
  }
  // Granel: la cantidad ya viene en kilos. 20 kg o más suman UN bulto (no acumula).
  return { bultos: r.cantidad >= KG_PARA_CONTAR_BULTO ? 1 : 0, kilos: r.cantidad };
}

/**
 * Cuánto se lleva el cliente de CADA artículo, sumando todos sus renglones.
 *
 * 🪤 Desde el 27/08 el mismo artículo puede ir en varios renglones (distinta lista, distinto
 * descuento). Medir renglón por renglón abría un agujero en el granel: 24 kg de alpiste en un
 * renglón son 1 bulto, pero partidos en 12 + 12 daban CERO, porque ninguno llega solo a los
 * 20 kg. Se perdía un bulto para la promo general y, peor, alcanzaba con partir la cantidad
 * para esquivar cualquier umbral del control.
 *
 * Con un solo renglón por artículo —como funcionó hasta hoy— el resultado es idéntico.
 */
function medirPorArticulo(
  renglones: RenglonPedido[],
  catalogo: Map<number, ArticuloInfo>,
): Map<number, { bultos: number; kilos: number }> {
  const kilosPorArt = new Map<number, number>();
  const bultosPorArt = new Map<number, number>();
  for (const r of renglones) {
    const art = catalogo.get(r.cod_articulo);
    const m = medirRenglon(r, art);
    kilosPorArt.set(r.cod_articulo, (kilosPorArt.get(r.cod_articulo) ?? 0) + m.kilos);
    if (art?.es_bulto) bultosPorArt.set(r.cod_articulo, (bultosPorArt.get(r.cod_articulo) ?? 0) + m.bultos);
  }
  // Alcanza con recorrer kilosPorArt: se llena para TODO renglón (los bultos con kilos > 0 o
  // con 0 si el artículo no declara kg), así que bultosPorArt nunca tiene un código que no
  // esté también acá.
  const out = new Map<number, { bultos: number; kilos: number }>();
  for (const [cod, kilos] of kilosPorArt) {
    const art = catalogo.get(cod);
    // El granel suma UN bulto a partir de 20 kg y no acumula (Mati: "60 kg siguen siendo 1").
    const bultos = art?.es_bulto
      ? (bultosPorArt.get(cod) ?? 0)
      : (kilos >= KG_PARA_CONTAR_BULTO ? 1 : 0);
    out.set(cod, { bultos, kilos });
  }
  return out;
}

/** Bultos surtidos de todo el pedido — lo que define si entra la promo general. */
export function bultosDelPedido(renglones: RenglonPedido[], catalogo: Map<number, ArticuloInfo>): number {
  let n = 0;
  for (const m of medirPorArticulo(renglones, catalogo).values()) n += m.bultos;
  return n;
}

/**
 * Reglas que aplican a un artículo. La regla por artículo le gana a la de la línea:
 * si Mati puso una condición para el código puntual, esa manda sobre la de su subrubro.
 */
function reglasDe(art: ArticuloInfo | undefined, reglas: ReglaLista[]): ReglaLista[] {
  if (!art) return [];
  const porArticulo = reglas.filter(g => g.match_tipo === 'articulo' && Number(g.match_valor) === art.cod_articulo);
  // 'excluido' = este artículo no participa del circuito mayorista (ej: FORRAJES VARIOS,
  // que se usa para facturar a consumidor final). No se controla aunque su línea tenga regla.
  if (porArticulo.some(g => g.condicion === 'excluido')) return [];
  if (porArticulo.length) return porArticulo;
  // 🪤 El gemelo "X KG" vive en el mismo subrubro que la bolsa, así que heredaría las
  // condiciones de la línea — pero se vende fraccionado al público, con otra lógica.
  // Solo se controla si Mati le puso una regla por código propio (el filtro de arriba).
  if (art.es_fraccionado) return [];
  const sub = art.subrubro.toLowerCase();
  return reglas.filter(g => g.match_tipo === 'subrubro' && g.match_valor.toLowerCase() === sub);
}

/**
 * Cuánto descuento admite un renglón y si el vendedor se pasó.
 *
 * Los porcentajes son TOPES (Mati 27/08): poner menos está bien. Un artículo sin ninguna
 * regla NO tiene descuentos habilitados, así que cualquier número mayor a cero se marca.
 */
function evaluarDescuento(
  r: RenglonPedido,
  art: ArticuloInfo | undefined,
  techo: number,
  propio: { bultos: number; kilos: number },
  linea: { bultos: number; kilos: number },
  reglasDescuento: ReglaDescuento[],
  nombre: string,
): Pick<AvisoRenglon, 'descuento' | 'descuento_max' | 'mensaje_descuento' | 'nota_descuento'> {
  const puesto = Math.max(0, Number(r.descuento) || 0);

  const mias = art
    ? (() => {
        const porArt = reglasDescuento.filter(g => g.match_tipo === 'articulo' && Number(g.match_valor) === art.cod_articulo);
        if (porArt.length) return porArt;
        const sub = art.subrubro.toLowerCase();
        return reglasDescuento.filter(g => g.match_tipo === 'subrubro' && g.match_valor.toLowerCase() === sub);
      })()
    : [];

  // De las que aplican a este renglón, gana el tope más alto.
  const aplican = mias.filter((g) => {
    if (g.requiere_lista != null && r.cod_lista !== g.requiere_lista) return false;
    if (g.requiere_mejor_lista && r.cod_lista !== techo) return false;
    const base = g.ambito === 'linea' ? linea : propio;
    return base.bultos >= g.desde_cantidad;
  });
  const max = aplican.reduce((m, g) => Math.max(m, g.porcentaje_max), 0);
  const nota = puesto > 0 ? (aplican.find(g => g.aviso)?.aviso ?? null) : null;

  if (puesto <= max) {
    return { descuento: puesto, descuento_max: max, mensaje_descuento: null, nota_descuento: nota };
  }
  // Se pasó: el mensaje tiene que decir POR QUÉ, que es lo accionable.
  let motivo: string;
  if (!mias.length) {
    motivo = `${nombre}: no tiene descuentos habilitados.`;
  } else if (max === 0) {
    const porLista = mias.find(g => g.requiere_lista != null && r.cod_lista !== g.requiere_lista);
    const porMejor = mias.find(g => g.requiere_mejor_lista && r.cod_lista !== techo);
    if (porLista) motivo = `${nombre}: el descuento sólo se puede aplicar en ${nombreLista(porLista.requiere_lista as number)}, y este renglón está en ${nombreLista(r.cod_lista)}.`;
    else if (porMejor) motivo = `${nombre}: el descuento sólo vale con el mejor precio (${nombreLista(techo)}), y este renglón está en ${nombreLista(r.cod_lista)}.`;
    else motivo = `${nombre}: por esta cantidad todavía no le corresponde descuento.`;
  } else {
    motivo = `${nombre}: el descuento máximo para esta cantidad es ${max}% y pusiste ${puesto}%.`;
  }
  return { descuento: puesto, descuento_max: max, mensaje_descuento: motivo, nota_descuento: nota };
}

/**
 * Evalúa un pedido completo y devuelve un aviso por renglón.
 *
 * El error va en dos direcciones y NO son lo mismo:
 *   - eligió una lista más alta de la que corresponde -> vendió más barato -> pierde margen
 *   - eligió una más baja teniendo derecho           -> le cobró de más al cliente
 */
export function evaluarPedido(
  renglones: RenglonPedido[],
  catalogo: Map<number, ArticuloInfo>,
  reglas: ReglaLista[],
  reglasDescuento: ReglaDescuento[] = [],
): ResultadoPedido {
  const bultos = bultosDelPedido(renglones, catalogo);
  const promoGeneral = bultos >= BULTOS_PROMO_GENERAL;

  // 🪤 Una línea comercial puede estar partida en VARIOS subrubros de IM: "Tiernito"
  // (gato) + "Tiernitos" (perro), o "Zimpi" + "Zimpy" (typo en IM). Acumular por subrubro
  // hacía que 3 bolsas de Tiernito perro + 2 de gato contaran 3 y 2 en vez de 5, y una
  // condición "5 de la misma línea" no se cumplía nunca: el motor marcaba las dos filas
  // como "estás vendiendo más barato" y BLOQUEABA una venta legítima.
  // La línea es el `nombre` de la regla, que es el mismo para todos sus subrubros.
  const lineaDeSubrubro = new Map<string, string>();
  for (const g of reglas) {
    if (g.match_tipo === 'subrubro') lineaDeSubrubro.set(g.match_valor.toLowerCase(), g.nombre);
  }
  const claveLinea = (art: ArticuloInfo | undefined) => {
    if (!art?.subrubro) return null;
    const sub = art.subrubro.toLowerCase();
    return lineaDeSubrubro.get(sub) ?? sub;
  };

  // Se mide por artículo y no por renglón: ver medirPorArticulo. Si el vendedor parte la
  // cantidad de un producto en dos renglones, el cliente igual se lleva la suma.
  const porArticulo = medirPorArticulo(renglones, catalogo);

  const porLinea = new Map<string, { bultos: number; kilos: number }>();
  for (const [cod, m] of porArticulo) {
    const k = claveLinea(catalogo.get(cod));
    if (!k) continue;
    const acc = porLinea.get(k) ?? { bultos: 0, kilos: 0 };
    porLinea.set(k, { bultos: acc.bultos + m.bultos, kilos: acc.kilos + m.kilos });
  }

  const avisos = renglones.map<AvisoRenglon>((r, idx) => {
    const art = catalogo.get(r.cod_articulo);
    const nombre = art?.descripcion || `artículo ${r.cod_articulo}`;
    // Lo que se lleva el cliente de ESTE artículo, contando todos sus renglones.
    const propio = porArticulo.get(r.cod_articulo) ?? medirRenglon(r, art);
    const kLinea = claveLinea(art);
    const linea = (kLinea && porLinea.get(kLinea)) || propio;

    const misReglas = reglasDe(art, reglas);
    if (!misReglas.length) {
      // Sin regla de LISTA, pero puede tener regla de DESCUENTO: son dos cosas distintas.
      return { idx, cod_articulo: r.cod_articulo, lista_elegida: r.cod_lista, lista_sugerida: null,
        severidad: 'sin_regla', mensaje: null,
        ...evaluarDescuento(r, art, LISTA_BASE, propio, linea, reglasDescuento, nombre) };
    }

    const cumple = misReglas.filter((g) => {
      if (g.condicion === 'libre') return true;
      if (g.condicion === 'promo_general') return promoGeneral;
      const umbral = Number(g.umbral ?? 0);
      const base = g.ambito === 'linea' ? linea : propio;
      const valor = g.unidad === 'kg' ? base.kilos : base.bultos;
      return g.condicion === 'min' ? valor >= umbral : valor < umbral;
    });

    // 🔑 Habilitar una lista y obligar a usarla NO son lo mismo:
    //   techo   = hasta dónde PUEDE llegar el vendedor -> pasarse es perder margen
    //   derecho = a dónde tiene derecho el cliente     -> no dárselo es cobrarle de más
    //
    // Solo las condiciones por cantidad del propio producto o su línea generan derecho:
    // si el cliente se llevó los 20 kg, le corresponde y punto. Las otras dos son
    // opcionales y solo suben el techo:
    //   · LIBRE          — decisión comercial del vendedor.
    //   · PROMO GENERAL  — Mati 26/08: "es opcional, lo carga el vendedor, pero en teoría
    //                      lo aplican casi siempre". El contador de bultos del carrito ya
    //                      le avisa que está disponible; acusarlo de error sería falso.
    // Sin esta distinción el validador marcaba mal 1 de cada 3 renglones facturados.
    const OPCIONALES = new Set(['libre', 'promo_general']);
    const techo = cumple.length ? Math.max(...cumple.map((g) => g.cod_lista)) : LISTA_BASE;
    const porCantidad = cumple.filter((g) => !OPCIONALES.has(g.condicion)).map((g) => g.cod_lista);
    const derecho = porCantidad.length ? Math.max(...porCantidad) : LISTA_BASE;

    const desc = evaluarDescuento(r, art, techo, propio, linea, reglasDescuento, nombre);

    if (r.cod_lista > techo) {
      return { idx, cod_articulo: r.cod_articulo, lista_elegida: r.cod_lista, lista_sugerida: techo,
        severidad: 'margen',
        mensaje: `${nombre}: está en ${nombreLista(r.cod_lista)} pero por esta cantidad le corresponde ${nombreLista(techo)}. Le estás vendiendo más barato de lo que corresponde.`,
        ...desc };
    }
    if (r.cod_lista < derecho) {
      return { idx, cod_articulo: r.cod_articulo, lista_elegida: r.cod_lista, lista_sugerida: derecho,
        severidad: 'cliente',
        mensaje: `${nombre}: tiene derecho a ${nombreLista(derecho)} y está en ${nombreLista(r.cod_lista)}. Le estás cobrando de más.`,
        ...desc };
    }
    return { idx, cod_articulo: r.cod_articulo, lista_elegida: r.cod_lista, lista_sugerida: techo,
      severidad: 'ok', mensaje: null, ...desc };
  });

  return { bultos, promo_general: promoGeneral, avisos };
}
