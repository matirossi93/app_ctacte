import { createHash, randomUUID } from 'node:crypto';
import { sb, TENANT_ID } from './supabase.js';

export class ErrorVersion extends Error {
  constructor(message: string, public status = 409) { super(message); }
}
/** Misma representación para /ventas, detalle y renglones del día; incluye identidad del PR. */
export function huellaPresupuesto(id: string, cab: any, items: any[]): string {
  const texto = (v: unknown) => String(v ?? '').trim();
  const n = (v: unknown) => Number(v ?? 0);
  const filas = items.map(i => [n(i.cod_articulo), n(i.cantidad), n(i.precio_orig) || n(i.precio),
    n(i.descuento_porc), n(i.cod_lista_precios), n(i.iva_por), n(i.cod_articulo) > 0 ? '' : texto(i.detalle)])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash('sha256').update(JSON.stringify({ id, fecha: texto(cab.fecha).slice(0, 10),
    cliente: n(cab.cod_cliente), empresa: n(cab.cod_empresa), vendedor: n(cab.cod_vendedor),
    observaciones: texto(cab.observaciones), filas })).digest('hex');
}
export function exigirHuella(esperada: unknown, actual: string) {
  if (typeof esperada !== 'string' || esperada !== actual) throw new ErrorVersion('El presupuesto cambió o falta su versión. Actualizá y revisalo antes de continuar.');
}
export function exigirTipoEmpresa(cab: any, tipo: 'PR' | 'FA') {
  if (String(cab.tipo_comprobante ?? '').trim().toUpperCase() !== tipo ||
      Number(cab.cod_empresa) !== Number(process.env.PEDIDO_EMPRESA_DEFAULT || 1)) {
    throw new ErrorVersion(`El comprobante no es ${tipo} de Casa Central. No se modificó nada.`);
  }
}
export async function bloquearPresupuesto(id: string, actividad: string): Promise<string> {
  const token = randomUUID();
  const { data, error } = await sb().rpc('reclamar_presupuesto', { p_tenant: TENANT_ID, p_id: id, p_token: token, p_actividad: actividad });
  if (error) throw new ErrorVersion(`No pude bloquear el presupuesto: ${error.message}. Verificá la migración 039.`, 503);
  if (data !== true) throw new ErrorVersion('Este presupuesto tiene una operación en curso o por verificar. No se modificó nada.');
  return token;
}
export async function desbloquearPresupuesto(id: string, token: string) {
  const { error } = await sb().rpc('soltar_presupuesto', { p_tenant: TENANT_ID, p_id: id, p_token: token });
  if (error) console.error('[presupuestos] no pude liberar la operación:', error.message);
}
export async function invalidarAprobacion(id: string) {
  const { error } = await sb().from('presupuestos_revision').delete().eq('tenant_id', TENANT_ID).eq('im_comprobante_id', id);
  if (error) throw new ErrorVersion(`No pude quitar la aprobación: ${error.message}. No se modificó InfoManager.`, 503);
}

/** Sólo una respuesta explícita de rechazo permite liberar el lock tras intentar escribir. */
export function rechazoEdicionConfirmado(r: { ok: boolean; raw?: any; sinRespuesta?: boolean }): boolean {
  if (r.ok || r.sinRespuesta === true) return false;
  // isCreated=false del endpoint PR también devuelve el PR preexistente ante colisión.
  return r.raw?.isCreated === false || (r.raw?.isUpdated === false && !r.raw?.id && !r.raw?.venta?.id);
}
