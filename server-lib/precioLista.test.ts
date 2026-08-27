import { describe, it, expect, vi } from 'vitest';
import { parsePrecioLista } from './infomanager.js';

// infomanager.ts corta el proceso al importarse si falta INFOMANAGER_CLIENT_SECRET.
// vi.hoisted corre ANTES de los imports estáticos (mismo patrón que infomanagerRetry.test.ts).
vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });

/**
 * InfoManager contesta HTTP 200 IGUAL cuando hay un error de negocio, con el detalle en el
 * body. Estos cuerpos son respuestas REALES capturadas el 26/08/2026.
 */
describe('parsePrecioLista — IM contesta 200 con el error adentro', () => {
  it('precio válido se parsea', () => {
    const p = parsePrecioLista({
      cod_articulo: 918, descripcion: 'COLLAR AHORQUE CHICO', precio_vta: '590.88',
      iva: 0, precio_con_iva: '590.88', cod_rubro: 11,
    }, 918);
    expect(p?.precio_vta).toBe(590.88);
    expect(p?.descripcion).toBe('COLLAR AHORQUE CHICO');
  });

  it('🪤 el artículo sin precio en esa lista devuelve null, NO un precio 0', () => {
    // Respuesta real de /articulos/precio-ldp?cod_articulo=918&cod_lista=14 (HTTP 200).
    // Antes esto pasaba como precio válido: el renglón se guardaba a $0 y se mandaba
    // así a InfoManager.
    const p = parsePrecioLista({
      mensaje: 'Ocurrió un error al obtener información.',
      detalles: 'El artículo no existe, no se encuentra en la lista seleccionada o su precio es cero.',
      error: -1,
    }, 918);
    expect(p).toBeNull();
  });

  it('un precio en cero tampoco es válido', () => {
    expect(parsePrecioLista({ cod_articulo: 5, descripcion: 'X', precio_vta: 0 }, 5)).toBeNull();
    expect(parsePrecioLista({ cod_articulo: 5, descripcion: 'X', precio_vta: '0.00' }, 5)).toBeNull();
  });

  it('body vacío o sin precio devuelve null', () => {
    expect(parsePrecioLista(null, 1)).toBeNull();
    expect(parsePrecioLista({}, 1)).toBeNull();
    expect(parsePrecioLista({ cod_articulo: 1, descripcion: 'X' }, 1)).toBeNull();
  });

  it('error: 0 no es un error (por si IM alguna vez lo manda así)', () => {
    expect(parsePrecioLista({ cod_articulo: 1, descripcion: 'X', precio_vta: 10, error: 0 }, 1)?.precio_vta).toBe(10);
  });

  it('acepta la forma envuelta en results[] o array', () => {
    expect(parsePrecioLista({ results: [{ cod_articulo: 7, descripcion: 'A', precio_vta: 12.5 }] }, 7)?.precio_vta).toBe(12.5);
    expect(parsePrecioLista([{ cod_articulo: 7, descripcion: 'A', precio_vta: 12.5 }], 7)?.precio_vta).toBe(12.5);
  });
});
