import { expect, it } from 'vitest';
import { estadoEsperado } from '../scripts/verificar-despliegue.mjs';
const expected = 'a'.repeat(64);
const correcto = { listo:true, esquema_listo:true, esquema_requerido:42, version:expected };
it('requiere identidad exacta y esquema listo, no sólo un HTTP 200', () => {
  expect(estadoEsperado(correcto, expected)).toBe(true);
  for (const dato of [null, {}, {...correcto,version:'b'.repeat(64)}, {...correcto,esquema_listo:false}, {...correcto,esquema_requerido:40}, {...correcto,listo:false}]) expect(estadoEsperado(dato,expected)).toBe(false);
});
