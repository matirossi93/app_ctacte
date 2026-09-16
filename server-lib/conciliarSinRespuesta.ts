import { idIM } from './identidadIM.js';
import { marcaDeFactura } from './facturarIM.js';
import { vigenciaSegunAnulada } from './vigenciaComprobante.js';

/**
 * QUÉ PASÓ CON LO QUE SE EMITIÓ CUANDO INFOMANAGER NO CONTESTÓ.
 *
 * Al facturar, IM puede tardar más de 25 s y la app corta sin saber si el comprobante salió. Ahí
 * el pedido queda `incierto` y se FRENA a propósito: reintentar a ciegas puede facturar dos veces
 * al mismo cliente. Pasó el 14/09/2026 con FRENTE NORTE (PR 58537, el remito) y con FIGUEROA
 * (PR 58536, la factura).
 *
 * 🔑 El problema era que después nadie lo resolvía: la fila quedaba trabada hasta que alguien
 * tocara la base a mano. Esto lo cierra mirando lo que IM ya devolvió en la misma lectura que la
 * pantalla hace igual, sin un solo GET extra.
 *
 * 🔴 SÓLO SOBRE EVIDENCIA PROPIA Y POSITIVA. No se aparea por importe ni por fecha: se buscan las
 * marcas que ESTA app escribe al emitir.
 *  · La factura lleva `cod_compatibilidad` con el id del presupuesto — lo único nuestro que IM
 *    guarda en un campo propio.
 *  · El remito lleva `[Remito Automático -FA:<id>]` en las observaciones, la misma convención que
 *    usa InfoManager.
 * Un remito no valorizado sale con importe cero, así que aparear por monto ni siquiera serviría.
 *
 * 🪤 No encontrar nada NO es prueba de que no salió: las observaciones se cortan en 500
 * caracteres y el comprobante puede tener otra fecha y quedar fuera del rango leído. Por eso la
 * ausencia no destraba nada: deja el pedido como está y dice qué mirar.
 */

/**
 * QUÉ FILAS PUEDE MIRAR LA CONCILIACIÓN.
 *
 * `incierto` es "IM no contestó y no sabemos qué salió". Pero hay dos estados más que terminan
 * igual de trabados: `factura_emitiendo` y `remito_emitiendo`, que son "lo estoy emitiendo".
 * Si la emisión se corta en el medio —el pedido a IM queda colgado, el reverse-proxy corta la
 * respuesta, el contenedor se reinicia— la fila se queda ahí y no la destraba nadie: la
 * conciliación no la miraba, el checkbox de la pantalla está deshabilitado y "Liberar" sólo
 * borra `rechazado`. Pasó el 16/09/2026 con PR 58680 (URUEÑA): la factura 50640 salió, el remito
 * quedó a medias y el pedido no se podía tocar desde ningún lado.
 *
 * 🪤 Un `*_emitiendo` RECIÉN reclamado es alguien emitiendo AHORA. Tocarlo sería adoptar un
 * comprobante mientras el proceso que lo emitió está por registrarlo. Por eso sólo entran los
 * que llevan más del plazo del reclamo, y sin fecha de reclamo no entra ninguno: si no se sabe
 * de cuándo es, no se toca.
 */
const EMITIENDO = ['factura_emitiendo', 'remito_emitiendo'];

export function esConciliable(
  fila: { estado_emision?: string | null; reclamado_at?: string | null },
  ahora: number,
  venceMs: number,
): boolean {
  const estado = String(fila.estado_emision ?? '');
  if (estado === 'incierto') return true;
  if (!EMITIENDO.includes(estado)) return false;
  const reclamado = Date.parse(String(fila.reclamado_at ?? ''));
  return Number.isFinite(reclamado) && ahora - reclamado >= venceMs;
}

export interface FilaIncierta {
  im_comprobante_id: string;
  im_numero?: number | null;
  im_factura_id?: string | null;
  im_remito_id?: string | null;
  cod_cliente?: number | null;
  cod_empresa?: number | null;
}

export interface VentaIM {
  id?: unknown;
  numero?: unknown;
  tipo_comprobante?: unknown;
  tipo_factura?: unknown;
  cod_cliente?: unknown;
  cod_empresa?: unknown;
  anulada?: unknown;
  observaciones?: unknown;
  cod_compatibilidad?: unknown;
}

export type Resolucion =
  | { accion: 'adoptar'; que: 'factura' | 'remito'; id: string; numero: number | null; tipo: string | null }
  /** No hay evidencia, o hay más de una: se explica qué mirar y no se toca nada. */
  | { accion: 'revisar'; motivo: string };

const entero = (v: unknown): number | null => {
  const t = idIM(v);
  return t === null ? null : Number(t);
};

/** Del mismo cliente y de la misma empresa, y vigente: cualquier duda descarta. */
export function esDeLaEntrega(v: VentaIM, fila: FilaIncierta): boolean {
  if (vigenciaSegunAnulada(v.anulada) !== true) return false;
  const cliente = entero(fila.cod_cliente), empresa = entero(fila.cod_empresa);
  if (cliente === null || empresa === null) return false;
  return entero(v.cod_cliente) === cliente && entero(v.cod_empresa) === empresa;
}

const tipoDe = (v: VentaIM) => String(v.tipo_comprobante ?? '').trim().toUpperCase();

/**
 * @param usados los ids de comprobantes ya registrados en CUALQUIER pedido: uno solo no puede
 *   corresponder a dos, y adoptarlo dos veces duplicaría la mercadería o la facturación.
 */
export function resolverSinRespuesta(fila: FilaIncierta, ventas: VentaIM[], usados: Set<string>): Resolucion {
  const pedido = idIM(fila.im_comprobante_id);
  if (pedido === null) return { accion: 'revisar', motivo: 'El pedido no tiene un identificador legible.' };

  // ── Falta la FACTURA: se busca por el código que IM guarda del presupuesto ──
  if (!fila.im_factura_id) {
    // 🪤 `cod_compatibilidad` son los 8 primeros caracteres: así lo manda la app al emitir.
    const clave = pedido.slice(0, 8);
    const candidatas = ventas.filter(v =>
      tipoDe(v) === 'FA' && esDeLaEntrega(v, fila)
      && String(v.cod_compatibilidad ?? '').trim() === clave
      && !usados.has(String(idIM(v.id) ?? '')) && idIM(v.id) !== null);
    if (candidatas.length === 1) {
      const v = candidatas[0];
      return { accion: 'adoptar', que: 'factura', id: idIM(v.id)!, numero: entero(v.numero), tipo: letra('FA', v) };
    }
    return {
      accion: 'revisar',
      motivo: candidatas.length
        ? `Hay ${candidatas.length} facturas con el código de este pedido. Revisá cuál corresponde en InfoManager.`
        : `No encontré ninguna factura de este pedido en InfoManager. Si la ves ahí, puede tener otra fecha; si no está, se puede volver a facturar.`,
    };
  }

  // ── La factura está; falta el REMITO: se busca por la marca que lleva de ella ──
  if (!fila.im_remito_id) {
    const marca = marcaDeFactura(fila.im_factura_id).trim();
    if (!marca) return { accion: 'revisar', motivo: 'La factura registrada no tiene un identificador legible.' };
    const candidatos = ventas.filter(v =>
      tipoDe(v) === 'RE' && esDeLaEntrega(v, fila)
      && String(v.observaciones ?? '').includes(marca)
      && !usados.has(String(idIM(v.id) ?? '')) && idIM(v.id) !== null);
    if (candidatos.length === 1) {
      const v = candidatos[0];
      return { accion: 'adoptar', que: 'remito', id: idIM(v.id)!, numero: entero(v.numero), tipo: letra('RE', v) };
    }
    return {
      accion: 'revisar',
      motivo: candidatos.length
        ? `Hay ${candidatos.length} remitos marcados con esta factura. Revisá cuál corresponde en InfoManager.`
        : `No encontré el remito de la factura ${fila.im_factura_id} en InfoManager. Si no está, falta emitirlo: la factura ya salió.`,
    };
  }

  return { accion: 'revisar', motivo: 'Este pedido ya tiene su factura y su remito registrados.' };
}

const letra = (tipo: string, v: VentaIM): string | null => {
  const l = String(v.tipo_factura ?? '').trim().toUpperCase();
  return /^[A-Z]$/.test(l) ? `${tipo} ${l}` : null;
};
