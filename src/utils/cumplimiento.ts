/**
 * El histórico de objetivos: qué se le pidió a cada vendedor mes a mes y cuánto cumplió.
 *
 * Pedido de Mati (01/09/2026): él y Manolo definen los objetivos todos los meses y quieren
 * ver la tendencia para atrás en el momento de definir el siguiente.
 *
 * Vive acá, separado de React, porque de estos números depende una decisión (el objetivo que
 * le van a poner a una persona el mes que viene) y tienen que poder testearse.
 */

export interface GoalMes { cod_vendedor: number; year: number; month: number; target_neto: number | null }
export interface VentaMes { cod_vendedor: number; year: number; month: number; neto: number }
export interface VendedorRef { cod_vendedor: number; nombre: string }

export type EstadoMes = 'cumplio' | 'cerca' | 'lejos' | 'sin_objetivo' | 'en_curso' | 'futuro';

export interface CeldaMes {
    month: number;
    target: number | null;
    neto: number;
    /** null cuando no hay objetivo contra el cual medir. */
    pct: number | null;
    estado: EstadoMes;
}

export interface FilaVendedor {
    cod_vendedor: number;
    nombre: string;
    /** Siempre 12, de enero a diciembre. */
    meses: CeldaMes[];
    /** Promedio de cumplimiento de los meses cerrados CON objetivo. null si no hay ninguno. */
    promedio: number | null;
    cumplidos: number;
    conObjetivo: number;
}

export interface Historico {
    year: number;
    filas: FilaVendedor[];
    /** El equipo, sumado en pesos por mes. */
    equipo: CeldaMes[];
    /** Desde qué mes hay objetivos cargados, para no mostrar una grilla vacía sin explicar. */
    primerMesConObjetivo: number | null;
}

/** Umbral de "cerca": el mismo 90% que ya usan las tarjetas del mes en ObjetivosApp. */
const CERCA = 0.9;

function estadoPara(pct: number): EstadoMes {
    if (pct >= 1) return 'cumplio';
    if (pct >= CERCA) return 'cerca';
    return 'lejos';
}

const clave = (cod: number, month: number) => `${cod}:${month}`;

export function armarHistorico(input: {
    year: number;
    goals: GoalMes[];
    ventas: VentaMes[];
    vendedores: VendedorRef[];
    enCurso: { year: number; month: number };
}): Historico {
    const { year, goals, ventas, vendedores, enCurso } = input;

    const targetPorMes = new Map<string, number>();
    for (const g of goals) {
        // 🪤 Un objetivo en 0 no es "cumplió cualquier cosa": es que no le pusieron nada.
        // Sin este filtro, cualquier venta contra un target 0 daría infinito o 100%.
        if (g.year !== year || !g.target_neto || g.target_neto <= 0) continue;
        targetPorMes.set(clave(g.cod_vendedor, g.month), g.target_neto);
    }
    const netoPorMes = new Map<string, number>();
    for (const v of ventas) {
        if (v.year !== year) continue;
        netoPorMes.set(clave(v.cod_vendedor, v.month), (netoPorMes.get(clave(v.cod_vendedor, v.month)) ?? 0) + (Number(v.neto) || 0));
    }

    // Un mes es futuro si todavía no llegó; es "en curso" si es exactamente el de hoy.
    // En un año ya cerrado no hay ninguno de los dos: los 12 meses se juzgan enteros.
    const esFuturo = (m: number) => year > enCurso.year || (year === enCurso.year && m > enCurso.month);
    const esEnCurso = (m: number) => year === enCurso.year && m === enCurso.month;

    function celda(target: number | null, neto: number, month: number): CeldaMes {
        if (esFuturo(month)) return { month, target, neto: 0, pct: null, estado: 'futuro' };
        if (target == null) return { month, target: null, neto, pct: null, estado: 'sin_objetivo' };
        const pct = neto / target;
        // El mes en curso va por la mitad: mostrarlo como incumplido sería mentir.
        return { month, target, neto, pct, estado: esEnCurso(month) ? 'en_curso' : estadoPara(pct) };
    }

    const filas: FilaVendedor[] = vendedores.map(v => {
        const meses: CeldaMes[] = [];
        for (let m = 1; m <= 12; m++) {
            meses.push(celda(targetPorMes.get(clave(v.cod_vendedor, m)) ?? null,
                             netoPorMes.get(clave(v.cod_vendedor, m)) ?? 0, m));
        }
        // Sólo los meses cerrados y con objetivo puntúan: los otros no son mérito ni demérito suyo.
        const juzgables = meses.filter(c => c.pct != null && c.estado !== 'en_curso' && c.estado !== 'futuro');
        const promedio = juzgables.length
            ? juzgables.reduce((a, c) => a + (c.pct as number), 0) / juzgables.length
            : null;
        return {
            cod_vendedor: v.cod_vendedor,
            nombre: v.nombre,
            meses,
            promedio,
            cumplidos: juzgables.filter(c => c.estado === 'cumplio').length,
            conObjetivo: juzgables.length,
        };
    });

    // Mejor primero. Sin meses juzgables va al final, no arriba con un 0 que no significa nada.
    filas.sort((a, b) => (b.promedio ?? -1) - (a.promedio ?? -1));

    // 🔑 El equipo se suma en PESOS y recién ahí se divide. El promedio de los porcentajes
    // le daría el mismo peso al vendedor más chico que al más grande y sobreestima el mes.
    const equipo: CeldaMes[] = [];
    for (let m = 1; m <= 12; m++) {
        let target = 0, neto = 0, hayTarget = false;
        for (const v of vendedores) {
            const t = targetPorMes.get(clave(v.cod_vendedor, m));
            if (t) { target += t; hayTarget = true; }
            neto += netoPorMes.get(clave(v.cod_vendedor, m)) ?? 0;
        }
        equipo.push(celda(hayTarget ? target : null, neto, m));
    }

    const mesesConObjetivo = [...targetPorMes.keys()].map(k => Number(k.split(':')[1]));
    return {
        year,
        filas,
        equipo,
        primerMesConObjetivo: mesesConObjetivo.length ? Math.min(...mesesConObjetivo) : null,
    };
}
