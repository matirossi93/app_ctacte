/**
 * La suma de los vendedores elegidos, calculada en la pantalla.
 *
 * 🔑 Por qué acá y no en el server: el desglose por vendedor YA viene entero en la respuesta
 * de /api/cartera, así que filtrar es sumar unos números que la app ya tiene en la mano.
 * Mientras esto se pedía al server, cada click en el selector de vendedores redisparaba la
 * consulta completa — 1,1 s si era una fecha pasada, y hasta 6,4 s si había que ir a
 * InfoManager. Todo para recalcular una suma de cinco términos.
 *
 * ⚠️ Tiene que dar EXACTAMENTE lo mismo que `totalesCartera` en server-lib/cartera.ts: es la
 * misma cifra mostrada en el mismo lugar, y dos redondeos distintos se ven como un error de
 * plata. De ahí el r2, que replica el suyo.
 */

export interface VendedorCartera {
    cod_vendedor: number;
    saldo_im: number;
    en_transito: number;
    ajustado: number;
    n_clientes: number;
}

export interface Filtrado {
    cods: number[];
    saldo_im: number;
    en_transito: number;
    ajustado: number;
    n_clientes: number;
}

/** Redondeo a 2 decimales, igual que `r2` del server. */
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * @param porVendedor el desglose tal cual vino del server
 * @param cods        los códigos elegidos arriba ("2,3,12"). Vacío = sin filtro → null.
 */
export function sumarVendedores(porVendedor: VendedorCartera[], cods: string): Filtrado | null {
    const elegidos = cods
        .split(',')
        .map(s => s.trim())
        // 🪤 Los pedazos vacíos se descartan ANTES de convertir: `Number('')` es 0, que es un
        // entero y no es negativo, así que "sin filtro" pasaba como "filtrar por el vendedor
        // 0" — y el 0 existe de verdad (las filas RC/NC lo traen, es el grupo "Sin vendedor").
        .filter(s => s !== '')
        .map(Number)
        // Mismo criterio que `parsearCods` del server: enteros y no negativos.
        .filter(n => Number.isInteger(n) && n >= 0);
    if (!elegidos.length) return null;

    const filas = porVendedor.filter(v => elegidos.includes(v.cod_vendedor));
    return {
        cods: elegidos,
        saldo_im: r2(filas.reduce((a, v) => a + v.saldo_im, 0)),
        en_transito: r2(filas.reduce((a, v) => a + v.en_transito, 0)),
        ajustado: r2(filas.reduce((a, v) => a + v.ajustado, 0)),
        n_clientes: filas.reduce((a, v) => a + v.n_clientes, 0),
    };
}
