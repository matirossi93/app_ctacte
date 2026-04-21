// Helpers de ventas InfoManager.
//
// Reglas de signo para el AVANCE del objetivo mensual:
//   FA (Factura)          → SUMA
//   NC (Nota de Crédito)  → RESTA (viene con fa_total positivo — negarla acá)
//   ND (Nota de Débito)   → IGNORAR (no se cuenta como venta).
//                           Semillero emite NDs por intereses de mora, no por ventas,
//                           así que distorsionan el cumplimiento. Sí aparecen en
//                           cuenta corriente / cobranzas (otro pipeline).
//   Resto (RC, RE, PR, ASD, ASH, anuladas, etc.) → 0.
//
// Si rompés este signo, rompés todo el cálculo de cumplimiento.

export type TipoComprobante =
  | 'FA' | 'NC' | 'ND'
  | 'RC' | 'RE' | 'PR' | 'IR' | 'ASD' | 'ASH' | string;

export interface Comprobante {
  tipo?: TipoComprobante;
  tipo_comprobante?: TipoComprobante;
  fa_total?: number | string | null;
  total?: number | string | null;
  anulada?: 'S' | 'N' | string | null;
  cod_vendedor?: number | null;
  cod_cliente?: number | null;
  fa_fecha?: string;
  fecha?: string;
}

const toNumber = (v: unknown): number => {
  if (v == null) return 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  const n = Number(String(v).replace(/\./g, '').replace(',', '.'));
  return isFinite(n) ? n : 0;
};

export function tipoComprobante(c: Comprobante): string {
  return String(c.tipo ?? c.tipo_comprobante ?? '').toUpperCase();
}

export function isAnulada(c: Comprobante): boolean {
  return String(c.anulada ?? '').toUpperCase() === 'S';
}

export function computeVentaNeta(c: Comprobante): number {
  if (isAnulada(c)) return 0;
  const tipo = tipoComprobante(c);
  const total = toNumber(c.fa_total ?? c.total);
  if (tipo === 'FA') return total;
  if (tipo === 'NC') return -total;
  // ND y cualquier otro tipo se excluyen del avance.
  return 0;
}

export interface AggKey { year: number; month: number; }

export function monthKey(dateStr?: string): AggKey | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}
