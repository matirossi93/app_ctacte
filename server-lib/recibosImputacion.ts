// Lógica PURA del ajuste de importes de un recibo antes de postearlo a
// InfoManager. Aislada en su propio módulo (sin imports con efectos secundarios)
// para poder testearla sin arrastrar supabase/infomanager/ocr, que hacen
// process.exit() si falta una env var.
//
// Contexto del quirk de IM: la API trunca silenciosamente
// `comprobantes.importe_a_pagar` a entero y después valida que la suma de pagos
// sea igual a la suma de comprobantes. Si le mandamos decimales, RECHAZA el
// recibo entero (error real visto en prod: "pagos [895770.25] != facturas
// [895770]"). Solución: truncar AMBOS lados a entero antes del POST — floor en
// comprobantes para no superar el saldo, y el pago se iguala a esa suma. La
// diferencia chica (≤ tolerancia) se absorbe como crédito implícito.
// Usado por server-lib/recibos.ts (aprobarRecibo).

/**
 * Máxima diferencia (en $) tolerada entre la suma de pagos y la de comprobantes
 * que se absorbe automáticamente. Por encima, se rechaza para ajuste manual.
 */
export const TOLERANCIA_AJUSTE_IM = 5;

export type AjusteImputacionResult =
  | { ok: true; comprobantesEnteros: number[]; pagoTotal: number; ajusteTotal: number }
  | { ok: false; error: string };

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Calcula los importes ENTEROS a mandar a IM a partir de la suma de pagos
 * original (con decimales) y el importe a imputar de cada comprobante (con
 * decimales). No muta los inputs.
 *
 * - Si la diferencia |pagos - comprobantes| supera TOLERANCIA_AJUSTE_IM → error
 *   (probable carga mal hecha; mejor que IM rechace con un 502 enmascarado).
 * - Trunca cada comprobante con Math.floor (nunca redondea hacia arriba: IM
 *   rechaza si el importe supera el saldo de la factura).
 * - El pago total se iguala a la suma de comprobantes truncados.
 * - Si algún comprobante (o el total) queda en 0 tras truncar → error (IM
 *   rechaza "el valor debe ser mayor a 0").
 * - `ajusteTotal` = los pesos/centavos que el cliente pagó pero IM no imputa.
 */
/**
 * Valida los comprobantes a imputar contra los pendientes VIGENTES del cliente
 * en IM (re-consultados al momento de aprobar, no los del modal que pueden
 * tener minutos de antigüedad).
 *
 * Contexto (incidente HASAN 18/07/2026): un POST /recibo que "falló" por
 * timeout puede haberse procesado igual del lado de IM, y también puede haber
 * una carga manual paralela en el escritorio. En ambos casos la factura deja
 * de estar pendiente (o le queda menos saldo), pero IM ACEPTA sobre-imputarla
 * sin chuchear — el duplicado queda silencioso. Este chequeo lo corta antes
 * del POST.
 *
 * - Comprobante ausente de los pendientes → ya se imputó entero: rechazar.
 * - Saldo restante < importe a imputar (fuera de tolerancia) → alguien ya lo
 *   pagó en parte: rechazar.
 * - El saldo se toma como |saldo| con fallback a |importe_factura|, igual que
 *   el frontend (RecibosApp): las NC vienen con signo negativo.
 */
export type ValidacionPendientesResult = { ok: true } | { ok: false; error: string };

export interface PendienteIM {
  id: string | number;
  saldo?: number | null;
  importe_factura?: number | null;
}

export function validarContraPendientes(
  comprobantes: Array<{ id: string; importe_a_pagar: string | number }>,
  pendientes: PendienteIM[],
): ValidacionPendientesResult {
  const porId = new Map(pendientes.map(p => [String(p.id), p]));
  for (const c of comprobantes) {
    const p = porId.get(String(c.id));
    if (!p) {
      return {
        ok: false,
        error: `El comprobante #${c.id} ya NO está pendiente en IM — puede que ya se haya imputado (un reintento tras timeout que sí entró, o una carga manual en el escritorio). Verificá la cta cte del cliente en IM antes de volver a intentar.`,
      };
    }
    const saldo = Math.abs(Number(p.saldo ?? p.importe_factura ?? 0));
    const importe = Number(c.importe_a_pagar);
    if (importe > saldo + TOLERANCIA_AJUSTE_IM) {
      return {
        ok: false,
        error: `El comprobante #${c.id} tiene saldo pendiente $${saldo.toFixed(2)} en IM pero se intenta imputar $${importe.toFixed(2)} — otro recibo ya lo pagó en parte (¿reintento tras timeout o carga manual?). Verificá la cta cte del cliente en IM.`,
      };
    }
  }
  return { ok: true };
}

export function ajustarImputacionIM(sumPagos: number, comprobantes: number[]): AjusteImputacionResult {
  const sumComp = comprobantes.reduce((a, c) => a + c, 0);
  const diff = round2(sumPagos - sumComp);
  if (Math.abs(diff) > TOLERANCIA_AJUSTE_IM) {
    return {
      ok: false,
      error: `Diferencia entre pagos ($${sumPagos.toFixed(2)}) y comprobantes ($${sumComp.toFixed(2)}) es $${diff.toFixed(2)}. Excede tolerancia $${TOLERANCIA_AJUSTE_IM} — ajustá importes manualmente.`,
    };
  }

  const comprobantesEnteros = comprobantes.map(c => Math.floor(c));
  const pagoTotal = comprobantesEnteros.reduce((a, c) => a + c, 0);
  const ajusteTotal = round2(sumPagos - pagoTotal);

  if (comprobantesEnteros.some(c => c <= 0) || pagoTotal <= 0) {
    return {
      ok: false,
      error: 'Importe demasiado chico para imputar: después del redondeo a entero (IM trunca decimales) quedaría en $0. Mínimo $1 por factura. Si es un recibo de prueba, usá un monto ≥ $1.',
    };
  }

  return { ok: true, comprobantesEnteros, pagoTotal, ajusteTotal };
}
