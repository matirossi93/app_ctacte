// Helpers de ventas InfoManager.
// NC y ND vienen con fa_total positivo pero RESTAN al neto — negarlos acá
// es la única fuente de verdad de la app. Si rompés el signo, rompés todo
// el cálculo de cumplimiento de objetivos.

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
  const sign = (tipo === 'NC' || tipo === 'ND') ? -1 : 1;
  if (tipo !== 'FA' && tipo !== 'NC' && tipo !== 'ND') return 0;
  return total * sign;
}

export interface AggKey { year: number; month: number; }

export function monthKey(dateStr?: string): AggKey | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}
