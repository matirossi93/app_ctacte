import { emitirNotaV2, type CodControl } from './emitirNotaV2.js';
import { emitirNotaCredito, emitirNotaDebito, letraDeFactura, type ResultadoEmision } from './facturarIM.js';
import { imV2Configurada, claveIdempotente } from './imApiV2.js';
import { sb, TENANT_ID } from './supabase.js';
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

/**
 * 🔴 DE QUÉ CUBETA DE LA FACTURA SALEN LOS ÍTEMS DE UNA NC DE DEVOLUCIÓN.
 *
 * InfoManager, 22/09/2026, rechazando la primera NC real por v2: *"Elegí los ítems de la factura
 * con «Ítems remitidos» o «Ítems sin remitir» antes de grabar"*. Es `cod_control`, y el spec
 * avisa por qué no tiene default: *"Decide contra qué disponible se controla cada cantidad, así
 * que no se asume"*.
 *
 * 🔑 NO SE ADIVINA: sale de lo que registramos al emitir. Si la factura tiene su remito, la
 * mercadería se remitió (`C_RE`); si se emitió sin remito, no (`S_RE`). Es el mismo registro que
 * sostiene la hoja de ruta.
 *
 * 🪤 `null` = la factura no salió de la app (la hizo alguien a mano en IM) y no tenemos con qué
 * decidir. Ahí la nota se va por v1, que no pide esta cubeta — mandar la equivocada haría que IM
 * controle las cantidades contra un disponible que no es el de esta mercadería.
 */
async function cubetaDeLaFactura(imFacturaId: string): Promise<CodControl | null> {
  try {
    const { data, error } = await sb().from('presupuestos_facturados')
      .select('im_remito_id').eq('tenant_id', TENANT_ID).eq('im_factura_id', String(imFacturaId)).maybeSingle();
    if (error || !data) return null;
    return (data as any).im_remito_id ? 'C_RE' : 'S_RE';
  } catch { return null; }
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
  /**
   * Sólo la NC de devolución lleva cubeta: la financiera (FI) y la de cotización (DC) no mueven
   * mercadería, así que no hay nada contra qué controlar cantidades.
   *
   * 🪤 Va ANTES del `try`: una excepción acá adentro se reporta como "no sé si salió" y bloquea
   * el reintento, y esto ni siquiera llegó a hablar con InfoManager.
   */
  let codControl: CodControl | undefined;
  if (c.tipo === 'NC' && c.subtipo === 'DE') {
    const cubeta = await cubetaDeLaFactura(o.im_factura_id);
    if (!cubeta) return emitirNotaCredito(d);
    codControl = cubeta;
  }
  /**
   * 🔑 LA DEVOLUCIÓN REINGRESA EL STOCK. Mati (22/09/2026): *"lo ideal es que esa nc sí reingrese
   * stock, sería lo correcto"*.
   *
   * El remito ya descontó esa mercadería, y una NC de devolución dice que no salió —sea porque el
   * cliente la devolvió o porque nunca se cargó al camión—. Sin esto el depósito queda con menos
   * de lo que tiene y alguien lo corrige a mano cuando no cuadra el inventario.
   *
   * 🪤 Sólo con `C_RE`: sin remito nunca se descontó nada, así que no hay nada que reingresar, y
   * la API lo rechaza igual (ver la validación de `emitirNotaV2`).
   *
   * 🪤 El camino v1 sigue mandando `genero_re_auto: 'N'` y NO reingresa. Es el de respaldo: si una
   * nota se va por ahí —factura hecha a mano en IM, o el interruptor apagado— el stock hay que
   * devolverlo en InfoManager.
   */
  const reingresaStock = codControl === 'C_RE';
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
      ...(codControl ? { cod_control: codControl } : {}),
      ...(reingresaStock ? { genero_re_auto: true } : {}),
      factura: { im_id: o.im_factura_id },
      cod_deposito: d.cod_deposito ?? null,
      items: (d.items ?? []).map((it: any) => ({
        cod_articulo: Number(it.cod_articulo),
        cantidad: Number(it.cantidad),
        precio: it.precio != null ? Number(it.precio) : null,
        descuento_porc: it.descuento_porc != null ? Number(it.descuento_porc) : null,
      })),
      idempotencyKey: claveIdempotente(o.id, o.indice),
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
