import { describe, it, expect } from 'vitest';
import { armarHistorico, pctParaMostrar } from './cumplimiento';

/**
 * La grilla del histórico de objetivos (pedido de Mati, 01/09/2026): filas = vendedores,
 * columnas = meses, para ver la tendencia al definir el objetivo del mes siguiente.
 *
 * Lo que se testea acá son las tres decisiones que pueden hacerle sacar una conclusión
 * equivocada mirando la grilla:
 *   1. un mes sin objetivo NO es un mes incumplido;
 *   2. el mes en curso está a mitad de camino y no se puede juzgar todavía;
 *   3. los meses que no llegaron no existen.
 */

const VENDEDORES = [{ cod_vendedor: 2, nombre: 'MARCELO' }, { cod_vendedor: 3, nombre: 'SEBA' }];
const EN_CURSO = { year: 2026, month: 9 };

describe('armarHistorico', () => {
    it('calcula el cumplimiento de cada mes', () => {
        const r = armarHistorico({
            year: 2026,
            goals: [{ cod_vendedor: 2, year: 2026, month: 7, target_neto: 1000 }],
            ventas: [{ cod_vendedor: 2, year: 2026, month: 7, neto: 1200 }],
            vendedores: VENDEDORES, enCurso: EN_CURSO,
        });
        const julio = r.filas[0].meses[6];
        expect(julio).toMatchObject({ month: 7, target: 1000, neto: 1200, pct: 1.2, estado: 'cumplio' });
    });

    it('90% es "cerca" y 89% ya es "lejos"', () => {
        const r = armarHistorico({
            year: 2026,
            goals: [{ cod_vendedor: 2, year: 2026, month: 7, target_neto: 1000 },
                    { cod_vendedor: 3, year: 2026, month: 7, target_neto: 1000 }],
            ventas: [{ cod_vendedor: 2, year: 2026, month: 7, neto: 900 },
                     { cod_vendedor: 3, year: 2026, month: 7, neto: 890 }],
            vendedores: VENDEDORES, enCurso: EN_CURSO,
        });
        expect(r.filas[0].meses[6].estado).toBe('cerca');
        expect(r.filas[1].meses[6].estado).toBe('lejos');
    });

    /**
     * 🔑 La decisión que más cambia la lectura de la grilla. Si a un vendedor no le fijaron
     * objetivo en un mes, ese mes no es un fracaso suyo: es un mes sin medir. Contarlo como
     * 0% le hunde el promedio del año por algo que no depende de él, y justo el promedio es
     * lo que Mati y Manolo van a mirar para definir el objetivo siguiente.
     */
    it('un mes sin objetivo no cuenta como incumplido ni entra al promedio', () => {
        const r = armarHistorico({
            year: 2026,
            goals: [{ cod_vendedor: 2, year: 2026, month: 7, target_neto: 1000 }],
            ventas: [{ cod_vendedor: 2, year: 2026, month: 6, neto: 500 },
                     { cod_vendedor: 2, year: 2026, month: 7, neto: 1000 }],
            vendedores: VENDEDORES, enCurso: EN_CURSO,
        });
        const fila = r.filas[0];
        expect(fila.meses[5].estado).toBe('sin_objetivo');   // junio: vendió, pero nadie le puso objetivo
        expect(fila.meses[5].pct).toBeNull();
        expect(fila.conObjetivo).toBe(1);                     // sólo julio
        expect(fila.cumplidos).toBe(1);
        expect(fila.promedio).toBe(1);                        // junio no lo arrastra para abajo
    });

    /**
     * 🔑 El mes en curso va por la mitad. Si el 2 de septiembre mostrara "4%", parecería un
     * desastre cuando en realidad todavía no pasó nada. Se muestra, pero aparte.
     */
    it('el mes en curso se muestra pero no entra al promedio ni al conteo', () => {
        const r = armarHistorico({
            year: 2026,
            goals: [{ cod_vendedor: 2, year: 2026, month: 8, target_neto: 1000 },
                    { cod_vendedor: 2, year: 2026, month: 9, target_neto: 1000 }],
            ventas: [{ cod_vendedor: 2, year: 2026, month: 8, neto: 1000 },
                     { cod_vendedor: 2, year: 2026, month: 9, neto: 40 }],
            vendedores: VENDEDORES, enCurso: EN_CURSO,
        });
        const fila = r.filas[0];
        expect(fila.meses[8]).toMatchObject({ month: 9, estado: 'en_curso', pct: 0.04 });
        expect(fila.conObjetivo).toBe(1);   // sólo agosto
        expect(fila.promedio).toBe(1);      // el 4% de septiembre no lo ensucia
    });

    it('los meses que todavía no llegaron quedan vacíos', () => {
        const r = armarHistorico({
            year: 2026, goals: [], ventas: [], vendedores: VENDEDORES, enCurso: EN_CURSO,
        });
        expect(r.filas[0].meses[9].estado).toBe('futuro');   // octubre
        expect(r.filas[0].meses).toHaveLength(12);
    });

    it('en un año pasado no hay mes en curso: los 12 meses se juzgan', () => {
        const r = armarHistorico({
            year: 2025,
            goals: [{ cod_vendedor: 2, year: 2025, month: 12, target_neto: 1000 }],
            ventas: [{ cod_vendedor: 2, year: 2025, month: 12, neto: 500 }],
            vendedores: VENDEDORES, enCurso: EN_CURSO,
        });
        expect(r.filas[0].meses[11].estado).toBe('lejos');
        expect(r.filas[0].conObjetivo).toBe(1);
    });

    // Un objetivo en 0 no es un objetivo cumplido por definición: es "no le pusieron nada".
    it('un objetivo en 0 se trata como sin objetivo', () => {
        const r = armarHistorico({
            year: 2026,
            goals: [{ cod_vendedor: 2, year: 2026, month: 7, target_neto: 0 }],
            ventas: [{ cod_vendedor: 2, year: 2026, month: 7, neto: 500 }],
            vendedores: VENDEDORES, enCurso: EN_CURSO,
        });
        expect(r.filas[0].meses[6].estado).toBe('sin_objetivo');
        expect(r.filas[0].conObjetivo).toBe(0);
        expect(r.filas[0].promedio).toBeNull();
    });

    it('el equipo se suma por mes, en pesos (no es el promedio de los porcentajes)', () => {
        const r = armarHistorico({
            year: 2026,
            goals: [{ cod_vendedor: 2, year: 2026, month: 7, target_neto: 1000 },
                    { cod_vendedor: 3, year: 2026, month: 7, target_neto: 3000 }],
            ventas: [{ cod_vendedor: 2, year: 2026, month: 7, neto: 2000 },
                     { cod_vendedor: 3, year: 2026, month: 7, neto: 2000 }],
            vendedores: VENDEDORES, enCurso: EN_CURSO,
        });
        // 4000 vendidos sobre 4000 de objetivo = 100%. El promedio de los % daría 133%.
        expect(r.equipo[6]).toMatchObject({ target: 4000, neto: 4000, pct: 1 });
    });

    /**
     * 🔴 01/09/2026, visto en la primera captura de Mati: Brian, agosto, objetivo $65.000.000
     * y vendido $64.853.994 — le faltaron $146.006 — y la celda decía **100%**. Redondear
     * 0,9977 hacia arriba convierte un mes que no llegó en uno que parece cumplido.
     * El color lo salvaba (quedaba en "cerca"), pero el número mentía, y el número es lo
     * que se lee primero.
     */
    it('un mes que no llegó nunca muestra 100%', () => {
        expect(pctParaMostrar(64853994 / 65000000)).toBe(99);
        expect(pctParaMostrar(0.999999)).toBe(99);
        expect(pctParaMostrar(1)).toBe(100);
        expect(pctParaMostrar(1.004)).toBe(100);   // pasó el objetivo: redondear está bien
        expect(pctParaMostrar(1.2)).toBe(120);
        expect(pctParaMostrar(0)).toBe(0);
    });

    it('ordena los vendedores por cumplimiento del año, mejor primero', () => {
        const r = armarHistorico({
            year: 2026,
            goals: [{ cod_vendedor: 2, year: 2026, month: 7, target_neto: 1000 },
                    { cod_vendedor: 3, year: 2026, month: 7, target_neto: 1000 }],
            ventas: [{ cod_vendedor: 2, year: 2026, month: 7, neto: 500 },
                     { cod_vendedor: 3, year: 2026, month: 7, neto: 1500 }],
            vendedores: VENDEDORES, enCurso: EN_CURSO,
        });
        expect(r.filas.map(f => f.cod_vendedor)).toEqual([3, 2]);
    });

    // Sin objetivos cargados la pantalla tiene que poder decirlo, no mostrar una grilla muerta.
    it('informa desde qué mes hay objetivos cargados', () => {
        const r = armarHistorico({
            year: 2026,
            goals: [{ cod_vendedor: 2, year: 2026, month: 5, target_neto: 1000 },
                    { cod_vendedor: 3, year: 2026, month: 8, target_neto: 1000 }],
            ventas: [], vendedores: VENDEDORES, enCurso: EN_CURSO,
        });
        expect(r.primerMesConObjetivo).toBe(5);
    });

    it('sin ningún objetivo cargado, primerMesConObjetivo es null', () => {
        const r = armarHistorico({ year: 2026, goals: [], ventas: [], vendedores: VENDEDORES, enCurso: EN_CURSO });
        expect(r.primerMesConObjetivo).toBeNull();
    });
});
