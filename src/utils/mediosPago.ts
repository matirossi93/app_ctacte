// Espejo frontend de la definición canónica server-lib/mediosPago.ts.
// Mantener sincronizado. El backend es la fuente de verdad.

export interface MedioPagoUI {
  value: string;
  label: string;
  /** ¿Hace falta la foto del comprobante? Ver el porqué en server-lib/mediosPago.ts. */
  exige_foto: boolean;
}

export const MEDIOS_PAGO_UI: MedioPagoUI[] = [
  { value: 'mercadopago',   label: 'MercadoPago',          exige_foto: true },
  { value: 'recaudadora_1', label: 'Cuenta Recaudadora 1', exige_foto: true },
  { value: 'recaudadora_2', label: 'Cuenta Recaudadora 2', exige_foto: true },
  { value: 'banco_nacion',  label: 'Banco Nación',         exige_foto: true },
  { value: 'efectivo',      label: 'Efectivo',             exige_foto: false },
  { value: 'cheque',        label: 'Cheque',               exige_foto: true },
];

/** ¿Hay que exigir la foto? El default es SÍ: sin saber el medio, no se afloja el respaldo. */
export function exigeFotoUI(medio: string | null | undefined): boolean {
  const m = MEDIOS_PAGO_UI.find(x => x.value === String(medio ?? '').toLowerCase());
  return m ? m.exige_foto : true;
}

export const DEFAULT_MEDIO_UI = 'mercadopago';

const validValues = new Set(MEDIOS_PAGO_UI.map(m => m.value));

// Si el valor persistido no está en los 5 nuevos (ej. 'transferencia' legacy),
// devuelve el default. Evita que un select quede con value "" / indefinido.
export function normalizeMedioUI(medio: string | null | undefined): string {
  const m = (medio ?? '').toLowerCase();
  return validValues.has(m) ? m : DEFAULT_MEDIO_UI;
}
