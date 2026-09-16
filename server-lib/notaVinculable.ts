import { vigenciaSegunAnulada } from './vigenciaComprobante.js';
import { idIM } from './identidadIM.js';

/**
 * ¿ESTA NOTA DE INFOMANAGER SE PUEDE ATAR A ESTA ENTREGA?
 *
 * El importe y el signo salen de la nota REAL leída de IM, nunca del formulario: si vinieran de
 * la pantalla, el número final de la hoja —y el pago del chofer— dependería de lo que alguien
 * tipeó.
 *
 * 🔴 Todo lo que no se pueda acreditar RECHAZA. No hay defaults: una letra ausente, una vigencia
 * que no se puede confirmar o un total ilegible no son "probablemente sí".
 *
 * CONTRATO DE IDENTIDAD (esto ESCRIBE un vínculo, no compara de sólo lectura): la respuesta tiene
 * que traer el id, tiene que ser un id legible y tiene que ser EL pedido. Una lectura que no
 * acredita cuál comprobante contestó no alcanza para atarle plata a una hoja de ruta. Y el id que
 * se graba es el que se devuelve acá —canónico, en texto— para que la fila no dependa de lo que
 * el llamador tenga a mano.
 */

export type TipoNota = 'NC' | 'ND';

export interface EntregaDestino {
  cod_cliente: unknown;
  cod_empresa: unknown;
}

export interface NotaLeida {
  /** El id que devolvió IM en el cuerpo (`leerComprobante().idDevuelto`). */
  id?: unknown;
  tipo_comprobante?: unknown;
  tipo_factura?: unknown;
  numero?: unknown;
  cod_cliente?: unknown;
  cod_empresa?: unknown;
  anulada?: unknown;
  total?: unknown;
  observaciones?: unknown;
}

export type Verificacion =
  | { ok: true; /** Canónico, el que hay que grabar. */ id: string; tipo: TipoNota; letra: string; numero: number; importe: number; /** `-1` resta, `+1` suma. */ signo: -1 | 1 }
  | { ok: false; error: string };

/** 🪤 Sólo number o string legible: `Number(["5"])` es 5 y `Number(true)` es 1. */
const importeSeguro = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.abs(n) : null;
};
const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/**
 * @param pedida  el id con el que se pidió la nota, para cotejar contra el que devolvió IM
 * @param empresaCasaCentral la única que despacha con hoja de ruta
 */
export function verificarNota(
  nota: NotaLeida | null | undefined,
  pedida: unknown,
  entrega: EntregaDestino,
  empresaCasaCentral: number,
): Verificacion {
  if (!nota) return { ok: false, error: 'No encontré esa nota en InfoManager.' };

  // Los dos lados por la MISMA función: los ids de IM son enteros largos y comparar en texto
  // canónico evita que `Number` los redondee en silencio.
  const buscada = idIM(pedida);
  if (buscada === null) return { ok: false, error: 'El identificador de la nota no es válido.' };
  const devuelto = idIM(nota.id);
  if (devuelto === null) return { ok: false, error: 'InfoManager no acreditó qué comprobante devolvió; no se puede vincular a ciegas.' };
  if (devuelto !== buscada) return { ok: false, error: 'InfoManager devolvió un comprobante distinto del que se pidió.' };

  const tipo = texto(nota.tipo_comprobante)?.toUpperCase();
  if (tipo !== 'NC' && tipo !== 'ND') {
    return { ok: false, error: `Ese comprobante no es una nota de crédito ni de débito${tipo ? ` (es ${tipo})` : ''}.` };
  }

  // 🔴 Vigencia CONFIRMADA. Un `null` o una 'X' no son "vigente": son "no se sabe".
  const vigente = vigenciaSegunAnulada(nota.anulada);
  if (vigente === false) return { ok: false, error: `Esa ${tipo === 'NC' ? 'nota de crédito' : 'nota de débito'} está ANULADA en InfoManager.` };
  if (vigente !== true) return { ok: false, error: 'No se pudo confirmar que la nota siga vigente en InfoManager.' };

  const letra = texto(nota.tipo_factura)?.toUpperCase();
  if (!letra || !/^[A-Z]$/.test(letra)) return { ok: false, error: 'La nota no tiene una letra legible en InfoManager.' };

  // Sin número no hay forma de que la oficina reconozca en pantalla el comprobante que ofrecemos.
  const numeroTexto = idIM(nota.numero);
  const numero = numeroTexto === null ? null : Number(numeroTexto);
  if (numero === null || !Number.isSafeInteger(numero) || numero <= 0 || numero > 2_147_483_647) {
    return { ok: false, error: 'La nota no tiene número en InfoManager.' };
  }

  const cliente = idIM(entrega.cod_cliente), empresa = idIM(entrega.cod_empresa);
  if (cliente === null || empresa === null) return { ok: false, error: 'La entrega no tiene cliente o empresa verificados.' };
  if (idIM(nota.cod_cliente) !== cliente) {
    return { ok: false, error: `Esa nota es del cliente ${texto(nota.cod_cliente) ?? '—'} y la entrega es del ${cliente}.` };
  }
  // 🔴 Las dos de Casa Central: la hoja de ruta es sólo de ella.
  if (idIM(nota.cod_empresa) !== empresa || empresa !== idIM(empresaCasaCentral)) {
    return { ok: false, error: 'La nota y la entrega tienen que ser de la misma empresa de Casa Central.' };
  }

  const importe = importeSeguro(nota.total);
  if (importe === null) return { ok: false, error: 'El importe de la nota no es un número legible.' };
  if (!(importe > 0)) return { ok: false, error: 'Esa nota tiene importe cero.' };

  return {
    ok: true, id: devuelto, tipo, letra, numero, importe,
    // 🔴 El signo sale del TIPO verificado en IM, nunca de lo que eligió quien vincula.
    signo: tipo === 'NC' ? -1 : 1,
  };
}

/**
 * Lo que el operador tenía en pantalla cuando apretó "Vincular".
 *
 * 🔴 Condición, NUNCA fuente: el importe que se graba sale siempre de la nota real; esto sólo
 * responde "¿sigue siendo la que vio?". La lista de candidatas puede venir de caché, y entre
 * mostrarla y confirmar la nota pudo cambiar de importe, de tipo o de número. Grabar el valor
 * nuevo en silencio sería descontarle a la hoja —y al pago del chofer— una cifra que nadie miró.
 *
 * 🪤 Los TRES campos son obligatorios y legibles, o no hay cotejo. Un `{}`, un `null` o un
 * `"ilegible"` harían que cada comparación se saltee sola y la confirmación pase siempre —
 * justo en el caso que se quería atrapar. Y el tipo va COMPLETO, con la letra: comparar sólo
 * "NC" deja pasar un cambio de A a B, que es otro comprobante.
 */
export interface NotaEsperada {
  /** Tal como se mostró: `NC B`, `ND A`. */
  tipo?: unknown;
  numero?: unknown;
  importe?: unknown;
}

export type Cotejo =
  | { ok: true }
  /** `recargar` distingue "no me mandaste con qué comparar" (400) de "cambió" (409). */
  | { ok: false; motivo: string; recargar: boolean };

/** Number finito desde number o string legible; `true`, `[5]` y `{}` no son importes. */
const numeroLegible = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

export function cambioDesdeLaPantalla(v: Extract<Verificacion, { ok: true }>, esperado: NotaEsperada | null | undefined): Cotejo {
  const incompleto = (que: string): Cotejo =>
    ({ ok: false, motivo: `No se pudo leer ${que} de la nota que viste. Recargá la pantalla.`, recargar: false });
  if (!esperado || typeof esperado !== 'object' || Array.isArray(esperado)) return incompleto('el detalle');

  const tipo = typeof esperado.tipo === 'string' ? esperado.tipo.trim().toUpperCase() : '';
  if (!/^(NC|ND) [A-Z]$/.test(tipo)) return incompleto('el tipo');
  const numero = numeroLegible(esperado.numero);
  if (numero === null || !Number.isInteger(numero) || numero <= 0) return incompleto('el número');
  const importe = numeroLegible(esperado.importe);
  if (importe === null || importe <= 0) return incompleto('el importe');

  const cambio = (dice: string): Cotejo => ({ ok: false, motivo: `Esa nota cambió desde que la viste: ${dice}. Recargá la lista y confirmá de nuevo.`, recargar: true });
  if (tipo !== `${v.tipo} ${v.letra}`) return cambio(`ahora es una ${v.tipo} ${v.letra}`);
  if (numero !== v.numero) return cambio(`ahora es la número ${v.numero}`);
  if (Math.abs(importe - v.importe) > 0.005) return cambio(`ahora dice ${v.importe}`);
  return { ok: true };
}
