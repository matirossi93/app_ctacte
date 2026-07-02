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
