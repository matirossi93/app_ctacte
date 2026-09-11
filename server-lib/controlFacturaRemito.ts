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

/**
 * ¿Este renglón declara una unidad alternativa que no se puede acreditar?
 *
 * 🔴 Un marcador explícito bloquea la comparación **aunque los dos lados traigan el mismo**: sin
 * la equivalencia acreditada, afirmar que 1 de una unidad es igual a 1 de la otra sería inventar
 * una conversión. Y un valor ilegible ('X', negativo) tampoco puede darse por ausente.
 *
 * 🪤 Lo único que NO bloquea es la ausencia —null, undefined, vacío— y el cero, que es la
 * emisión normal sin unidad alternativa.
 */
function bloqueaPorUnidad(r: RenglonEvidencia): boolean {
  for (const v of [r.cod_uni_venta, r.cant_uni_venta]) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (Number.isFinite(n) && n === 0) continue;
    return true;
  }
  return false;
}

interface Agregado { porArticulo: Map<number, number> }

/** `null` = la evidencia no alcanza para comparar. */
function agregar(rs: RenglonEvidencia[]): Agregado | 'unidad' | null {
  const porArticulo = new Map<number, number>();
  for (const r of rs) {
    const cod = cantidadExplicita(r.cod_articulo);
    // 🪤 Entero SEGURO: los códigos son int64 y dos distintos fuera del rango exacto de JS
    // colapsarían en el mismo número — se aparearían renglones que no son el mismo artículo.
    if (cod === null || !Number.isSafeInteger(cod) || cod <= 0) return null;
    if (NO_FISICOS.has(cod)) continue;
    if (bloqueaPorUnidad(r)) return 'unidad';
    const cant = cantidadExplicita(r.cantidad);
    if (cant === null) return null;                       // 🔴 nunca tratar un "no sé" como 0
    porArticulo.set(cod, (porArticulo.get(cod) ?? 0) + cant);
  }
  return { porArticulo };
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
  if (fa === 'unidad' || re === 'unidad') {
    return { estado: 'no_verificado', motivo: 'Hay renglones con una unidad de venta alternativa: no se puede comparar sin su equivalencia.' };
  }
  if (!fa || !re) return { estado: 'no_verificado', motivo: 'Hay renglones sin cantidad o sin artículo legibles.' };

  const codigos = [...new Set([...fa.porArticulo.keys(), ...re.porArticulo.keys()])].sort((a, b) => a - b);
  if (!codigos.length) return { estado: 'no_verificado', motivo: 'No quedaron artículos comparables.' };

  const diferencias: DiferenciaArticulo[] = [];
  for (const cod of codigos) {
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
