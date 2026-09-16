/**
 * Qué período de recibos se pide.
 *
 * Mati (16/09/2026): *"a veces necesitamos ver el historial de recibos de más de 1 mes; capaz
 * que podemos poner un selector de fecha para cuidar las consultas"*. La idea del selector es
 * exactamente esa: se pide **un mes por vez**, no todo el historial de una.
 *
 * 🪤 El default y el fallback son siempre la ventana corta. Un `mes` vacío o con basura no
 * puede terminar abriendo la consulta entera: sin ese cuidado, un parámetro mal armado en el
 * navegador se lleva puesta la base.
 */

/**
 * Tope de filas de una consulta. 🔑 Era 500 y **no alcanzaba**: julio de 2026 tuvo 536 recibos,
 * así que ese mes se habría mostrado cortado y sin avisar. Se deja holgura sobre el mes más
 * cargado que hubo, y quien llama avisa si aun así se llegó al tope.
 */
export const MAX_FILAS = 1000;

/** Ventana por defecto, la que se venía mostrando. */
const DIAS_DEFECTO = 30;
const DIAS_MAX = 120;

export interface RangoRecibos {
  /** ISO. Desde acá (inclusive). */
  desde: string;
  /** ISO. Hasta acá (exclusivo). `null` = hasta ahora. */
  hasta: string | null;
  /** Para el log y para que la respuesta pueda decir qué contestó. */
  etiqueta: string;
}

const MES_VALIDO = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function rangoDeRecibos(
  query: { mes?: unknown; dias?: unknown },
  ahora: Date = new Date(),
): RangoRecibos {
  const mes = typeof query.mes === 'string' ? query.mes.trim() : '';
  const m = MES_VALIDO.exec(mes);
  if (m) {
    const anio = Number(m[1]), nroMes = Number(m[2]);
    // Date.UTC con mes 12 rueda solo al enero siguiente: no hay que tratar diciembre aparte.
    const desde = new Date(Date.UTC(anio, nroMes - 1, 1));
    const hasta = new Date(Date.UTC(anio, nroMes, 1));
    return { desde: desde.toISOString(), hasta: hasta.toISOString(), etiqueta: mes };
  }

  const dias = Math.min(Math.max(Number(query.dias) || DIAS_DEFECTO, 1), DIAS_MAX);
  return {
    desde: new Date(ahora.getTime() - dias * 24 * 60 * 60 * 1000).toISOString(),
    hasta: null,
    etiqueta: `últimos ${dias} días`,
  };
}
