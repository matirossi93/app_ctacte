/**
 * Constantes compartidas del ciclo de vida de comprobantes_pago (recibos).
 *
 * Viven en este módulo SIN side-effects de import (y no directamente en
 * recibos.ts) porque recibos.ts valida env vars a nivel módulo y hace
 * process.exit(1) si faltan — importarlo desde la lógica pura de conciliación
 * mataría los tests unitarios. recibos.ts re-exporta estas constantes, así que
 * quien ya importa recibos.ts puede seguir usándolas desde ahí.
 * Mismo patrón que comisionesShared.ts.
 */

/**
 * Estados válidos de comprobantes_pago. DEBE coincidir con el CHECK de
 * supabase/migrations/001_panel_vendedor.sql (líneas 179-180):
 *   check (status in ('pendiente_revision','aprobado','imputado','rechazado','error'))
 */
export const RECIBO_STATUSES = ['pendiente_revision', 'aprobado', 'imputado', 'rechazado', 'error'] as const;

export type ReciboStatus = typeof RECIBO_STATUSES[number];

/**
 * Prefijo con el que caducarRecibosPendientes (recibos.ts) marca en error_msg
 * los recibos que pasaron >30 días en pendiente_revision sin imputar. Un
 * status='error' con este prefijo es basura por depurar, NO un rechazo real
 * de IM — la conciliación los separa por esto.
 */
export const CADUCADO_PREFIX = '[CADUCADO]';

/**
 * Parsea el monto que llega en el upload de un recibo.
 *
 * Bug auditoría 22-jul (monto ×100): el front (cleanMonto en RecibosApp) ya
 * normaliza a punto decimal ('1.500,50' → '1500.50'), pero el server volvía a
 * parsear asumiendo formato AR: borraba el punto y grababa 150050. Este parser
 * distingue ambos formatos:
 *   - hay coma            → formato AR: puntos son miles, coma es decimal.
 *   - solo punto, con 1-2 decimales → decimal canónico del front ('1500.50').
 *   - solo punto, otro patrón       → miles ('15.000', '1.500.000') o el caso
 *     front-mangled '1.500000' (cleanMonto colapsa multi-punto): en ARS no
 *     existen >2 decimales, así que se tratan como miles.
 */
export function parseMontoUpload(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  let v = String(raw).replace(/[^\d.,]/g, '');
  if (!v) return null;
  if (v.includes(',')) {
    v = v.replace(/\./g, '').replace(',', '.');
  } else if (v.includes('.') && !/^\d+\.\d{1,2}$/.test(v)) {
    v = v.replace(/\./g, '');
  }
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
