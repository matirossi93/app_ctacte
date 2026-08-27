import { describe, it, expect, vi } from 'vitest';
import { parseListaPrecios } from './infomanager.js';

// infomanager.ts corta el proceso al importarse si falta INFOMANAGER_CLIENT_SECRET.
vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });

/**
 * El buscador de productos mostraba `precio_venta` de /articulos/stock, que en IM está muerto:
 * 428 de 1.390 artículos (31%) lo traen en 0 — justo las bolsas, que es lo que vende el
 * mayorista — y cuando trae un número tampoco es el real (PAJARO 4mm figura en $2.203 y se
 * factura a $46.864). El precio bueno sale de /listaprecios/items/{lista}.
 *
 * El swagger de IM no documenta el shape de esa respuesta ("responses: {200: OK}" y nada más),
 * así que el parser acepta varias formas. La regla que no se negocia: ante la duda, SIN precio.
 * Mostrar un precio equivocado es peor que no mostrar ninguno.
 */
describe('parseListaPrecios — el shape no está documentado, hay que ser tolerante', () => {
  it('array pelado', () => {
    const m = parseListaPrecios([
      { cod_articulo: 400, precio_vta: 1573.21 },
      { cod_articulo: 401, precio_vta: 980 },
    ]);
    expect(m.get(400)).toBe(1573.21);
    expect(m.size).toBe(2);
  });

  it('envuelto en results / items / articulos / data', () => {
    for (const clave of ['results', 'items', 'articulos', 'data']) {
      const m = parseListaPrecios({ [clave]: [{ cod_articulo: 7, precio_vta: 15512 }] });
      expect(m.get(7)).toBe(15512);
    }
  });

  it('acepta los nombres de campo que usa el resto de la API', () => {
    expect(parseListaPrecios([{ cod_articulo: 1, precio_venta: 100 }]).get(1)).toBe(100);
    expect(parseListaPrecios([{ codigo: 2, precio: 200 }]).get(2)).toBe(200);
    expect(parseListaPrecios([{ cod: 3, importe: 300 }]).get(3)).toBe(300);
  });

  it('los precios vienen como string y hay que convertirlos', () => {
    // IM manda los importes como texto en varios endpoints (ver parsePrecioLista).
    expect(parseListaPrecios([{ cod_articulo: 50, precio_vta: '14939.50' }]).get(50)).toBe(14939.5);
  });

  it('🪤 un precio en CERO no entra: es exactamente el bug que se está arreglando', () => {
    const m = parseListaPrecios([
      { cod_articulo: 1, precio_vta: 0 },
      { cod_articulo: 2, precio_vta: 16741 },
    ]);
    expect(m.has(1)).toBe(false);
    expect(m.get(2)).toBe(16741);
  });

  it('descarta las filas que no se entienden en vez de inventar', () => {
    const m = parseListaPrecios([
      { cod_articulo: 0, precio_vta: 100 },          // sin código
      { cod_articulo: 5 },                            // sin precio
      { cod_articulo: 6, precio_vta: 'ochocientos' }, // precio no numérico
      { cod_articulo: 7, precio_vta: -50 },           // negativo
      null,
    ]);
    expect(m.size).toBe(0);
  });

  it('una respuesta que no se entiende devuelve vacío, no explota', () => {
    expect(parseListaPrecios(null).size).toBe(0);
    expect(parseListaPrecios(undefined).size).toBe(0);
    expect(parseListaPrecios({}).size).toBe(0);
    expect(parseListaPrecios({ mensaje: 'Ocurrió un error' }).size).toBe(0);
    expect(parseListaPrecios('cualquier cosa').size).toBe(0);
  });
});
