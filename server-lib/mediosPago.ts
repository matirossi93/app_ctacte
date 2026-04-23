// Definición canónica de medios de pago (server-side).
// Espejo en src/utils/mediosPago.ts para el frontend (sin env).

const { env } = process;

export type FormaPagoIM = 'EF' | 'TJ' | 'OT';

export interface MedioPago {
  value: string;           // clave técnica persistida en DB y enviada al backend
  label: string;           // texto visible en la UI
  forma_pago_im: FormaPagoIM;
  cuenta_env_var: string;  // nombre de la variable de entorno con el cod_cuenta InfoManager
}

export const MEDIOS_PAGO: MedioPago[] = [
  { value: 'mercadopago',   label: 'MercadoPago',           forma_pago_im: 'OT', cuenta_env_var: 'IM_CUENTA_MERCADOPAGO' },
  { value: 'recaudadora_1', label: 'Cuenta Recaudadora 1',  forma_pago_im: 'OT', cuenta_env_var: 'IM_CUENTA_RECAUDADORA_1' },
  { value: 'recaudadora_2', label: 'Cuenta Recaudadora 2',  forma_pago_im: 'OT', cuenta_env_var: 'IM_CUENTA_RECAUDADORA_2' },
  { value: 'efectivo',      label: 'Efectivo',              forma_pago_im: 'EF', cuenta_env_var: 'IM_CUENTA_EFECTIVO' },
  { value: 'cheque',        label: 'Cheque',                forma_pago_im: 'OT', cuenta_env_var: 'IM_CUENTA_CHEQUE' },
];

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
