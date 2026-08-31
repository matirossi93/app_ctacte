/**
 * Plata abreviada para que entre en un renglón: `$167,7M`.
 *
 * Se usa SÓLO en la línea compacta de la cartera, donde el número comparte lugar con el
 * rótulo, la cantidad de clientes y el calendario. El monto exacto está siempre a un toque,
 * en el detalle: la abreviatura no reemplaza al número, lo anuncia.
 *
 * 🔑 Tiene que VERSE redondeado. "$167,7M" se lee como aproximado; un "$167.747.5" recortado
 * sería un número falso con cara de exacto.
 */
export function montoCorto(n: number | null | undefined): string {
    if (n == null || !Number.isFinite(n)) return '—';

    // Menos unicode (−, U+2212) y no un guion ASCII: alinea con el resto de los montos.
    const signo = n < 0 ? '−' : '';
    const abs = Math.abs(n);

    if (abs >= 1_000_000) {
        const millones = abs / 1_000_000;
        // Un decimal, y sin la coma cero: "$2M" y no "$2,0M".
        const texto = millones.toFixed(1).replace(/\.0$/, '').replace('.', ',');
        return `${signo}$${texto}M`;
    }
    if (abs >= 1000) {
        return `${signo}$${Math.round(abs / 1000)} mil`;
    }
    return `${signo}$${Math.round(abs)}`;
}
