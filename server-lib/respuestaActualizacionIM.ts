import { idIM } from './identidadIM.js';
/** No interpretar un HTTP 200 vacío como escritura confirmada. */
export function interpretarActualizacionIM(data: any): { ok: true; raw: any } | { ok: false; error: string; raw: any; sinRespuesta: boolean } {
  const id = data?.id ?? data?.venta?.id;
  const error = String(data?.detalles ?? data?.mensaje ?? 'InfoManager no confirmó la actualización. Verificá el comprobante antes de continuar.');
  const rechazo = data?.isUpdated === false;
  const errorDeclarado = data?.error != null && Number(data.error) !== 0;
  if ((id == null || idIM(id) !== null) && !rechazo && !errorDeclarado && (data?.isUpdated === true || (data?.error != null && Number(data.error) === 0) || (idIM(id) !== null))) {
    return { ok: true, raw: data };
  }
  return { ok: false, error, raw: data, sinRespuesta: !(rechazo && !id) };
}
