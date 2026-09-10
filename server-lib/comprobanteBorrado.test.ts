import { describe, expect, it } from 'vitest';
import { comprobanteNoExiste, esComprobanteBorrado } from './comprobanteBorrado.js';

/** Error estilo axios con el body que devuelve IM. */
const err = (status: number, data?: unknown) => ({ response: { status, data } });

describe('esComprobanteBorrado', () => {
  it('reconoce el 500 exacto que devolvió IM por la factura 50401 borrada', () => {
    expect(esComprobanteBorrado(err(500, {
      mensaje: 'Ocurrió un error al obtener información.',
      detalles: 'No se encontraron datos para el id: 58779252',
    }))).toBe(true);
  });

  it('lo reconoce también si IM manda el body como texto plano', () => {
    expect(esComprobanteBorrado(err(500, 'No se encontraron datos para el id: 1'))).toBe(true);
  });

  // 🔴 El que no puede fallar: un 500 cualquiera NO es "no existe". Darlo por borrado tira el
  // registro de una factura viva y el pedido se factura de nuevo.
  it('un 500 genérico NO es un comprobante borrado', () => {
    expect(esComprobanteBorrado(err(500, { mensaje: 'Ocurrió un error al obtener información.' }))).toBe(false);
    expect(esComprobanteBorrado(err(500))).toBe(false);
    expect(esComprobanteBorrado(err(500, 'Se superó el límite de solicitudes por hora para este cliente'))).toBe(false);
  });

  it('un timeout o una caída de red tampoco', () => {
    expect(esComprobanteBorrado({ code: 'ECONNABORTED' })).toBe(false);
    expect(esComprobanteBorrado(new Error('socket hang up'))).toBe(false);
    expect(esComprobanteBorrado(undefined)).toBe(false);
  });

  it('otros status con el mismo texto no cuentan como borrado', () => {
    expect(esComprobanteBorrado(err(502, { detalles: 'No se encontraron datos para el id: 5' }))).toBe(false);
  });
});

describe('comprobanteNoExiste', () => {
  it('el 404 de siempre sigue siendo "no existe"', () => {
    expect(comprobanteNoExiste(err(404))).toBe(true);
  });

  it('y el 500 con el texto de IM también', () => {
    expect(comprobanteNoExiste(err(500, { detalles: 'No se encontraron datos para el id: 9' }))).toBe(true);
  });

  it('un 429 (cuota horaria agotada) NO es "no existe"', () => {
    expect(comprobanteNoExiste(err(429, { mensaje: 'Se superó el límite de solicitudes por hora para este cliente' }))).toBe(false);
  });
});
