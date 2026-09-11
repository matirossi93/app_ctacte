/**
 * ¿LA FACTURA Y EL REMITO DICEN LAS MISMAS CANTIDADES?
 *
 * 🔴 INFORMATIVO, Y NO AFIRMA UNA ENTREGA. Compara lo que quedó REGISTRADO en cada comprobante.
 * Que las cantidades coincidan no dice que se haya entregado eso ni habilita ninguna conclusión
 * de stock: eso está en los movimientos, no acá.
 *
 * 🪤 NO se convierte por `equivalencia_um` del catálogo: es el valor de HOY y no acredita la
 * unidad con la que se registró el comprobante. Se comparan las cantidades tal como están, y
 * cualquier marcador de unidad alternativa sin equivalencia acreditada deja el par sin verificar.
 */

/** Un renglón como viene de IM, sin normalizar: convertir de más borra la incertidumbre. */
export interface RenglonEvidencia {
  cod_articulo: unknown;
  /** 🪤 CRUDA. `Number(null)` es 0, y dos "no sé" convertidos a 0 darían "coinciden". */
  cantidad: unknown;
  /** Marcadores de unidad alternativa, si el comprobante los trae. */
  cod_uni_venta?: unknown;
  cant_uni_venta?: unknown;
}

export type EstadoControl = 'coinciden' | 'diferencias' | 'no_verificado';

export interface DiferenciaArticulo {
  cod_articulo: number;
  factura: number;
  remito: number;
}

export interface ResultadoControl {
  estado: EstadoControl;
  /** Por qué no se pudo verificar. Sólo con `no_verificado`. */
  motivo?: string;
  /** Qué difiere. Sólo con `diferencias`. */
  diferencias?: DiferenciaArticulo[];
}

/**
 * 🪤 COSTO DE DISTRIBUCIÓN no es mercadería: es un importe que escribe la oficina. Va en la
 * factura y no tiene por qué ir en el remito, así que compararlo sería un falso positivo
 * garantizado.
 */
const NO_FISICOS = new Set([Number(process.env.IM_ART_COSTO_DISTRIBUCION || 13819)]);

/**
 * Medio paso de la última posición que usa IM (4 decimales). 🪤 Con 0,0005 —cinco pasos— una
 * diferencia real de 0,0001 quedaba tapada.
 */
const TOLERANCIA = 0.00005;

/** `null`, `''` y `undefined` NO son 0: son "no se sabe". */
function cantidadExplicita(v: unknown): number | null {
  // 🪤 Sólo número o texto: `Number(["5"])` es 5 y `Number(true)` es 1 — la coerción convierte un
  // dato ilegible en una cantidad, y dos ilegibles "iguales" darían coinciden.
  const n = typeof v === 'number' ? v
    : typeof v === 'string' && v.trim() !== '' ? Number(v)
    : NaN;
  // Negativo en una FA o un remito es un dato anómalo: no se afirma nada sobre él.
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** El marcador de unidad alternativa que declara el renglón, o `null` si no declara ninguno. */
function unidadAlternativa(r: RenglonEvidencia): string | null {
  const cod = cantidadExplicita(r.cod_uni_venta);
  const cant = cantidadExplicita(r.cant_uni_venta);
  // 🪤 `cod_uni_venta: 0` y `cant_uni_venta: 0` son lo NORMAL —emisión sin unidad alternativa—,
  // no una incompatibilidad.
  const hayCod = cod !== null && cod !== 0;
  const hayCant = cant !== null && cant !== 0;
  // 🔴 Una cantidad alternativa sin su código es un marcador explícito cuya equivalencia no está
  // acreditada. No se puede comparar aunque los dos lados traigan lo mismo: sería afirmar una
  // unidad física que nadie declaró.
  if (!hayCod && hayCant) return '∗ambigua';
  if (!hayCod) return null;
  return `${cod}|${cant ?? '?'}`;
}

interface Agregado { porArticulo: Map<number, number>; unidades: Map<number, string | null> }

/** `null` = la evidencia no alcanza para comparar. */
function agregar(rs: RenglonEvidencia[]): Agregado | null {
  const porArticulo = new Map<number, number>();
  const unidades = new Map<number, string | null>();
  for (const r of rs) {
    const cod = cantidadExplicita(r.cod_articulo);
    // Sin código no se puede aparear con nada del otro lado.
    if (cod === null || !Number.isInteger(cod) || cod <= 0) return null;
    if (NO_FISICOS.has(cod)) continue;
    const cant = cantidadExplicita(r.cantidad);
    if (cant === null) return null;                       // 🔴 nunca tratar un "no sé" como 0
    porArticulo.set(cod, (porArticulo.get(cod) ?? 0) + cant);
    // Filas repetidas del mismo artículo: si declaran unidades distintas, no se puede afirmar.
    const u = unidadAlternativa(r);
    if (unidades.has(cod) && unidades.get(cod) !== u) unidades.set(cod, '∗ambigua');
    else if (!unidades.has(cod)) unidades.set(cod, u);
  }
  return { porArticulo, unidades };
}

/**
 * @param factura renglones de la FA · `null`/`undefined` = no hay evidencia
 * @param remito  renglones del RE · idem
 */
export function compararFacturaRemito(
  factura: RenglonEvidencia[] | null | undefined,
  remito: RenglonEvidencia[] | null | undefined,
): ResultadoControl {
  if (!factura || !remito) return { estado: 'no_verificado', motivo: 'No se leyeron los renglones de los dos comprobantes.' };
  if (!factura.length || !remito.length) return { estado: 'no_verificado', motivo: 'Uno de los dos comprobantes vino sin renglones.' };

  const fa = agregar(factura), re = agregar(remito);
  if (!fa || !re) return { estado: 'no_verificado', motivo: 'Hay renglones sin cantidad o sin artículo legibles.' };

  const codigos = [...new Set([...fa.porArticulo.keys(), ...re.porArticulo.keys()])].sort((a, b) => a - b);
  if (!codigos.length) return { estado: 'no_verificado', motivo: 'No quedaron artículos comparables.' };

  const diferencias: DiferenciaArticulo[] = [];
  for (const cod of codigos) {
    const uf = fa.unidades.get(cod) ?? null, ur = re.unidades.get(cod) ?? null;
    // 🪤 Unidades distintas no son una diferencia de cantidad: son datos que no se pueden
    // comparar entre sí. Afirmar cualquiera de las dos cosas sería inventar.
    if (uf === '∗ambigua' || ur === '∗ambigua' || uf !== ur) {
      return { estado: 'no_verificado', motivo: `El artículo ${cod} está registrado con unidades distintas en cada comprobante.` };
    }
    const cf = fa.porArticulo.get(cod) ?? 0, cr = re.porArticulo.get(cod) ?? 0;
    // 🪤 Sumas que desbordan: `Infinity - Infinity` es NaN, y `NaN > tolerancia` es false — o sea
    // que dos totales inutilizables se habrían reportado como coincidencia.
    if (!Number.isFinite(cf) || !Number.isFinite(cr)) {
      return { estado: 'no_verificado', motivo: `Las cantidades del artículo ${cod} no dan un total utilizable.` };
    }
    if (Math.abs(cf - cr) > TOLERANCIA) diferencias.push({ cod_articulo: cod, factura: cf, remito: cr });
  }
  return diferencias.length ? { estado: 'diferencias', diferencias } : { estado: 'coinciden' };
}

/** El texto para la pantalla. No nombra entrega ni stock: sólo lo que dicen los papeles. */
export function textoControl(r: ResultadoControl): string {
  if (r.estado === 'coinciden') return 'Coinciden las cantidades registradas en la factura y el remito.';
  if (r.estado === 'no_verificado') return r.motivo ?? 'No se pudo comparar.';
  const d = (r.diferencias ?? []).map(x => `${x.cod_articulo} (factura ${x.factura}, remito ${x.remito})`);
  return `La factura y el remito tienen cantidades distintas: ${d.join(' · ')}.`;
}
