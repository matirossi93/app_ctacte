/**
 * Qué día es el "corte" del período que el vendedor tiene elegido arriba.
 *
 * No inventa una convención nueva: es la que ya documenta `ViewPeriod` en PeriodSelector
 * ("null = mes completo (último día del mes en histórico, hoy en mes actual)"). Vive acá
 * para poder testearse sin montar React, porque de este número depende qué saldo se muestra.
 */

export interface PeriodoCorte {
    year: number;
    month: number;
    asOfDay?: number | null;
}

const dd = (n: number) => String(n).padStart(2, '0');

/** El último día del mes. Febrero y los bisiestos salen solos: día 0 del mes siguiente. */
export function ultimoDiaDelMes(year: number, month: number): number {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export type Corte =
    /** El saldo de hoy: el período elegido es el mes en curso, sin día. */
    | { tipo: 'hoy' }
    /** Un corte a una fecha pasada. */
    | { tipo: 'fecha'; fecha: string }
    /** El período elegido todavía no pasó: no hay saldo que mostrar. */
    | { tipo: 'futuro' };

/**
 * @param p    el período del selector de arriba
 * @param hoy  fecha de hoy en Argentina, AAAA-MM-DD (viene del server o de hoyArgentina())
 */
export function fechaDeCorte(p: PeriodoCorte, hoy: string): Corte {
    const dia = p.asOfDay ?? ultimoDiaDelMes(p.year, p.month);
    const fecha = `${p.year}-${dd(p.month)}-${dd(dia)}`;
    // 🪤 Se compara como texto (ISO ordena bien carácter por carácter) y NO con Date: armar
    // un Date a partir de 'AAAA-MM-DD' lo interpreta en UTC y en Argentina te corre un día.
    if (fecha > hoy) {
        // Un mes en curso sin día elegido significa "hasta hoy", no "hasta fin de mes".
        if (p.asOfDay == null && `${p.year}-${dd(p.month)}` === hoy.slice(0, 7)) return { tipo: 'hoy' };
        return { tipo: 'futuro' };
    }
    if (fecha === hoy) return { tipo: 'hoy' };
    return { tipo: 'fecha', fecha };
}

/** "31/07/2026" para mostrar. */
export function fechaLegible(iso: string): string {
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
}

/** El mes en curso, sin día: "hasta hoy". */
export function mesActual(hoy: string): PeriodoCorte {
    const [year, month] = hoy.split('-').map(Number);
    return { year, month, asOfDay: null };
}

/** ¿El período elegido es "hoy"? (mes en curso, sin un día puntual) */
export function esPeriodoActual(p: PeriodoCorte, hoy: string): boolean {
    const a = mesActual(hoy);
    return p.year === a.year && p.month === a.month && p.asOfDay == null;
}

/**
 * Con qué período arranca la pantalla, a partir de lo que quedó guardado.
 *
 * 🔴 01/09/2026, reportado por Mati: abrió la app y el filtro decía **31/08** sin que él
 * tocara nada, así que estaba mirando la cartera de ayer creyendo que era la de hoy.
 *
 * El motivo: el período se guarda en sessionStorage y sobrevive al recargar. Ayer estaba en
 * "agosto, sin día" — que ayer significaba **hoy**. Hoy, con agosto ya cerrado, ese mismo
 * valor significa **31/08**: el mismo dato cambió de sentido al pasar la medianoche, sin que
 * nadie eligiera nada.
 *
 * 🔑 La distinción es qué quiso decir el usuario. Guardamos también el DÍA en que se guardó:
 *  · si el período guardado era el mes en curso EN ESE MOMENTO, quería decir "hoy" ⇒ hoy
 *    también quiere decir hoy, y se recalcula;
 *  · si eligió un mes pasado a propósito (o un día puntual), esa elección se respeta.
 *
 * Un valor viejo sin `guardadoEn` (los que ya estaban en el teléfono) se trata como el primer
 * caso: es la situación que reportó Mati, y equivocarse hacia "hoy" muestra el dato correcto
 * del día, mientras que equivocarse hacia el otro lado le esconde la realidad.
 */
export function periodoInicial(guardado: unknown, hoy: string): PeriodoCorte {
    const g = guardado as { year?: unknown; month?: unknown; asOfDay?: unknown; guardadoEn?: unknown } | null;
    if (!g || typeof g.year !== 'number' || typeof g.month !== 'number') return mesActual(hoy);
    const p: PeriodoCorte = { year: g.year, month: g.month, asOfDay: typeof g.asOfDay === 'number' ? g.asOfDay : null };
    if (esPeriodoActual(p, hoy)) return p;               // ya es el mes en curso: nada que hacer
    if (p.asOfDay != null) return p;                     // eligió un día puntual: se respeta
    const guardadoEn = typeof g.guardadoEn === 'string' ? g.guardadoEn : null;
    // Sin fecha de guardado, o guardado cuando ESE era el mes en curso ⇒ quería decir "hoy".
    if (!guardadoEn || esPeriodoActual(p, guardadoEn)) return mesActual(hoy);
    return p;                                            // eligió un mes pasado a propósito
}
