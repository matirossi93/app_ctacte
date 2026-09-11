import { getPrecioLista } from './infomanager.js';

type PrecioEditado = { cod_articulo: number; cod_lista_precios: number; precio?: number };

/** Conserva precios históricos; al agregar o cambiar lista exige la cotización elegida. */
export async function verificarPreciosEditados(
  items: PrecioEditado[], originales: Array<{ cod_articulo: number; cod_lista_precios?: number | null; precio?: number | null; precio_orig?: number | null }>, costoDistribucion: number,
) {
  const clave = (cod: number, lista: number | null | undefined, precio: number | null | undefined) => `${cod}:${lista}:${Math.round(Number(precio) * 10000)}`;
  const disponibles = new Map<string, number>();
  for (const i of originales) {
    const k = clave(i.cod_articulo, i.cod_lista_precios, i.precio_orig ?? i.precio);
    disponibles.set(k, (disponibles.get(k) ?? 0) + 1);
  }
  for (const i of items) {
    if (i.cod_articulo === costoDistribucion) continue;
    const k = clave(i.cod_articulo, i.cod_lista_precios, i.precio);
    const cantidad = disponibles.get(k) ?? 0;
    if (cantidad > 0) { disponibles.set(k, cantidad - 1); continue; }
    const cotizacion = await getPrecioLista(i.cod_articulo, i.cod_lista_precios);
    const precio = Number(cotizacion?.precio_vta);
    if (!Number.isFinite(precio) || precio <= 0) throw new Error(`El artículo ${i.cod_articulo} no tiene precio verificado en la lista elegida. No se guardó el cambio.`);
    if (!Number.isFinite(i.precio) || Math.abs(Number(i.precio) - precio) > .01) throw new Error(`El precio del artículo ${i.cod_articulo} cambió o no corresponde a la lista elegida. Volvé a seleccionar la lista para actualizarlo antes de guardar.`);
  }
}
