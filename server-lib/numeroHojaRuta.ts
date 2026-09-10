/**
 * QUÉ NÚMERO LE TOCA A LA PRÓXIMA HOJA DE RUTA.
 *
 * 🔑 Es la MISMA serie que la oficina venía llevando a mano en InfoManager, no un contador
 * propio: así pueden decir "la 3402" sin traducir entre dos numeraciones.
 *
 * Mati (10/09/2026): *"al nº de hoja de ruta deberíamos subirle 2 números, para que sea
 * correlativo con las que veníamos haciendo hasta ahora con el panel de IM"* y, después de ver
 * cómo quedaba, *"la 3397 debería ser 3400, la 3398 debería ser 3401 y así"*. Las cinco hojas del
 * panel terminaron en 3400-3404 y la próxima sale 3405.
 *
 * 🪤 El ajuste es un PISO, no una suma. Sumarle 2 a cada hoja nueva haría que la serie avanzara
 * de a tres para siempre; un piso empuja la numeración una sola vez y después queda sin efecto,
 * porque el último número lo supera solo.
 */

/**
 * El número más bajo que puede tener la próxima hoja. Se corre cuando la oficina emite hojas
 * desde InfoManager y la serie del panel queda atrás.
 */
export const NUMERO_MINIMO_HOJA = Number(process.env.HOJA_RUTA_NUMERO_MINIMO) || 3405;

export function proximoNumeroHoja(
  ultimoNumero: number | null | undefined,
  opts?: { minimo?: number },
): number {
  const minimo = Number(opts?.minimo ?? NUMERO_MINIMO_HOJA);
  const ultimo = Number(ultimoNumero);
  // 🪤 Un número basura en la base no puede hacer retroceder la serie ni devolver NaN.
  const siguiente = Number.isFinite(ultimo) && ultimo > 0 ? ultimo + 1 : minimo;
  return Math.max(siguiente, minimo);
}
