/**
 * Rebotes: de un muro de renglones a un puñado de clientes.
 *
 * El sheet de faltantes se carga renglón por renglón (un artículo por fila), así
 * que un mes normal trae ~150 filas y la vista las mostraba todas —más otra lista
 * aparte con los recargos del 3%, que habla de los MISMOS clientes—. Leer eso es
 * imposible: los 15 renglones que explican la mitad de la plata quedan perdidos
 * entre 135 de $5.000.
 *
 * Acá se agrupa por CLIENTE, que es la unidad con la que se decide algo ("a este
 * hay que llamarlo", "a este no le mandamos más sin seña"). Verificado contra el
 * sheet real (ene-sep 2026): un mes de ~150 renglones son ~60 clientes, y el 80%
 * de la plata está en unos 20.
 */

export type GrupoResponsable = 'vendedor' | 'cliente' | 'empresa' | 'otro';

/** Quién causó el rebote — es el eje de toda la vista (tiles, badges y colores). */
export const MOTIVO_META: Record<string, { label: string; grupo: GrupoResponsable }> = {
    mc_vendedor: { label: 'M.C. Vendedor', grupo: 'vendedor' },
    devolucion: { label: 'Devolución', grupo: 'cliente' },
    sin_dinero: { label: 'Sin dinero', grupo: 'cliente' },
    cerrado: { label: 'Cerrado', grupo: 'cliente' },
    mc_deposito: { label: 'M.C. Depósito', grupo: 'empresa' },
    falto: { label: 'Faltó', grupo: 'empresa' },
    sin_stock: { label: 'Sin stock', grupo: 'empresa' },
    error_adm: { label: 'Error adm.', grupo: 'empresa' },
    logistica: { label: 'Logística', grupo: 'empresa' },
    error_sistema: { label: 'Error sistema', grupo: 'empresa' },
    sin_clasificar: { label: 'Sin clasificar', grupo: 'otro' },
};

export const grupoDeMotivo = (motivo: string): GrupoResponsable => MOTIVO_META[motivo]?.grupo ?? 'otro';

export const GRUPO_ORDER: GrupoResponsable[] = ['vendedor', 'cliente', 'empresa', 'otro'];

export interface RebotePlano {
    fila: number;
    fecha: string | null;
    cliente_raw: string;
    cod_cliente: number | null;
    vendedor_raw: string | null;
    cod_vendedor: number | null;
    articulo: string | null;
    cantidad: number | null;
    motivo: string;
    motivo_raw: string | null;
    total: number | null;
}

/**
 * Misma clave que arma el backend en detectarEventosRecargo (rebotesParser.ts):
 * sin código de cliente se agrupa por el nombre crudo. Tiene que coincidir o el
 * recargo del 3% no se pega al cliente que corresponde.
 */
export function claveCliente(cod: number | null | undefined, raw: string): string {
    return cod != null ? String(cod) : `raw:${raw}`;
}

export interface GrupoCliente {
    clave: string;
    cliente: string;
    cod_cliente: number | null;
    /** Normalmente uno; si el cliente le compró a dos vendedores, van los dos. */
    vendedores: string[];
    total: number;
    renglones: RebotePlano[];
    /** Fechas distintas = cuántas veces le rebotó algo en el mes. */
    dias: string[];
    ultimaFecha: string | null;
    /** Responsables presentes, del que más plata explica al que menos. */
    responsables: GrupoResponsable[];
    /** 3% que le corresponde pagar (viene de los eventos del backend, no se recalcula). */
    recargo: number;
}

/**
 * Agrupa por cliente y ordena por plata. `recargoPorCliente` se cruza por
 * claveCliente() — si no viene, los grupos quedan con recargo 0.
 */
export function agruparPorCliente(
    rows: RebotePlano[],
    recargoPorCliente?: Map<string, number>,
): GrupoCliente[] {
    const mapa = new Map<string, GrupoCliente & { _porResp: Map<GrupoResponsable, number> }>();
    for (const r of rows) {
        const clave = claveCliente(r.cod_cliente, r.cliente_raw);
        let g = mapa.get(clave);
        if (!g) {
            g = {
                clave, cliente: r.cliente_raw, cod_cliente: r.cod_cliente ?? null,
                vendedores: [], total: 0, renglones: [], dias: [], ultimaFecha: null,
                responsables: [], recargo: recargoPorCliente?.get(clave) ?? 0,
                _porResp: new Map(),
            };
            mapa.set(clave, g);
        }
        const total = Number(r.total) || 0;
        g.total += total;
        g.renglones.push(r);
        if (r.vendedor_raw && !g.vendedores.includes(r.vendedor_raw)) g.vendedores.push(r.vendedor_raw);
        if (r.fecha && !g.dias.includes(r.fecha)) g.dias.push(r.fecha);
        const resp = grupoDeMotivo(r.motivo);
        g._porResp.set(resp, (g._porResp.get(resp) ?? 0) + total);
    }

    const out: GrupoCliente[] = [];
    for (const g of mapa.values()) {
        const { _porResp, ...limpio } = g;
        limpio.total = Math.round(limpio.total * 100) / 100;
        limpio.dias.sort((a, b) => b.localeCompare(a));
        limpio.ultimaFecha = limpio.dias[0] ?? null;
        limpio.responsables = [..._porResp.entries()]
            .sort((a, b) => b[1] - a[1] || GRUPO_ORDER.indexOf(a[0]) - GRUPO_ORDER.indexOf(b[0]))
            .map(([k]) => k);
        // Dentro del cliente: lo más nuevo arriba, y a igual fecha lo más caro.
        limpio.renglones.sort((a, b) =>
            (b.fecha ?? '').localeCompare(a.fecha ?? '') || (Number(b.total) || 0) - (Number(a.total) || 0));
        out.push(limpio);
    }
    // Por plata: el que más nos costó, primero.
    return out.sort((a, b) => b.total - a.total || a.cliente.localeCompare(b.cliente));
}

export interface Corte {
    visibles: GrupoCliente[];
    ocultos: GrupoCliente[];
    totalOculto: number;
}

/** Nunca escondemos nada si son pocos: con 8 clientes no hay muro que romper. */
export const MIN_PARA_CORTAR = 8;
/** Esconder 1 o 2 clientes no ahorra scroll y obliga a un click de más. */
const COLA_MINIMA = 3;
const MIN_VISIBLES = 5;

/**
 * Corta la cola larga: deja arriba los clientes que explican `fraccion` de la
 * plata (80% por defecto) y manda el resto atrás de un botón. No es un "ver
 * menos" arbitrario — es el 20% del dinero repartido en la mitad de las filas.
 */
export function corteRelevante(grupos: GrupoCliente[], fraccion = 0.8): Corte {
    const total = grupos.reduce((a, g) => a + g.total, 0);
    if (grupos.length <= MIN_PARA_CORTAR || total <= 0) {
        return { visibles: grupos, ocultos: [], totalOculto: 0 };
    }
    const objetivo = total * fraccion;
    let acum = 0;
    let corte = 0;
    for (const g of grupos) {
        acum += g.total;
        corte++;
        if (acum >= objetivo) break;
    }
    if (corte < MIN_VISIBLES) corte = MIN_VISIBLES;
    if (grupos.length - corte < COLA_MINIMA) return { visibles: grupos, ocultos: [], totalOculto: 0 };
    const ocultos = grupos.slice(corte);
    return {
        visibles: grupos.slice(0, corte),
        ocultos,
        totalOculto: Math.round(ocultos.reduce((a, g) => a + g.total, 0) * 100) / 100,
    };
}

/** El mes anterior, cruzando el año cuando corresponde. */
export function mesAnterior(year: number, month: number): { year: number; month: number } {
    return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

/**
 * Compara contra el mes pasado el MISMO tramo: si hoy es 16, agosto se corta al
 * 16. Comparar 16 días contra 31 diría "bajamos a la mitad" cuando no bajó nada.
 * Las filas sin fecha cuentan siempre (igual que en el resto de la vista).
 */
export function totalHastaDia(rows: RebotePlano[], year: number, month: number, dia: number | null): number {
    const tope = dia == null
        ? null
        : `${year}-${String(month).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
    const t = rows.reduce(
        (a, r) => a + (tope == null || r.fecha == null || r.fecha <= tope ? Number(r.total) || 0 : 0), 0);
    return Math.round(t * 100) / 100;
}

/** Variación % contra el mes anterior. null si el mes anterior no tuvo nada (dividir por cero no informa). */
export function variacionPorc(actual: number, anterior: number): number | null {
    if (!(anterior > 0)) return null;
    return Math.round(((actual - anterior) / anterior) * 100);
}
