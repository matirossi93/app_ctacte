import { LecturaNoEnviada } from './lecturasCompartidas.js';

/**
 * ¿El fallo lo produjo NUESTRA cola de lecturas, y no InfoManager?
 *
 * Importa para decidir si conviene recordar el fallo. Cuando IM está caído, cachear un ratito
 * evita que cada búsqueda del vendedor se cuelgue los reintentos y que le sigamos pegando a un
 * servicio en problemas. Pero cuando el que dijo que no fue nuestro propio limitador —porque el
 * pre-warm de arranque le ganó los cupos—, recordar ese "no" deja al vendedor sin precios por
 * una decisión nuestra, y el próximo intento probablemente funcione.
 */
export function fueNuestraCola(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  if (e instanceof LecturaNoEnviada) return true;
  /**
   * 🪤 Un error que cruzó un límite de módulo puede llegar sin prototipo. Lo que sobrevive NO
   * es el nombre —`LecturaNoEnviada` hereda `name: "Error"`, verificado— sino la propiedad de
   * instancia `retryable`, que es justamente la marca de "no tiene sentido reintentar esto
   * contra IM porque nunca salió".
   */
  return (e as { retryable?: unknown }).retryable === false;
}
