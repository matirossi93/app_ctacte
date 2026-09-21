/**
 * HASTA DÓNDE MIRAR PARA ENCONTRAR LOS COMPROBANTES CON FECHA ADELANTADA.
 *
 * 🔴 22/09/2026. Mati: *"la velocidad de la sección de facturación es lentísima, nos está
 * haciendo perder mucho tiempo"*. Medido ese día contra producción: de 160 comprobantes que la
 * pantalla tiene que verificar, 26 no estaban en el listado del día y se leían **de a uno** —
 * 7,8 segundos, el grueso de la carga.
 *
 * Los 26 eran todos del DÍA SIGUIENTE: 14 facturas y 12 remitos emitidos por adelantado (la app
 * permite facturar hasta 7 días antes, ver `MAX_ADELANTO_DIAS`). El listado se pedía sólo del
 * día de la pantalla, así que caían afuera por definición.
 *
 * Traerlos en el listado sale gratis, medido el mismo día:
 *
 *     sólo hoy      1.873 filas   1.010 ms
 *     hasta +7 días 1.979 filas     653 ms
 *
 * 🪤 Este rango ampliado es SÓLO para buscar comprobantes por id (vigencia, importes,
 * conciliación). La vista sigue con el rango que pidió el usuario: si se ampliara, la pantalla
 * mostraría los pedidos de mañana.
 */

/**
 * 🔴 Tope de 30 días. `/ventas` se cachea hasta 10 días; los rangos largos no, y pedir uno de
 * tres meses sería peor que las lecturas sueltas que esto viene a evitar.
 */
const TOPE_DIAS = 30;

/** `hasta` + `dias`, en el mismo formato. Devuelve la entrada tal cual si no es una fecha. */
export function hastaConAdelanto(hasta: string, dias: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(hasta ?? ''))) return hasta;
  const n = Math.max(0, Math.min(TOPE_DIAS, Math.trunc(Number(dias) || 0)));
  if (!n) return hasta;
  return new Date(Date.parse(`${hasta}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
}

/**
 * El listado recortado al rango que pidió el usuario.
 *
 * 🔑 Se lee UNA sola vez el rango ampliado y de ahí salen los dos usos: la vista recibe este
 * recorte —exactamente lo mismo que le llegaba antes— y la búsqueda por id usa el listado
 * entero. Verificado contra producción el 22/09/2026: recortar por fecha el listado de 8 días
 * devuelve las mismas 1.873 filas que pedir el día suelto, ni una de más ni una de menos.
 *
 * 🪤 Sin esto habría que leer `/ventas` dos veces, y que se lea una sola vez por pantalla es
 * justamente lo que se arregló antes acá: el tablero lo pedía por triplicado.
 */
export function recortarHasta<T extends { fecha?: unknown }>(ventas: T[], hasta: string): T[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(hasta ?? ''))) return ventas;
  /**
   * 🔴 Una fila SIN fecha legible entra igual (la cadena vacía compara como menor). Sin fecha
   * no se sabe si es de hoy o de mañana: dejarla afuera la borra de la pantalla y nadie la
   * factura; dejarla adentro, en el peor caso, muestra un pedido de más y eso se ve.
   */
  return ventas.filter(v => String(v?.fecha ?? '').slice(0, 10) <= hasta);
}
