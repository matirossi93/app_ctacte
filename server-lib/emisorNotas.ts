import { emitirNotaV2 } from './emitirNotaV2.js';
import { emitirNotaCredito, emitirNotaDebito, letraDeFactura, type ResultadoEmision } from './facturarIM.js';
import { imV2Configurada } from './imApiV2.js';
import type { SubtipoCorreccion } from './subtipoNota.js';

/**
 * POR DÓNDE SALE CADA NOTA DE CRÉDITO O DÉBITO: la API nueva o la de siempre.
 *
 * Mati (21/09/2026): *"cualquier cosa lo cambiamos, pero una vez que esté funcionando bien, ya lo
 * sacamos el botón y listo"*.
 *
 * 🔑 `IM_NOTAS_V2` existe para poder VOLVER ATRÁS en un minuto sin esperar un despliegue, no para
 * tener dos caminos para siempre. Cuando lleve un par de semanas sin sobresaltos, se borra este
 * módulo y queda sólo v2.
 *
 * Lo que se gana yendo por v2 (probado emitiendo la NC B 777-30117 el 21/09/2026, anulada):
 *   · La nota queda atada a su factura EN InfoManager (`id_comp_asoc`), no en un texto nuestro.
 *   · La numera InfoManager: se acabó calcular el correlativo, que fue el choque de serie de la
 *     NC B 30079.
 *   · `Idempotency-Key`: un reintento con la misma clave no emite una segunda nota.
 */
const activo = () => String(process.env.IM_NOTAS_V2 ?? '1') === '1';

export interface ComponenteNota {
  tipo: 'NC' | 'ND';
  datos: any;
  /**
   * El subtipo que exige la v2, calculado al crear la operación (ver `subtipoNota.ts`).
   * 🪤 Ausente en las operaciones creadas ANTES de este cambio: esas siguen por v1, porque
   * adivinarle el subtipo a una corrección ya en curso sería inventar qué pasó.
   */
  subtipo?: SubtipoCorreccion;
}
export interface OperacionMinima {
  id: string;
  indice: number;
  im_factura_id: string;
}

/** ¿Esta nota puede salir por la API nueva? */
export function vaPorV2(o: OperacionMinima, c: ComponenteNota): boolean {
  if (!activo() || !imV2Configurada()) return false;
  // Sin la factura que acredita no hay nada que atar, que es el motivo de usar v2.
  if (!String(o.im_factura_id ?? '').trim()) return false;
  // La NC necesita subtipo; la ND no lo lleva.
  return c.tipo === 'ND' || !!c.subtipo;
}

export async function emitirComponente(o: OperacionMinima, c: ComponenteNota): Promise<ResultadoEmision> {
  if (!vaPorV2(o, c)) {
    return c.tipo === 'NC' ? emitirNotaCredito(c.datos) : emitirNotaDebito(c.datos);
  }
  const d = c.datos;
  const letra = letraDeFactura(d.categoria_iva);
  if (!letra) {
    // Sin letra no se puede emitir por ningún camino; el de siempre da el mensaje bueno.
    return c.tipo === 'NC' ? emitirNotaCredito(d) : emitirNotaDebito(d);
  }
  try {
    /**
     * 🔴 LA CLAVE DE IDEMPOTENCIA ES LA OPERACIÓN Y EL PASO, y por eso es estable entre
     * reintentos: si la primera llamada emitió pero se perdió la respuesta, el reintento con la
     * misma clave devuelve esa nota en vez de crear otra. Un `randomUUID()` acá no serviría de
     * nada — sería una clave nueva por intento, que es justo lo contrario.
     */
    const r = await emitirNotaV2({
      tipo: c.tipo,
      fecha: d.fecha ?? null,
      letra,
      cod_cliente: Number(d.cod_cliente),
      cod_empresa: Number(d.cod_empresa),
      cod_vendedor: d.cod_vendedor ?? null,
      observaciones: d.observaciones ?? '',
      ...(c.tipo === 'NC' && c.subtipo ? { tipo_nc: c.subtipo } : {}),
      factura: { im_id: o.im_factura_id },
      cod_deposito: d.cod_deposito ?? null,
      items: (d.items ?? []).map((it: any) => ({
        cod_articulo: Number(it.cod_articulo),
        cantidad: Number(it.cantidad),
        precio: it.precio != null ? Number(it.precio) : null,
        descuento_porc: it.descuento_porc != null ? Number(it.descuento_porc) : null,
      })),
      idempotencyKey: `${o.id}:${o.indice}`,
    });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, id: r.im_id, numero: r.numero, tipo: `${c.tipo} ${letra}` };
  } catch (e: any) {
    /**
     * 🪤 Una excepción acá es "no sé si salió", igual que en v1, y se marca como tal: el journal
     * bloquea el reintento y obliga a mirar InfoManager. Con `Idempotency-Key` el reintento sería
     * seguro, pero eso cambia la semántica del journal y se decide aparte, no de costado.
     */
    return { ok: false, sinRespuesta: true, error: e?.message ?? 'Se perdió la respuesta de InfoManager' };
  }
}
