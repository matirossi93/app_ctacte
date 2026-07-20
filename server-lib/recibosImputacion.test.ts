import { describe, it, expect } from 'vitest';
import { ajustarImputacionIM, validarContraPendientes, TOLERANCIA_AJUSTE_IM } from './recibosImputacion.js';

describe('ajustarImputacionIM', () => {
  it('la tolerancia documentada es $5', () => {
    expect(TOLERANCIA_AJUSTE_IM).toBe(5);
  });

  // ── Caso feliz ────────────────────────────────────────────────────────────
  it('montos enteros exactos: no ajusta nada', () => {
    const r = ajustarImputacionIM(895770, [895770]);
    expect(r).toEqual({ ok: true, comprobantesEnteros: [895770], pagoTotal: 895770, ajusteTotal: 0 });
  });

  it('caso real de producción: $895770.25 trunca a 895770 con ajuste 0.25', () => {
    const r = ajustarImputacionIM(895770.25, [895770.25]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.comprobantesEnteros).toEqual([895770]);
      expect(r.pagoTotal).toBe(895770);
      expect(r.ajusteTotal).toBe(0.25);
    }
  });

  it('varios comprobantes con centavos: trunca cada uno, ajuste = suma de decimales perdidos', () => {
    const r = ajustarImputacionIM(601.0, [300.4, 200.3, 100.3]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.comprobantesEnteros).toEqual([300, 200, 100]);
      expect(r.pagoTotal).toBe(600);
      expect(r.ajusteTotal).toBe(1.0);
    }
  });

  it('robusto ante error de punto flotante (0.1+0.2): no falla la comparación de diferencia', () => {
    const r = ajustarImputacionIM(30.3, [10.1, 20.2]); // 10.1+20.2 = 30.299999...
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.comprobantesEnteros).toEqual([10, 20]);
      expect(r.pagoTotal).toBe(30);
      expect(r.ajusteTotal).toBe(0.3);
    }
  });

  // ── Tolerancia $5 (borde) ──────────────────────────────────────────────────
  it('diferencia de exactamente $5 se acepta (no excede la tolerancia)', () => {
    const r = ajustarImputacionIM(1005, [1000]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pagoTotal).toBe(1000);
      expect(r.ajusteTotal).toBe(5);
    }
  });

  it('diferencia > $5 (pagos de más) se rechaza con mensaje claro', () => {
    const r = ajustarImputacionIM(1006, [1000]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('Excede tolerancia $5');
      expect(r.error).toContain('$6.00');
    }
  });

  it('diferencia negativa > $5 (pagos de menos) también se rechaza', () => {
    const r = ajustarImputacionIM(1000, [1010]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Excede tolerancia');
  });

  // ── Truncado a $0 ──────────────────────────────────────────────────────────
  it('un único comprobante que trunca a $0 se rechaza (IM exige > 0)', () => {
    const r = ajustarImputacionIM(0.95, [0.95]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Importe demasiado chico');
  });

  it('un comprobante de centavos entre varios queda en $0 → se rechaza', () => {
    const r = ajustarImputacionIM(101.0, [100.5, 0.5]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Mínimo $1 por factura');
  });

  it('comprobante de exactamente $1.00 es válido (no se rechaza)', () => {
    const r = ajustarImputacionIM(1.0, [1.0]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.comprobantesEnteros).toEqual([1]);
  });

  // ── No muta los inputs ─────────────────────────────────────────────────────
  it('no muta el array de comprobantes recibido', () => {
    const input = [300.4, 200.3];
    const copia = [...input];
    ajustarImputacionIM(500.7, input);
    expect(input).toEqual(copia);
  });
});

describe('validarContraPendientes', () => {
  // Shape mínimo de una fila de /reportes/comprob_pendientes_clientes
  const pend = (id: number | string, saldo: number | null, importe_factura?: number) =>
    ({ id, saldo, importe_factura: importe_factura ?? null });

  // ── Caso feliz ────────────────────────────────────────────────────────────
  it('factura pendiente con saldo suficiente → ok', () => {
    const r = validarContraPendientes(
      [{ id: '58149677', importe_a_pagar: '160600.00' }],
      [pend(58149677, 290575.78353)],
    );
    expect(r).toEqual({ ok: true });
  });

  it('matchea id numérico de IM contra id string del body', () => {
    const r = validarContraPendientes(
      [{ id: '123', importe_a_pagar: 100 }],
      [pend(123, 100)],
    );
    expect(r.ok).toBe(true);
  });

  it('sin comprobantes a imputar → ok (la validación de "al menos uno" es aparte)', () => {
    expect(validarContraPendientes([], [pend(1, 100)]).ok).toBe(true);
  });

  // ── Incidente HASAN 18/07/2026: el recibo "fallido" (timeout) sí había
  //    entrado en IM y la factura ya no tenía saldo completo ─────────────────
  it('caso real HASAN: imputar $160.600 cuando el saldo restante es $129.975,78 → rechaza', () => {
    const r = validarContraPendientes(
      [{ id: '58149677', importe_a_pagar: '160600.00' }],
      [pend(58149677, 129975.78353)],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('saldo pendiente');
  });

  it('la factura ya no está entre los pendientes (imputada entera) → rechaza con aviso', () => {
    const r = validarContraPendientes(
      [{ id: '58149677', importe_a_pagar: '160600.00' }],
      [pend(99999999, 500000)],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('ya NO está pendiente');
  });

  // ── Bordes de saldo ───────────────────────────────────────────────────────
  it('importe dentro de la tolerancia de $5 sobre el saldo → ok (redondeos de IM)', () => {
    const r = validarContraPendientes(
      [{ id: '1', importe_a_pagar: 129976 }],
      [pend(1, 129975.78)],
    );
    expect(r.ok).toBe(true);
  });

  it('importe que excede saldo + tolerancia → rechaza', () => {
    const r = validarContraPendientes(
      [{ id: '1', importe_a_pagar: 129981 }],
      [pend(1, 129975.78)],
    );
    expect(r.ok).toBe(false);
  });

  it('saldo negativo (NC) se compara en valor absoluto, como hace el frontend', () => {
    const r = validarContraPendientes(
      [{ id: '7', importe_a_pagar: 5000 }],
      [pend(7, -5000)],
    );
    expect(r.ok).toBe(true);
  });

  it('saldo null cae a importe_factura (fallback del frontend)', () => {
    const r = validarContraPendientes(
      [{ id: '7', importe_a_pagar: 5000 }],
      [pend(7, null, 5000)],
    );
    expect(r.ok).toBe(true);
  });

  // ── Varios comprobantes: uno solo inválido tumba todo el recibo ───────────
  it('con varias facturas, si UNA ya no está pendiente se rechaza el recibo entero', () => {
    const r = validarContraPendientes(
      [
        { id: '1', importe_a_pagar: 100 },
        { id: '2', importe_a_pagar: 200 },
      ],
      [pend(1, 100)],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('#2');
  });
});
