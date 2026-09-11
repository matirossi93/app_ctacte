import { idIM } from './identidadIM.js';
/**
 * IM confirma el PUT que sale bien con **HTTP 200 y `content-type: text/plain`**, no con JSON:
 * el cuerpo es literalmente "El registro se actualizó correctamente." (medido el 11/09/2026
 * contra `/ventas/{id}`). Los errores sí vienen en JSON, y encima con 404 o 500, así que ni
 * siquiera llegan hasta acá — los levanta el catch de axios.
 *
 * 🪤 Sin esto, buscar `isUpdated` / `id` / `error` en un string no encuentra nada y TODA
 * actualización exitosa se leía como fallo. El 11/09 el vendedor Julio agregó productos a un
 * presupuesto: el nuevo se creó, el viejo se anuló bien, y la app igual le dijo que habían
 * quedado los dos vivos y que avisara a la oficina.
 */
/**
 * 🔴 LA CONFIRMACIÓN TIENE QUE SER EL CUERPO ENTERO, NO UN FRAGMENTO.
 *
 * Astra (11/09/2026): la primera versión buscaba *"se actualizó correctamente"* en cualquier
 * parte del texto, sin anclar. Eso acepta como éxito la frase que dice exactamente lo
 * contrario —**"NO se actualizó correctamente"**— y cualquier HTML o respuesta que cite la
 * confirmación antes de explicar un error.
 *
 * Leer un rechazo como éxito es peor que el bug que esto vino a arreglar: aquél avisaba de más
 * y alguien iba a mirar; éste da por guardado lo que no se guardó, y nadie mira nunca.
 *
 * Se aceptan sólo las dos confirmaciones completas que IM devuelve, con acento o sin él —los
 * espacios se normalizan y el punto final es opcional—. Cualquier otro string sigue siendo
 * incertidumbre.
 */
const CONFIRMACION_EN_TEXTO = /^(?:el registro se actualiz[óo]|los registros se actualizaron) correctamente\.?$/i;

/** Espacios, saltos de línea y tabulaciones colapsados a uno solo, y sin bordes. */
const normalizar = (t: string) => t.replace(/\s+/g, ' ').trim();

/** No interpretar un HTTP 200 vacío como escritura confirmada. */
export function interpretarActualizacionIM(data: any): { ok: true; raw: any } | { ok: false; error: string; raw: any; sinRespuesta: boolean } {
  if (typeof data === 'string' && CONFIRMACION_EN_TEXTO.test(normalizar(data))) return { ok: true, raw: data };
  const id = data?.id ?? data?.venta?.id;
  const error = String(data?.detalles ?? data?.mensaje ?? 'InfoManager no confirmó la actualización. Verificá el comprobante antes de continuar.');
  const rechazo = data?.isUpdated === false;
  const errorDeclarado = data?.error != null && Number(data.error) !== 0;
  if ((id == null || idIM(id) !== null) && !rechazo && !errorDeclarado && (data?.isUpdated === true || (data?.error != null && Number(data.error) === 0) || (idIM(id) !== null))) {
    return { ok: true, raw: data };
  }
  return { ok: false, error, raw: data, sinRespuesta: !(rechazo && !id) };
}
