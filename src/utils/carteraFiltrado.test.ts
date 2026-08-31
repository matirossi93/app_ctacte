import { describe, it, expect } from 'vitest';
import { sumarVendedores, type VendedorCartera } from './carteraFiltrado';

/**
 * El filtro por vendedor dejó de pedirle nada al server: suma el desglose que ya vino.
 *
 * 🪤 El test que compara esta suma contra la del server NO vive acá sino en
 * `server-lib/cartera.test.ts`. Importar server-lib desde `src/` arrastra todo el backend
 * adentro del proyecto del front (tsconfig.app.json incluye `src`), que compila con
 * `noUnusedLocals` y `verbatimModuleSyntax`: rompía `npm run build` con errores en archivos
 * que nadie había tocado. El cruce es el mismo, hecho desde el lado que corresponde.
 */

const VENDEDORES: VendedorCartera[] = [
    { cod_vendedor: 3, saldo_im: 62813774.55, en_transito: 1200000.25, ajustado: 61613774.30, n_clientes: 84 },
    { cod_vendedor: 4, saldo_im: 45449633.10, en_transito: 800000.50, ajustado: 44649632.60, n_clientes: 71 },
    { cod_vendedor: 2, saldo_im: 35593293.33, en_transito: 500000.10, ajustado: 35093293.23, n_clientes: 63 },
    { cod_vendedor: 5, saldo_im: 26228702.02, en_transito: 0, ajustado: 26228702.02, n_clientes: 42 },
    { cod_vendedor: 6, saldo_im: 5860870.00, en_transito: 0, ajustado: 5860870.00, n_clientes: 10 },
];

describe('sumarVendedores — filtrar sin volver a preguntarle al server', () => {
    it('suma sólo los elegidos', () => {
        const r = sumarVendedores(VENDEDORES, '3,4');
        expect(r!.saldo_im).toBe(108263407.65);
        expect(r!.n_clientes).toBe(155);
        expect(r!.cods).toEqual([3, 4]);
    });

    it('sin selección no hay filtro (se muestra sólo el total)', () => {
        expect(sumarVendedores(VENDEDORES, '')).toBeNull();
        expect(sumarVendedores(VENDEDORES, '   ')).toBeNull();
    });

    it('un vendedor sin cartera suma cero, no rompe', () => {
        const r = sumarVendedores(VENDEDORES, '99');
        expect(r).toEqual({ cods: [99], saldo_im: 0, en_transito: 0, ajustado: 0, n_clientes: 0 });
    });

    it('tolera espacios y basura en la lista, igual que parsearCods del server', () => {
        expect(sumarVendedores(VENDEDORES, ' 3 , 4 ')!.n_clientes).toBe(155);
        expect(sumarVendedores(VENDEDORES, '3,abc,-1,4')!.cods).toEqual([3, 4]);
    });

    // 🪤 Sin redondeo, sumar floats da 108263407.65000001 y la pantalla muestra un centavo
    // que no existe. El server ya redondeaba; esta copia tiene que hacer lo mismo.
    it('redondea a 2 decimales como el server (nada de colas de float)', () => {
        const r = sumarVendedores([
            { cod_vendedor: 1, saldo_im: 0.1, en_transito: 0, ajustado: 0.1, n_clientes: 1 },
            { cod_vendedor: 2, saldo_im: 0.2, en_transito: 0, ajustado: 0.2, n_clientes: 1 },
        ], '1,2');
        expect(r!.saldo_im).toBe(0.3);
    });
});
