/**
 * Búsqueda de clientes del módulo de pedidos.
 *
 * Vive acá y no adentro del componente porque es la lógica que falló en producción
 * (27/08/2026: Sebastián no encontraba clientes) y tiene que poder testearse sin montar React.
 */

export interface ClienteBuscable {
  cod: string;
  name: string;
  localidad?: string;
}

/**
 * Compara sin acentos ni mayúsculas.
 *
 * Media cartera tiene Ñ o tilde en la razón social (PEÑA, RODRÍGUEZ, MARTÍNEZ) y nadie los
 * tipea en el celular: buscar "pena" tiene que encontrar "PEÑA". NFD separa la letra de su
 * tilde, y el rango \u0300-\u036f borra las marcas combinantes que quedan sueltas.
 */
export const norm = (s: string): string =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/** Cuántos clientes se muestran de una. Por encima de esto se pide afinar la búsqueda. */
export const TOPE_CLIENTES = 50;

/**
 * Ordena por relevancia y recorta.
 *
 * 🪤 Antes era `filter(...).slice(0, 30)`: con el maestro entero (cientos de clientes por
 * vendedor) el tope cortaba por orden ALFABÉTICO, así que buscar "SA" podía dejar afuera al
 * cliente que sí matcheaba mientras mostraba 30 que matcheaban peor. El puntaje arregla eso:
 * código exacto primero, después arranca-con, después contiene.
 *
 * 🪤 El último tier existe porque en InfoManager las razones sociales están cargadas como
 * `APELLIDO, Nombre (Localidad)` — "BUSTOS, Sebastián (Este)". Buscar la frase entera
 * ("bustos sebastian") no matchea NUNCA: la coma está en el medio. Va último a propósito,
 * para no desordenar los matches directos.
 */
export function buscarClientes<T extends ClienteBuscable>(
  lista: T[],
  query: string,
  tope: number = TOPE_CLIENTES,
): { resultados: T[]; deMas: number } {
  const t = norm(query);
  if (!t) {
    return { resultados: lista.slice(0, tope), deMas: Math.max(0, lista.length - tope) };
  }

  const tokens = t.split(/\s+/).filter(Boolean);
  const hits: Array<{ c: T; p: number }> = [];
  for (const c of lista) {
    const n = norm(c.name);
    let p = -1;
    if (c.cod === t) p = 0;
    else if (c.cod.startsWith(t)) p = 1;
    else if (n.startsWith(t)) p = 2;
    else if (n.includes(t)) p = 3;
    else if (c.cod.includes(t)) p = 4;
    else if (tokens.length > 1 && tokens.every((tk) => n.includes(tk))) p = 5;
    if (p >= 0) hits.push({ c, p });
  }
  hits.sort((a, b) => a.p - b.p || a.c.name.localeCompare(b.c.name, 'es'));

  return {
    resultados: hits.slice(0, tope).map((h) => h.c),
    deMas: Math.max(0, hits.length - tope),
  };
}
