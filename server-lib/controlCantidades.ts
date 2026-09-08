/**
 * Control de las cantidades de un pedido, contra el formato en que se vende el producto.
 *
 * Mati (08/09/2026), sobre lo que revisa Jorgelina: *"se fija también que las cantidades están
 * bien (si es una bolsa de alpiste, que diga 25 kg y no 30 kg por ejemplo)"*.
 *
 * 🔑 EL ERROR QUE SE PUEDE DETECTAR SIN ADIVINAR: cargar los **kilos** donde van los **bultos**.
 * Un artículo que viene en bolsa de 30 kg se pide de a 1, 2, 3 bolsas; si el renglón dice 30,
 * son 900 kg — treinta bolsas. Medido contra IM sobre 8.623 renglones de 30 días (10/08 al
 * 08/09/2026): la regla marca **8 renglones**, y todos son de los que hay que mirar:
 *
 *     30 × MAIZ QUEBRADO MEDIANO X 30 KG  =   900 kg   (lo habitual ahí: 2 bolsas)
 *     40 × INICIADOR X 40 KG              = 1.600 kg   (lo habitual ahí: 1 bolsa)
 *     20 × PIEDRAS SANITARIAS X 20 KG     =   400 kg
 *
 * 🪤 Las variantes más amplias no sirven: "cantidad = kilos por bulto" a secas marca 83
 * renglones en 30 días (10 bolsas de un alimento de 10 kg es una venta normal), y "cantidad
 * nunca vista para ese artículo" marcaba el 35% de los pedidos — con eso nadie mira ninguno.
 * El corte por peso es lo que separa el error del pedido grande legítimo.
 *
 * ⚠️ Es un AVISO, no un bloqueo: 900 kg de maíz puede ser un pedido real de un cliente grande.
 * Lo que hace es ponerlo adelante de los ojos de quien revisa.
 *
 * 📌 Lo que NO se puede controlar así: los productos a **granel** (alpiste, avena, mezclas).
 * Ahí la cantidad son kilos sueltos y el "formato de bolsa" no existe en InfoManager — el
 * catálogo dice `equivalencia_um: 1`. Para eso haría falta cargar el formato de cada producto.
 */

export interface RenglonControlado {
  cod_articulo: number | string;
  cantidad: number | string;
}

export interface ArticuloControlado {
  descripcion: string;
  /** Kilos por bulto. 1 (o vacío) = se vende suelto por kilo. */
  equivalencia_um?: number | null;
}

export interface AvisoCantidad {
  cod_articulo: number;
  descripcion: string;
  cantidad: number;
  kg_por_bulto: number;
  kg_total: number;
  texto: string;
}

/**
 * Desde cuántos kilos un renglón "cantidad = kilos por bulto" pasa a ser sospechoso.
 *
 * Con 300 kg quedan 8 avisos en 30 días. Bajarlo a cero da 83 (se llena de ventas normales);
 * subirlo a 500 deja 5 y se pierden los de 400 kg, que también valen la pena.
 */
const KG_SOSPECHOSO = Number(process.env.CONTROL_CANTIDAD_KG || 300);

export function revisarCantidades(
  renglones: RenglonControlado[],
  catalogo: Map<number, ArticuloControlado>,
): AvisoCantidad[] {
  const avisos: AvisoCantidad[] = [];
  for (const r of renglones ?? []) {
    const cod = Number(r.cod_articulo);
    const cant = Number(r.cantidad);
    const art = catalogo.get(cod);
    const eq = Number(art?.equivalencia_um);
    if (!art || !Number.isFinite(cant) || !Number.isFinite(eq) || eq <= 1) continue;
    if (cant !== eq) continue;                       // la cantidad no coincide con el formato
    const kg = cant * eq;
    if (kg < KG_SOSPECHOSO) continue;                // 10 bolsas de 10 kg es una venta normal
    avisos.push({
      cod_articulo: cod,
      descripcion: art.descripcion,
      cantidad: cant,
      kg_por_bulto: eq,
      kg_total: Math.round(kg * 100) / 100,
      texto: `${art.descripcion}: dice ${cant} y el bulto es de ${eq} kg, o sea ${Math.round(kg)} kg. ¿No querían ${cant} kilos (${Math.round(cant / eq * 100) / 100} bultos)?`,
    });
  }
  return avisos;
}
