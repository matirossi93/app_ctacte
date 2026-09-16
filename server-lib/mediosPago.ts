// Definición canónica de medios de pago (server-side).
// Espejo en src/utils/mediosPago.ts para el frontend (sin env).

const { env } = process;

export type FormaPagoIM = 'EF' | 'TJ' | 'OT';

export interface MedioPago {
  value: string;           // clave técnica persistida en DB y enviada al backend
  label: string;           // texto visible en la UI
  forma_pago_im: FormaPagoIM;
  cuenta_env_var: string;  // nombre de la variable de entorno con el cod_cuenta InfoManager
  /**
   * ¿Hace falta la foto del comprobante para cargarlo?
   *
   * Mati (16/09/2026), al reemplazar el talonario de papel por el recibo en PDF: la foto sigue
   * siendo obligatoria **donde ES la prueba del pago** —una transferencia, un pago de
   * MercadoPago, un cheque— y deja de serlo en efectivo, donde el comprobante lo emite la
   * empresa y no hay nada que fotografiar.
   */
  exige_foto: boolean;
}

export const MEDIOS_PAGO: MedioPago[] = [
  { value: 'mercadopago',   label: 'MercadoPago',           forma_pago_im: 'OT', cuenta_env_var: 'IM_CUENTA_MERCADOPAGO',   exige_foto: true },
  { value: 'recaudadora_1', label: 'Cuenta Recaudadora 1',  forma_pago_im: 'OT', cuenta_env_var: 'IM_CUENTA_RECAUDADORA_1', exige_foto: true },
  { value: 'recaudadora_2', label: 'Cuenta Recaudadora 2',  forma_pago_im: 'OT', cuenta_env_var: 'IM_CUENTA_RECAUDADORA_2', exige_foto: true },
  { value: 'banco_nacion',  label: 'Banco Nación',          forma_pago_im: 'OT', cuenta_env_var: 'IM_CUENTA_BANCO_NACION',  exige_foto: true },
  // El único sin foto: el recibo que emite la app ES el comprobante.
  { value: 'efectivo',      label: 'Efectivo',              forma_pago_im: 'EF', cuenta_env_var: 'IM_CUENTA_EFECTIVO',      exige_foto: false },
  // El cheque sí: la foto tiene el número, el banco y la fecha de cobro.
  { value: 'cheque',        label: 'Cheque',                forma_pago_im: 'OT', cuenta_env_var: 'IM_CUENTA_CHEQUE',        exige_foto: true },
];

/**
 * ¿Hay que exigir la foto del comprobante para este medio de pago?
 *
 * 🪤 El default es SÍ: no saber cómo pagó no es razón para aflojar el respaldo. Sólo se afloja
 * en los medios que lo declaran explícitamente.
 */
export function exigeFoto(medio: string | null | undefined): boolean {
  const m = byValue.get(String(medio ?? '').toLowerCase());
  return m ? m.exige_foto : true;
}

export const DEFAULT_MEDIO = 'mercadopago';

const byValue = new Map<string, MedioPago>(MEDIOS_PAGO.map(m => [m.value, m]));

export function isValidMedio(medio: string | null | undefined): boolean {
  return !!medio && byValue.has(medio);
}

// Normaliza un medio legacy (transferencia, otro, tarjeta) al nuevo canon.
// Preserva el flow para recibos creados antes del refactor.
export function normalizeMedio(medio: string | null | undefined): string {
  const m = (medio ?? '').toLowerCase();
  if (byValue.has(m)) return m;
  // Legacy: transferencia/otro → mercadopago (canal más común). tarjeta no se usa.
  return DEFAULT_MEDIO;
}

export function getCuentaCod(medio: string | null | undefined): string {
  const m = normalizeMedio(medio);
  const def = byValue.get(m)!;
  return env[def.cuenta_env_var] || '';
}

export function getFormaPagoIM(medio: string | null | undefined): FormaPagoIM {
  const m = normalizeMedio(medio);
  return byValue.get(m)!.forma_pago_im;
}
