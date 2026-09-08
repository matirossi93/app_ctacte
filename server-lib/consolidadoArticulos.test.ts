import { describe, it, expect } from 'vitest';
import { armarConsolidado } from './consolidadoArticulos.js';

/**
 * De acá sale una decisión: a quién se le da la mercadería cuando no alcanza para todos.
 * Mati: *"si está más pedido de lo que hay pueda avisar o pueda redistribuir esas cantidades
 * entre los clientes que hicieron el pedido"*.
 */

const CAT = new Map<number, any>([
  [1, { descripcion: 'ALPISTE X 30 KG', unidad_de_medida: 'BOLSA', equivalencia_um: 30 }],
  [2, { descripcion: 'MAIZ QUEBRADO X 30 KG', unidad_de_medida: 'BOLSA', equivalencia_um: 30 }],
]);

function pedido(over: Record<string, any> = {}) {
  return {
    im_comprobante_id: 'c1', im_numero: 58050, cod_cliente: 1,
    cliente_nombre: 'ARON', revision_estado: null, ya_salio: false, ...over,
  };
}

describe('consolidado de artículos', () => {
  it('🔑 suma el MISMO artículo pedido por varios clientes: es la pregunta que no se podía contestar', async () => {
    // El control de a un presupuesto por vez decía que los tres estaban bien: 200 < 300.
    const r = armarConsolidado(
      [pedido(), pedido({ im_comprobante_id: 'c2', cod_cliente: 2, cliente_nombre: 'MORELLI' }),
       pedido({ im_comprobante_id: 'c3', cod_cliente: 3, cliente_nombre: 'GOMEZ' })],
      new Map([['c1', [{ cod_articulo: 1, cantidad: 200 }]],
               ['c2', [{ cod_articulo: 1, cantidad: 200 }]],
               ['c3', [{ cod_articulo: 1, cantidad: 200 }]]]),
      CAT,
      new Map([[1, 300]]),
    );
    expect(r.articulos[0]).toMatchObject({ cod_articulo: 1, pedido: 600, stock: 300, falta: 300, pedidos: 3 });
    expect(r.totales.faltantes).toBe(1);
  });

  it('🔑 reparte lo que hay en proporción a lo pedido', async () => {
    const r = armarConsolidado(
      [pedido(), pedido({ im_comprobante_id: 'c2', cod_cliente: 2, cliente_nombre: 'MORELLI' })],
      new Map([['c1', [{ cod_articulo: 1, cantidad: 100 }]], ['c2', [{ cod_articulo: 1, cantidad: 300 }]]]),
      CAT,
      new Map([[1, 200]]),
    );
    const q = r.articulos[0].quienes;
    // El que más pidió va primero, y le toca la parte que le corresponde: 300/400 de 200.
    expect(q[0]).toMatchObject({ cliente_nombre: 'MORELLI', cantidad: 300, sugerido: 150 });
    expect(q[1]).toMatchObject({ cliente_nombre: 'ARON', cantidad: 100, sugerido: 50 });
  });

  it('si alcanza para todos, a cada uno le toca lo que pidió', async () => {
    const r = armarConsolidado(
      [pedido()], new Map([['c1', [{ cod_articulo: 1, cantidad: 50 }]]]), CAT, new Map([[1, 500]]),
    );
    expect(r.articulos[0]).toMatchObject({ falta: 0 });
    expect(r.articulos[0].quienes[0].sugerido).toBe(50);
  });

  it('🔴 sin stock consultado NO se inventa un faltante: null no es cero', async () => {
    const r = armarConsolidado(
      [pedido()], new Map([['c1', [{ cod_articulo: 1, cantidad: 50 }]]]), CAT, null,
    );
    expect(r.articulos[0]).toMatchObject({ stock: null, falta: null });
    expect(r.totales.sin_stock_consultado).toBe(true);
    // Y sin saber cuánto hay, no se sugiere ningún reparto: se muestra lo pedido.
    expect(r.articulos[0].quienes[0].sugerido).toBe(50);
  });

  it('🔴 con stock NEGATIVO falta todo lo pedido, no una parte', async () => {
    // Pasa de verdad: hay diferencias de inventario y IM devuelve negativos.
    const r = armarConsolidado(
      [pedido()], new Map([['c1', [{ cod_articulo: 1, cantidad: 50 }]]]), CAT, new Map([[1, -20]]),
    );
    expect(r.articulos[0]).toMatchObject({ stock: -20, falta: 50 });
    expect(r.articulos[0].quienes[0].sugerido).toBe(0);
  });

  it('🪤 el mismo artículo en DOS renglones del mismo pedido cuenta una vez, sumado', async () => {
    const r = armarConsolidado(
      [pedido()],
      new Map([['c1', [{ cod_articulo: 1, cantidad: 30 }, { cod_articulo: 1, cantidad: 20 }]]]),
      CAT, new Map([[1, 500]]),
    );
    expect(r.articulos[0].pedido).toBe(50);
    expect(r.articulos[0].quienes).toHaveLength(1);
    expect(r.articulos[0].quienes[0].cantidad).toBe(50);
  });

  it('ordena por lo que más falta, no por lo que más se pidió', async () => {
    const r = armarConsolidado(
      [pedido()],
      new Map([['c1', [{ cod_articulo: 1, cantidad: 100 }, { cod_articulo: 2, cantidad: 1000 }]]]),
      CAT,
      new Map([[1, 10], [2, 5000]]),   // del 1 falta mucho; del 2 sobra
    );
    expect(r.articulos[0].cod_articulo).toBe(1);
  });

  it('un artículo que no está en el catálogo no rompe: se lista con su código', async () => {
    const r = armarConsolidado(
      [pedido()], new Map([['c1', [{ cod_articulo: 999, cantidad: 5 }]]]), CAT, new Map([[999, 5]]),
    );
    expect(r.articulos[0]).toMatchObject({ cod_articulo: 999, descripcion: 'Artículo 999', stock: 5, falta: 0 });
  });

  it('🔴 un artículo que IM no nombra en el stock queda en "no se sabe", NO en cero', async () => {
    // `/depositos/stock_por_deposito` devuelve ~563 filas contra 1.856 artículos habilitados.
    // Con `?? 0` esos artículos salían con falta = todo lo pedido y, como la lista se ordena por
    // faltante, aparecían PRIMEROS. Es el peor lugar posible para un dato inventado.
    const r = armarConsolidado(
      [pedido()], new Map([['c1', [{ cod_articulo: 1, cantidad: 50 }]]]), CAT, new Map([[2, 999]]),
    );
    expect(r.articulos[0]).toMatchObject({ cod_articulo: 1, stock: null, falta: null });
    expect(r.totales.faltantes).toBe(0);
  });

  it('los renglones en cero o sin cantidad no cuentan', async () => {
    // Dar de baja un renglón lo deja en cantidad 0: no se pide más.
    const r = armarConsolidado(
      [pedido()],
      new Map([['c1', [{ cod_articulo: 1, cantidad: 0 }, { cod_articulo: 2, cantidad: 7 }]]]),
      CAT, new Map([[1, 100], [2, 100]]),
    );
    expect(r.articulos).toHaveLength(1);
    expect(r.articulos[0].cod_articulo).toBe(2);
  });

  it('🔴 lo que YA SALIÓ del depósito no se cuenta: su remito ya descontó el stock', async () => {
    // Si se contara, el faltante saldría al DOBLE: la mercadería está restada del stock y
    // sumada en lo pedido a la vez.
    const r = armarConsolidado(
      [pedido({ ya_salio: true }), pedido({ im_comprobante_id: 'c2', cod_cliente: 2, cliente_nombre: 'MORELLI' })],
      new Map([['c1', [{ cod_articulo: 1, cantidad: 300 }]], ['c2', [{ cod_articulo: 1, cantidad: 100 }]]]),
      CAT, new Map([[1, 100]]),
    );
    expect(r.articulos[0]).toMatchObject({ pedido: 100, falta: 0, pedidos: 1 });
    expect(r.articulos[0].quienes[0].cliente_nombre).toBe('MORELLI');
  });

  it('🔴 un pedido SIN facturar cuenta, esté donde esté: su mercadería no salió', async () => {
    // Un retiro en sucursal marcado antes de facturar es un flujo normal. Si no se contara, esa
    // demanda quedaría invisible y se le prometería a otro lo que está apartado.
    const r = armarConsolidado(
      [pedido({ ya_salio: false })],
      new Map([['c1', [{ cod_articulo: 1, cantidad: 80 }]]]),
      CAT, new Map([[1, 50]]),
    );
    expect(r.articulos[0]).toMatchObject({ pedido: 80, falta: 30 });
  });

  it('🔴 avisa cuántos pedidos quedaron sin renglones: el total está incompleto', async () => {
    // Pasa de verdad: la vista trae renglones de 12 días como mucho y acepta rangos de 31, y
    // además se traga con un warn el error de un día entero contra IM.
    const r = armarConsolidado(
      [pedido(), pedido({ im_comprobante_id: 'viejo', cod_cliente: 9, cliente_nombre: 'SIN RENGLONES' })],
      new Map([['c1', [{ cod_articulo: 1, cantidad: 10 }]]]),
      CAT, new Map([[1, 100]]),
    );
    expect(r.totales.sin_renglones).toBe(1);
    expect(r.articulos[0].pedido).toBe(10);
  });

  it('🟠 marca los pedidos con una cantidad sospechosa: pueden estar inflando el artículo', async () => {
    // "30 × MAIZ QUEBRADO X 30 KG" = 900 kg cuando querían 1 bulto. Un renglón así se lleva
    // casi todo el reparto y deja sin nada a los pedidos correctos.
    const r = armarConsolidado(
      [pedido({ cantidad_dudosa: true })],
      new Map([['c1', [{ cod_articulo: 1, cantidad: 900 }]]]),
      CAT, new Map([[1, 100]]),
    );
    expect(r.articulos[0].quienes[0].cantidad_dudosa).toBe(true);
    expect(r.totales.con_cantidad_dudosa).toBe(1);
  });

  it('sin pedidos devuelve vacío, no rompe', async () => {
    const r = armarConsolidado([], new Map(), CAT, new Map());
    expect(r.articulos).toEqual([]);
    expect(r.totales).toMatchObject({ articulos: 0, faltantes: 0 });
  });
});
