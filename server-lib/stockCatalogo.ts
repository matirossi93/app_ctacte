// ═══════════════════════════════════════════════════════════════════════════
// Stock del buscador de pedidos: no creerle a ciegas al listado del depósito.
//
// 🪤 24/09/2026. El buscador marca "sin stock" todo lo que no aparece en
// `/depositos/stock_por_deposito/{dep}`. Pero ese listado de IM tiene agujeros:
// CHIZITO, TUTUCA y TUTUCA STEVIA FLOR DEL NORTE (10710-10712) no figuraban aunque
// `/articulos/stock_existencias/{cod}` daba 110, 75 y 21 en el Depósito General
// — con la compra ya cargada. Medido ese día: de 185 artículos con precio ausentes
// del listado, esos 3 eran los únicos con stock. Pocos, pero son justo los recién
// comprados, que es lo que el vendedor sale a ofrecer.
//
// Por eso: a los ausentes que se pueden vender (tienen precio) se les confirma el
// cero con la consulta puntual antes de marcarlos. Con tope, porque cada consulta
// es una lectura a IM y una búsqueda amplia no puede disparar 80.
// ═══════════════════════════════════════════════════════════════════════════

export const MAX_CONSULTAS_PUNTUALES = 10;

interface ArticuloConStock { cod_articulo: number; hay_stock: boolean | null }

/** Los ausentes del listado (`false`) que tienen precio: esos son los que vale la pena confirmar. */
export function ausentesADudar(pagina: ArticuloConStock[], precios: Map<number, number>): number[] {
  return pagina
    .filter(a => a.hay_stock === false && (precios.get(a.cod_articulo) ?? 0) > 0)
    .slice(0, MAX_CONSULTAS_PUNTUALES)
    .map(a => a.cod_articulo);
}

/**
 * Pasa a "hay stock" lo que la consulta puntual encontró con cantidad positiva y
 * reordena (los que hay, primero). Lo que no se pudo consultar queda como estaba.
 */
export function corregirConStockPuntual<T extends ArticuloConStock>(pagina: T[], puntual: Map<number, number>): T[] {
  const corregida = pagina.map(a =>
    a.hay_stock === false && (puntual.get(a.cod_articulo) ?? 0) > 0 ? { ...a, hay_stock: true } : a);
  return corregida
    .map((a, i) => ({ a, i }))
    .sort((x, y) => Number(y.a.hay_stock === true) - Number(x.a.hay_stock === true) || x.i - y.i)
    .map(x => x.a);
}
