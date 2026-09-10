import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 🪤 04/09/2026. El buscador armaba el catálogo con la lista de stock del depósito y
 * DESCARTABA todo lo demás. Un producto sin stock no existía para el vendedor: Mati vio que
 * MANI SABORIZADO PIZZA (772) y PANCETA (775) no se podían cargar y JAMÓN, QUESO y SALAME sí
 * — la única diferencia era que los dos primeros estaban en cero.
 *
 * Medido ese día: de 1.423 artículos del catálogo, el buscador mostraba 563. De los 862 que
 * quedaban afuera, 100 tenían precio en Lista 1, o sea que eran vendibles (CONEJO x 25 kg,
 * PONEDORA, DOGTOR, FLECKY…). Y el botón "buscar en todo el catálogo" sólo aparecía cuando la
 * búsqueda no devolvía NADA, así que con resultados parciales —el caso del maní— el vendedor
 * no tenía forma de enterarse de que faltaban productos.
 *
 * Ahora se muestran todos y el que no tiene stock viaja MARCADO, para que el vendedor lo
 * cargue sabiendo que tiene que confirmarlo con Casa Central.
 */

vi.hoisted(() => {
  process.env.IM_USUARIO_PEDIDOS = 'susana';
  process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret';
});

const im = vi.hoisted(() => ({
  fetchArticulosCatalogo: vi.fn(),
  fetchArticulosDeDeposito: vi.fn(),
  fetchPreciosDeLista: vi.fn(),
  sucursalDelUsuario: vi.fn(),
}));

vi.mock('./infomanager.js', () => ({
  // El cache de /ventas se limpia junto con las vistas (10/09/2026).
  invalidarCacheVentas: vi.fn(),
  fetchArticulosCatalogo: im.fetchArticulosCatalogo,
  fetchArticulosDeDeposito: im.fetchArticulosDeDeposito,
  fetchPreciosDeLista: im.fetchPreciosDeLista,
  fechaArgentina: () => '2026-09-04',
  crearPresupuesto: vi.fn(), anularComprobante: vi.fn(), actualizarPresupuestoCantidades: vi.fn(),
  getItemsComprobante: vi.fn(), presupuestoFacturado: vi.fn(), cabeceraComprobante: vi.fn(),
  fechaComprobante: vi.fn(), desconfirmarPresupuesto: vi.fn(), getPrecioLista: vi.fn(),
  fetchVendedores: vi.fn(), getDisponibleCliente: vi.fn(), fetchClientesIMCached: vi.fn(),
  buscarPresupuestoPorCompatibilidad: vi.fn(),
}));
vi.mock('./perfilUsuario.js', () => ({
  sucursalDelUsuario: im.sucursalDelUsuario,
  filaUsuario: vi.fn(),
}));
vi.mock('./supabase.js', () => ({ sb: vi.fn(), TENANT_ID: 'test-tenant', hasSupabase: () => true }));

const { catalogoPedido } = await import('./pedidos.js');

/** Los cinco maníes del caso real: JAMÓN/QUESO/SALAME con stock, PIZZA/PANCETA en cero. */
const CATALOGO = new Map<number, any>([
  [652, { descripcion: 'MANI SABORIZADO JAMON', cod_rubro: 10 }],
  [772, { descripcion: 'MANI SABORIZADO PIZZA', cod_rubro: 10 }],
  [773, { descripcion: 'MANI SABORIZADO QUESO', cod_rubro: 10 }],
  [774, { descripcion: 'MANI SABORIZADO SALAME', cod_rubro: 10 }],
  [775, { descripcion: 'MANI SABORIZADO PANCETA', cod_rubro: 10 }],
]);
const CON_STOCK = new Set([652, 773, 774]);

async function buscar(q = 'mani') {
  let body: any;
  const req: any = { query: { q, cod_lista: 12 }, user: { rol: 'vendedor', cod_vendedor: 2 } };
  const res: any = { status: () => res, json: (b: any) => { body = b; } };
  await catalogoPedido(req, res);
  return body;
}

beforeEach(() => {
  vi.clearAllMocks();
  im.fetchArticulosCatalogo.mockResolvedValue(CATALOGO);
  im.fetchArticulosDeDeposito.mockResolvedValue(CON_STOCK);
  im.fetchPreciosDeLista.mockResolvedValue(new Map([[652, 4595], [772, 4595], [773, 4595], [774, 4595], [775, 4595]]));
  im.sucursalDelUsuario.mockResolvedValue({ cod_empresa: 1, cod_deposito: 1, punto_de_venta: 1 });
});

describe('catalogoPedido — los productos sin stock se muestran, marcados', () => {
  it('🔴 EL CASO DEL MANÍ: PIZZA y PANCETA aparecen aunque estén en cero', async () => {
    const body = await buscar();
    const cods = body.articulos.map((a: any) => a.cod_articulo).sort((a: number, b: number) => a - b);
    expect(cods).toEqual([652, 772, 773, 774, 775]);
  });

  it('🔴 cada artículo dice si tiene stock en el depósito del vendedor', async () => {
    const body = await buscar();
    const por = Object.fromEntries(body.articulos.map((a: any) => [a.cod_articulo, a.hay_stock]));
    expect(por[652]).toBe(true);
    expect(por[773]).toBe(true);
    expect(por[774]).toBe(true);
    expect(por[772]).toBe(false);
    expect(por[775]).toBe(false);
  });

  it('🔴 los que tienen stock salen PRIMERO', async () => {
    // No es cosmético: la respuesta se corta en 80 artículos. Sin este orden, los sin stock
    // pueden empujar fuera de la página a los que sí hay.
    const body = await buscar();
    const conStock = body.articulos.filter((a: any) => a.hay_stock).map((a: any) => a.cod_articulo);
    const sinStock = body.articulos.filter((a: any) => !a.hay_stock).map((a: any) => a.cod_articulo);
    const orden = body.articulos.map((a: any) => a.cod_articulo);
    expect(orden).toEqual([...conStock, ...sinStock]);
  });

  it('🔴 si IM no contesta el stock, hay_stock es null: "no sé" no es "no hay"', async () => {
    // Marcar todo como sin stock por un hipo de red llenaría la pantalla de advertencias
    // falsas, y el vendedor dejaría de creerles.
    im.fetchArticulosDeDeposito.mockRejectedValue(new Error('IM caído'));
    const body = await buscar();
    expect(body.articulos).toHaveLength(5);
    for (const a of body.articulos) expect(a.hay_stock).toBeNull();
  });

  it('el precio sigue saliendo de la lista, y null cuando no está', async () => {
    im.fetchPreciosDeLista.mockResolvedValue(new Map([[652, 4595]]));
    const body = await buscar();
    const por = Object.fromEntries(body.articulos.map((a: any) => [a.cod_articulo, a.precio_venta]));
    expect(por[652]).toBe(4595);
    expect(por[772]).toBeNull();
    expect(body.hay_precios).toBe(true);
  });
});
