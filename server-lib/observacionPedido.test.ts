import { describe, it, expect, vi } from 'vitest';
// infomanager.ts corta el proceso al importarse si falta el secret (mismo patrón que
// fechaArgentina.test.ts y cartera.test.ts).
vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });

import { observacionParaIM } from './pedidos.js';

/**
 * La observación del pedido es un campo de TRABAJO, no un log nuestro.
 *
 * Mati, 01/09/2026: *"habría que dejar libre el campo observación porque eso lo utilizamos acá
 * a la hora de facturar"*. Hasta ese día salía con `Pedido app · <nombre del vendedor>` pegado
 * adelante, así que la oficina leía dos datos nuestros antes del que necesitaba.
 */
describe('observacionParaIM', () => {
    it('lo que escribe el vendedor llega tal cual, sin nada adelante', () => {
        expect(observacionParaIM('entregar el jueves temprano')).toBe('entregar el jueves temprano');
    });

    // 🪤 Era esto lo que molestaba: el texto útil empezaba recién en el tercer campo.
    it('ya no antepone "Pedido app" ni el nombre del vendedor', () => {
        const r = observacionParaIM('facturar a nombre de la SRL');
        expect(r).not.toContain('Pedido app');
        expect(r.startsWith('facturar')).toBe(true);
    });

    it('sin observación queda vacía, no con un texto de relleno', () => {
        expect(observacionParaIM(undefined)).toBe('');
        expect(observacionParaIM(null)).toBe('');
        expect(observacionParaIM('')).toBe('');
        expect(observacionParaIM('   ')).toBe('');
    });

    it('recorta los espacios de los costados', () => {
        expect(observacionParaIM('  pagar en efectivo  ')).toBe('pagar en efectivo');
    });

    // 🪤 Se conserva porque el 28/08 quedaron DOS presupuestos vivos y hubo que mirar cuál era
    // el bueno. Va AL FINAL: lo primero que se lee tiene que ser lo del vendedor.
    it('al reemplazar un presupuesto, la nota va al final', () => {
        expect(observacionParaIM('entregar el jueves', 1234))
            .toBe('entregar el jueves · reemplaza al PR 1234');
    });

    it('sin observación, la nota de reemplazo queda sola y sin separador colgando', () => {
        expect(observacionParaIM('', 1234)).toBe('reemplaza al PR 1234');
        expect(observacionParaIM(undefined, 1234)).toBe('reemplaza al PR 1234');
    });

    it('sin reemplazo no se agrega nada', () => {
        expect(observacionParaIM('sin nada', null)).toBe('sin nada');
        expect(observacionParaIM('sin nada', 0)).toBe('sin nada');
        expect(observacionParaIM('sin nada')).toBe('sin nada');
    });

    // El tope es de la cabecera de IM. Ahora los 500 son enteros del vendedor: antes se le
    // iban ~25 en el prefijo.
    it('corta en 500 y ni uno más', () => {
        const largo = 'a'.repeat(600);
        expect(observacionParaIM(largo)).toHaveLength(500);
        expect(observacionParaIM(largo, 999)).toHaveLength(500);
    });

    it('respeta los saltos de línea y los acentos que escribe el vendedor', () => {
        expect(observacionParaIM('Llamar antes\nRetira él mismo')).toBe('Llamar antes\nRetira él mismo');
    });
});
