/** ID interno IM utilizable, sin coerción de objetos, booleanos o números inseguros. */
export function idIM(v: unknown): string | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? String(v) : null;
  if (typeof v !== 'string' || !/^[0-9]+$/.test(v) || !/[1-9]/.test(v)) return null;
  return v.replace(/^0+/, '');
}
/** Diferencia entre IVA cero explícito y dato desconocido. */
export function ivaExplicita(v: unknown): number | null {
  if ((typeof v !== 'number' && typeof v !== 'string') || v === '' || (typeof v === 'string' && !v.trim())) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}
