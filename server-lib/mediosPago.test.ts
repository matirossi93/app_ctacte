import { describe, it, expect } from 'vitest';
import { exigeFoto, MEDIOS_PAGO } from './mediosPago.js';

/**
 * 16/09/2026 — Mati pidió que el recibo en PDF reemplace al talonario de papel. Pero la app
 * exigía una foto para crear el recibo: si el vendedor deja de escribir el papel, no tiene qué
 * fotografiar y el circuito se traba justo en el paso que se quería eliminar.
 *
 * La regla que eligió Mati: **la foto sigue siendo obligatoria donde ES la prueba del pago**
 * (transferencias, MercadoPago, cheque) y deja de serlo en efectivo, donde el comprobante lo
 * emite la empresa.
 */
describe('¿hace falta la foto del comprobante?', () => {
    it('🔴 en EFECTIVO no: el recibo que emite la app es el comprobante', () => {
        expect(exigeFoto('efectivo')).toBe(false);
    });

    it('🔴 en transferencias y MercadoPago SÍ: la captura del pago es la prueba', () => {
        expect(exigeFoto('mercadopago')).toBe(true);
        expect(exigeFoto('banco_nacion')).toBe(true);
        expect(exigeFoto('recaudadora_1')).toBe(true);
        expect(exigeFoto('recaudadora_2')).toBe(true);
    });

    it('🔴 en CHEQUE sí: la foto tiene el número, el banco y la fecha de cobro', () => {
        expect(exigeFoto('cheque')).toBe(true);
    });

    it('🪤 sin medio de pago, o con uno desconocido, se pide igual', () => {
        // No saber cómo pagó no es razón para aflojar el respaldo.
        for (const m of [null, undefined, '', 'transferencia_vieja', 'cripto']) {
            expect(exigeFoto(m as any)).toBe(true);
        }
    });

    it('todos los medios declaran si exigen foto: ninguno queda indefinido', () => {
        for (const m of MEDIOS_PAGO) expect(typeof m.exige_foto).toBe('boolean');
    });
});
