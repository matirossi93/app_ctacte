// Espejo frontend de la definición canónica server-lib/mediosPago.ts.
// Mantener sincronizado. El backend es la fuente de verdad.

export interface MedioPagoUI {
  value: string;
  label: string;
}

export const MEDIOS_PAGO_UI: MedioPagoUI[] = [
  { value: 'mercadopago',   label: 'MercadoPago' },
  { value: 'recaudadora_1', label: 'Cuenta Recaudadora 1' },
  { value: 'recaudadora_2', label: 'Cuenta Recaudadora 2' },
  { value: 'banco_nacion',  label: 'Banco Nación' },
  { value: 'efectivo',      label: 'Efectivo' },
  { value: 'cheque',        label: 'Cheque' },
];

export const DEFAULT_MEDIO_UI = 'mercadopago';

const validValues = new Set(MEDIOS_PAGO_UI.map(m => m.value));

// Si el valor persistido no está en los 5 nuevos (ej. 'transferencia' legacy),
// devuelve el default. Evita que un select quede con value "" / indefinido.
export function normalizeMedioUI(medio: string | null | undefined): string {
  const m = (medio ?? '').toLowerCase();
  return validValues.has(m) ? m : DEFAULT_MEDIO_UI;
}
