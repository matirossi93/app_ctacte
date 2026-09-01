/**
 * Qué día y qué mes es HOY en Argentina, visto desde el navegador.
 *
 * 🪤 Por qué no alcanza `new Date().getUTCMonth()`: Argentina es UTC-3, así que entre las
 * 21:00 y la medianoche el reloj UTC ya está en el día siguiente. El último día del mes eso
 * adelanta el MES entero, y la pantalla termina pidiendo datos de un mes que no empezó.
 *
 * Tampoco se usa `getMonth()` (hora local del dispositivo): el celular puede estar en
 * cualquier zona horaria, y el mes que le importa a la empresa es el de Tucumán.
 *
 * 📌 Argentina no aplica horario de verano desde 2009, por eso el offset fijo alcanza.
 */

const OFFSET_ARGENTINA_MS = 3 * 60 * 60 * 1000;

/** Hoy en Argentina, formato AAAA-MM-DD (el mismo que devuelve el server). */
export function hoyArgentina(): string {
    return new Date(Date.now() - OFFSET_ARGENTINA_MS).toISOString().slice(0, 10);
}

/** El mes en curso en Argentina. `month` va de 1 a 12, no de 0 a 11. */
export function mesEnCursoArgentina(): { year: number; month: number } {
    const [year, month] = hoyArgentina().split('-').map(Number);
    return { year, month };
}
