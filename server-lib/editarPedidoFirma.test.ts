import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });
vi.mock('./supabase.js', () => ({ sb: vi.fn(), TENANT_ID: 't', hasSupabase: () => true }));

const { firmaRenglones, emparejarRenglonesIM } = await import('./pedidos.js');

/**
 * Al editar un pedido, la app decide entre dos caminos: si el surtido, las listas y los
 * descuentos son los mismos, le manda a IM sólo las cantidades nuevas y conserva el número de
 * presupuesto; si cambió algo más, anula y crea uno nuevo (que es lo único que IM soporta).
 *
 * Esa decisión y el emparejado con los renglones de IM son el código que más plata mueve del
 * módulo, y hasta el 27/08/2026 no tenían un solo test.
 */

const r = (cod: number, lista: number, desc = 0) => ({ cod_articulo: cod, cod_lista: lista, descuento_porc: desc });

describe('firmaRenglones — cuándo alcanza con actualizar cantidades', () => {
  it('el mismo surtido en el mismo orden da la misma firma', () => {
    expect(firmaRenglones([r(100, 12), r(200, 13)])).toBe(firmaRenglones([r(100, 12), r(200, 13)]));
  });

  it('cambiar una lista cambia la firma', () => {
    expect(firmaRenglones([r(100, 12)])).not.toBe(firmaRenglones([r(100, 13)]));
  });

  it('cambiar un descuento cambia la firma', () => {
    // IM no deja cambiar el descuento de un renglón existente: tiene que caer en recrear.
    expect(firmaRenglones([r(100, 12, 0)])).not.toBe(firmaRenglones([r(100, 12, 25)]));
  });

  it('la cantidad NO entra en la firma: para eso está el camino barato', () => {
    const a = [{ cod_articulo: 100, cod_lista: 12, descuento_porc: 0, cantidad: 5 }];
    const b = [{ cod_articulo: 100, cod_lista: 12, descuento_porc: 0, cantidad: 99 }];
    expect(firmaRenglones(a)).toBe(firmaRenglones(b));
  });

  it('🔴 el ORDEN importa: dar vuelta dos renglones del mismo artículo cambia la firma', () => {
    // 🪤 Acá estaba el agujero. La firma ordenaba, así que estos dos daban igual y se tomaba
    // el camino barato — pero el emparejado con IM es por posición, así que las cantidades
    // se aplicaban CRUZADAS. Cada renglón de IM tiene su precio congelado desde que se creó,
    // o sea que la cantidad de uno se facturaba al precio del otro.
    // Pasa de verdad: el vendedor borra un renglón y lo vuelve a cargar, y queda al final.
    expect(firmaRenglones([r(100, 12), r(100, 14)]))
      .not.toBe(firmaRenglones([r(100, 14), r(100, 12)]));
  });

  it('el orden también importa entre artículos distintos', () => {
    expect(firmaRenglones([r(100, 12), r(200, 12)]))
      .not.toBe(firmaRenglones([r(200, 12), r(100, 12)]));
  });
});

describe('emparejarRenglonesIM — a qué renglón de IM le corresponde cada cantidad', () => {
  it('un artículo por renglón', () => {
    expect(emparejarRenglonesIM(
      [{ cod_articulo: 100, cantidad: 5 }, { cod_articulo: 200, cantidad: 3 }],
      [{ id: 1, cod_articulo: 100 }, { id: 2, cod_articulo: 200 }],
    )).toEqual([{ id: 1, cantidad: 5 }, { id: 2, cantidad: 3 }]);
  });

  it('🪤 el mismo artículo dos veces va a DOS renglones de IM, no dos veces al mismo', () => {
    // Antes era un Map cod_articulo -> id, que se quedaba con uno solo: los dos updates
    // pisaban el mismo renglón de IM y el otro se quedaba con la cantidad vieja.
    expect(emparejarRenglonesIM(
      [{ cod_articulo: 100, cantidad: 10 }, { cod_articulo: 100, cantidad: 5 }],
      [{ id: 1, cod_articulo: 100 }, { id: 2, cod_articulo: 100 }],
    )).toEqual([{ id: 1, cantidad: 10 }, { id: 2, cantidad: 5 }]);
  });

  it('respeta el orden de aparición, intercalado con otros artículos', () => {
    expect(emparejarRenglonesIM(
      [{ cod_articulo: 100, cantidad: 1 }, { cod_articulo: 200, cantidad: 2 }, { cod_articulo: 100, cantidad: 3 }],
      [{ id: 1, cod_articulo: 100 }, { id: 2, cod_articulo: 200 }, { id: 3, cod_articulo: 100 }],
    )).toEqual([{ id: 1, cantidad: 1 }, { id: 2, cantidad: 2 }, { id: 3, cantidad: 3 }]);
  });

  it('si IM tiene MENOS renglones de ese artículo, devuelve null: hay que frenar', () => {
    expect(emparejarRenglonesIM(
      [{ cod_articulo: 100, cantidad: 1 }, { cod_articulo: 100, cantidad: 2 }],
      [{ id: 1, cod_articulo: 100 }],
    )).toBeNull();
  });

  it('un artículo que IM no tiene devuelve null, no lo saltea', () => {
    // 🪤 Antes se filtraban los que no matcheaban y se comparaban longitudes; si sobraba uno
    // en IM el conteo podía dar bien igual. Ahora cualquier renglón sin pareja frena.
    expect(emparejarRenglonesIM(
      [{ cod_articulo: 999, cantidad: 1 }],
      [{ id: 1, cod_articulo: 100 }],
    )).toBeNull();
  });

  it('a IM le pueden sobrar renglones y los que emparejan igual se resuelven', () => {
    expect(emparejarRenglonesIM(
      [{ cod_articulo: 100, cantidad: 7 }],
      [{ id: 1, cod_articulo: 100 }, { id: 2, cod_articulo: 200 }],
    )).toEqual([{ id: 1, cantidad: 7 }]);
  });
});
