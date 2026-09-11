/**
 * DE QUÉ TALONARIO SALE EL PRÓXIMO NÚMERO.
 *
 * InfoManager nombra la serie al rechazar un número repetido: *"Ya existe una factura con:
 * tag = 'S', cod_empresa = 1, id_destino = 1, punto_de_venta = 777, tipo_factura = 'B' y
 * numero = …"*. El mensaje no menciona `tipo_comprobante`; **qué hace IM con eso no lo sabemos**
 * —no tenemos su código—, así que el tipo se sigue respetando: es lo que mantiene la
 * correlatividad de cada talonario.
 *
 * 🔴 DOS ERRORES OPUESTOS, LOS DOS CAROS:
 *  · Contar una fila ajena → el número se pasa y se saltea la serie en silencio.
 *  · Saltear una fila que ES nuestra → el número sale bajo y se propone un correlativo YA USADO.
 *
 * Por eso: **una contradicción legible en CUALQUIER dimensión descarta la fila** —da igual que
 * las demás no se puedan leer—, y sólo la duda real, sin ninguna contradicción, corta el cálculo.
 */

export interface SerieComprobante {
  cod_empresa: number;
  id_destino: number;
  /** 'S' o 'N': son los únicos que define el contrato. */
  tag: string;
}

/** Entero seguro y positivo. 🪤 `1.5`, `1e20`, `true` y `["1"]` no son identificadores. */
export function idSeguro(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Número de comprobante: entero seguro y no negativo. */
export function numeroSeguro(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const tagValido = (v: unknown): string | null => {
  const t = texto(v)?.toUpperCase() ?? null;
  return t === 'S' || t === 'N' ? t : null;
};

/** Lo que se pide tiene que ser una serie real, con un punto de venta usable. */
export function objetivoValido(s: SerieComprobante | null | undefined, puntoDeVenta: unknown, letra: unknown, tipo: unknown): boolean {
  return !!s && idSeguro(s.cod_empresa) !== null && idSeguro(s.id_destino) !== null
    && tagValido(s.tag) !== null && idSeguro(puntoDeVenta) !== null
    && texto(letra) !== null && texto(tipo) !== null;
}

export function claveDeSerie(s: SerieComprobante, tipo: string, letra: string, puntoDeVenta: number): string {
  return `${s.cod_empresa}|${s.id_destino}|${tagValido(s.tag)}|${puntoDeVenta}|${tipo}|${letra}`;
}

/**
 * `ajena` = contradice en algo legible · `propia` = coincide en todo · `desconocida` = no
 * contradice nada y falta algún dato.
 */
export function clasificarFila(
  v: any, serie: SerieComprobante, tipo: string, letra: string, puntoDeVenta: number,
): 'ajena' | 'propia' | 'desconocida' {
  const dims: Array<[unknown, unknown]> = [
    [texto(v?.tipo_comprobante), tipo],
    [texto(v?.tipo_factura), letra],
    [idSeguro(v?.punto_de_venta), puntoDeVenta],
    [idSeguro(v?.cod_empresa), idSeguro(serie.cod_empresa)],
    [idSeguro(v?.id_destino), idSeguro(serie.id_destino)],
    [tagValido(v?.tag), tagValido(serie.tag)],
  ];
  let dudas = 0;
  for (const [leido, esperado] of dims) {
    // 🔴 Primero la contradicción: que no se pueda leer el resto da igual si YA se sabe que es
    // de otro talonario.
    if (leido !== null && leido !== esperado) return 'ajena';
    if (leido === null) dudas++;
  }
  return dudas ? 'desconocida' : 'propia';
}

export type ResultadoSerie =
  | { estado: 'ok'; numero: number }
  /** No hay ningún comprobante de esta serie en la ventana mirada. */
  | { estado: 'vacio' }
  /** Hay filas que podrían ser de esta serie y no se pueden ubicar, o un número ilegible. */
  | { estado: 'incierto'; motivo: string };

/**
 * El próximo número de la serie.
 *
 * 🪤 Devuelve `vacio` e `incierto` por separado a propósito: **son cosas distintas**. Con `vacio`
 * tiene sentido mirar una ventana más larga; con `incierto`, ampliar sólo esconde el problema
 * detrás de más filas.
 */
export function proximoDeLaSerie(
  filas: any[], serie: SerieComprobante, tipo: string, letra: string, puntoDeVenta: number,
): ResultadoSerie {
  if (!objetivoValido(serie, puntoDeVenta, letra, tipo)) {
    return { estado: 'incierto', motivo: 'La serie pedida está incompleta o no es legible.' };
  }
  const numeros: number[] = [];
  for (const v of filas) {
    const clase = clasificarFila(v, serie, tipo, letra, puntoDeVenta);
    if (clase === 'ajena') continue;
    if (clase === 'desconocida') {
      return { estado: 'incierto', motivo: 'Hay comprobantes que podrían ser de esta serie y no se pueden identificar.' };
    }
    const n = numeroSeguro(v?.numero);
    if (n === null) return { estado: 'incierto', motivo: 'Un comprobante de esta serie tiene el número ilegible.' };
    numeros.push(n);
  }
  /**
   * 🪤 Sólo los POSITIVOS dan el máximo. Ver únicamente ceros no prueba un talonario sin usar
   * —puede ser que el número no se haya guardado—, y arrancar en 1 inventaría una serie.
   */
  const positivos = numeros.filter(n => n > 0);
  if (!positivos.length) {
    return numeros.length
      ? { estado: 'incierto', motivo: 'Los comprobantes de esta serie no tienen número asignado.' }
      : { estado: 'vacio' };
  }
  const siguiente = Math.max(...positivos) + 1;
  // Pasado el entero seguro, el +1 deja de ser el siguiente.
  return Number.isSafeInteger(siguiente) ? { estado: 'ok', numero: siguiente }
    : { estado: 'incierto', motivo: 'El próximo número se pasa del entero seguro.' };
}
