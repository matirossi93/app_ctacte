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
