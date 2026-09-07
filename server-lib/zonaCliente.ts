/**
 * En qué zona de reparto cae un cliente. Es lo que agrupa las hojas de ruta: la hoja nº 3394
 * del 07/09/2026 eran todos clientes de la zona 9 (Lules, Manantial).
 *
 * Medido sobre los 377 clientes que compraron en 14 días: **72% tiene `cod_zona`** cargada en
 * IM. El resto son en su mayoría CONSUMIDOR FINAL, cuentas internas (BRS MAYOR, SEMILLERO EL
 * MANANTIAL BRS) y altas nuevas — o sea, la mayoría de los que van al camión sí la tienen.
 *
 * 🪤 `cod_transporte` NO sirve: está en 0 para los 1.332 clientes. El transporte ("Niño") lo
 * elige quien arma la hoja.
 */

/** Cómo se llama cada zona, deducido de los nombres de cliente de IM (07/09/2026). */
export const NOMBRE_ZONA: Record<number, string> = {
  1: 'Simoca', 2: 'Oeste II', 3: 'Banda / Alderetes', 4: 'Centro', 5: 'Ciudadela',
  6: 'Este / Ranchillos', 7: 'Jujuy', 8: 'Leales', 9: 'Lules / Manantial',
  10: 'Concepción / Monteros', 11: 'Tafí Viejo', 12: 'Villa / Las Talitas', 13: 'Yerba Buena',
};

export interface ClienteZonable {
  cod_zona?: number | string | null;
  razon_social?: string | null;
  localidad?: string | null;
}

export interface Zona {
  /** `null` cuando no se pudo determinar: hay que asignarlo a mano. */
  cod_zona: number | null;
  /** Para mostrar. Nunca vacío: si no hay zona dice por qué. */
  nombre: string;
  /** De dónde salió, para poder desconfiar del dato en la pantalla. */
  origen: 'im' | 'nombre' | 'ninguno';
}

/**
 * 🪤 El paréntesis del nombre NO siempre es la zona: "VARGAS, Cintia (Julio)" y
 * "(Marcelo)" son otra cosa (el titular). Por eso sólo se usa como respaldo y sólo si el texto
 * coincide con una zona conocida — nunca se inventa una zona nueva a partir del nombre.
 */
const POR_NOMBRE: Record<string, number> = {
  'simoca': 1, 'bella vista': 1,
  'oeste ii': 2, 'oeste 2': 2,
  'banda': 3, 'alderetes': 3, 'lastenia': 3,
  'centro': 4,
  'ciudadela': 5,
  'este': 6, 'ranchillos': 6, 'los ralos': 6,
  'jujuy': 7,
  'leales': 8,
  'lules': 9, 'manantial': 9, 'san pablo': 9,
  'concepcion': 10, 'concepción': 10, 'monteros': 10, 'alberdi': 10,
  'tafi viejo': 11, 'tafí viejo': 11, 'tafi': 11, 'y. b.': 13, 'y. b': 13,
  'villa': 12, 'las talitas': 12, 'talitas': 12,
  'yerba buena': 13,
};

export function zonaDeCliente(c: ClienteZonable | null | undefined): Zona {
  const cod = Number(c?.cod_zona);
  if (Number.isFinite(cod) && cod > 0) {
    return { cod_zona: cod, nombre: NOMBRE_ZONA[cod] ?? `Zona ${cod}`, origen: 'im' };
  }
  // Respaldo: lo que va entre paréntesis al final del nombre, si es una zona conocida.
  const m = String(c?.razon_social ?? '').match(/\(([^)]+)\)\s*$/);
  const dentro = m ? m[1].trim().toLowerCase() : '';
  const porNombre = POR_NOMBRE[dentro];
  if (porNombre) {
    return { cod_zona: porNombre, nombre: NOMBRE_ZONA[porNombre] ?? `Zona ${porNombre}`, origen: 'nombre' };
  }
  return { cod_zona: null, nombre: 'Sin zona', origen: 'ninguno' };
}

/**
 * Agrupa pedidos por zona para sugerir cómo repartirlos en hojas de ruta.
 *
 * Es una SUGERENCIA, no una decisión: quien arma la hoja mueve lo que quiera. Los que no
 * tienen zona salen aparte y a la vista, para que no se cuelen ni se pierdan.
 */
export function agruparPorZona<T>(
  filas: T[],
  cliente: (f: T) => ClienteZonable | null | undefined,
): Array<{ cod_zona: number | null; nombre: string; filas: T[] }> {
  const grupos = new Map<string, { cod_zona: number | null; nombre: string; filas: T[] }>();
  for (const f of filas) {
    const z = zonaDeCliente(cliente(f));
    const k = String(z.cod_zona ?? 'sin');
    if (!grupos.has(k)) grupos.set(k, { cod_zona: z.cod_zona, nombre: z.nombre, filas: [] });
    grupos.get(k)!.filas.push(f);
  }
  // Las zonas conocidas primero y por código; "Sin zona" al final, que es donde hay que mirar.
  return [...grupos.values()].sort((a, b) => {
    if (a.cod_zona == null) return 1;
    if (b.cod_zona == null) return -1;
    return a.cod_zona - b.cod_zona;
  });
}
