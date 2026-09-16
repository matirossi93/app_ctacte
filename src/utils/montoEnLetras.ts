/**
 * El importe escrito en palabras, como en cualquier talonario de recibos.
 *
 * Es lo que convierte un papel en un comprobante: el número se puede alterar agregándole un
 * dígito, el texto no. Los centavos van en número (`con 50/100`), que es la convención de los
 * recibos argentinos y evita discutir cómo se escribe "cincuenta centésimos".
 */

const UNIDADES = ['', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve',
    'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve',
    'veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'];
const DECENAS = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
/** 🪤 No son regulares: quinientos, setecientos y novecientos se salen del patrón. */
const CENTENAS = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos',
    'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];

/** 0 a 999 en palabras. */
function hasta999(n: number): string {
    if (n === 0) return '';
    if (n === 100) return 'cien';                       // 🪤 "cien", no "ciento"
    if (n < 30) return UNIDADES[n];
    if (n < 100) {
        const d = Math.floor(n / 10), u = n % 10;
        return u === 0 ? DECENAS[d] : `${DECENAS[d]} y ${UNIDADES[u]}`;
    }
    const c = Math.floor(n / 100), r = n % 100;
    return r === 0 ? CENTENAS[c] : `${CENTENAS[c]} ${hasta999(r)}`;
}

/** 🪤 Delante de "mil" y "millones", "uno" se apocopa: veintiún mil, treinta y un mil. */
const apocopar = (s: string) => s.replace(/veintiuno$/, 'veintiún').replace(/\buno$/, 'un');

export function montoEnLetras(monto: number): string {
    // Se redondea ANTES de partir: con el float crudo, 1.005 se parte en 1 y 0 centavos.
    const total = Math.round((Number(monto) || 0) * 100);
    const entero = Math.floor(Math.abs(total) / 100);
    const centavos = Math.abs(total) % 100;
    const cents = `con ${String(centavos).padStart(2, '0')}/100`;
    if (entero === 0) return `cero ${cents}`;

    const millones = Math.floor(entero / 1_000_000);
    const miles = Math.floor((entero % 1_000_000) / 1000);
    const resto = entero % 1000;

    const partes: string[] = [];
    if (millones === 1) partes.push('un millón');
    else if (millones > 1) partes.push(`${apocopar(hasta999(millones))} millones`);
    if (miles === 1) partes.push('un mil');
    else if (miles > 1) partes.push(`${apocopar(hasta999(miles))} mil`);
    if (resto > 0) partes.push(hasta999(resto));

    const signo = total < 0 ? 'menos ' : '';
    return `${signo}${partes.join(' ')} ${cents}`;
}
