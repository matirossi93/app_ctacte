/**
 * El listado de lo que hay que fraccionar: qué producto y en qué paquetes.
 *
 * 🔑 Formato cerrado por Mati (07/09/2026): *"no hace falta aclarar por cliente, sólo nos
 * interesa el producto y la cantidad a fraccionar"* + *"no se puede globalizar cantidades"*.
 * Por eso cada cantidad queda SEPARADA: son paquetes distintos, uno por pedido.
 *
 *     MEZCLA FINA ESPECIAL
 *          30 · 30 · 30 · 30                (4 paq · 120 kg)
 *
 * Así el que fracciona agarra la bolsa una vez y arma los cuatro paquetes.
 *
 * 🪤 Sólo entra lo que se vende POR KILO. Una bolsa cerrada no se fracciona: va como está.
 *
 * 📌 Desde el 08/09/2026 esto sale de la etapa de PRESUPUESTOS, no de la hoja de ruta: Mati,
 * sobre el circuito real, *"dentro de la sección presupuestos debería estar la parte de los
 * productos que son para fraccionar (también se hace antes que el armado de la hoja)"*.
 */

export interface RenglonFraccionable {
  cod_articulo: number | string;
  cantidad: number | string;
}

export interface ArticuloFraccionado {
  descripcion: string;
  unidad_de_medida?: string | null;
}

export interface LineaFraccionado {
  descripcion: string;
  /** Cada cantidad es UN paquete a preparar. De mayor a menor: se arrancan por las grandes. */
  cantidades: number[];
  paquetes: number;
  kg: number;
}

/** Kilo en cualquiera de las formas en que IM lo escribe. */
export function esKilo(unidad: unknown): boolean {
  return /^(kg|kilo|kilos|kilogramo|kilogramos)$/i.test(String(unidad ?? '').trim());
}

/** Dos decimales: 30,1 + 30,2 en punto flotante no da 60,3 y esto se pesa en una balanza. */
const dos = (n: number) => Math.round(n * 100) / 100;

export function armarFraccionado(
  renglones: RenglonFraccionable[],
  catalogo: Map<number, ArticuloFraccionado>,
): LineaFraccionado[] {
  const porProducto = new Map<string, number[]>();
  for (const r of renglones ?? []) {
    const art = catalogo.get(Number(r.cod_articulo));
    const cant = Number(r.cantidad);
    if (!art || !esKilo(art.unidad_de_medida) || !(cant > 0)) continue;
    if (!porProducto.has(art.descripcion)) porProducto.set(art.descripcion, []);
    porProducto.get(art.descripcion)!.push(cant);
  }
  return [...porProducto.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([descripcion, cantidades]) => {
      const l = cantidades.slice().sort((a, b) => b - a);
      return { descripcion, cantidades: l, paquetes: l.length, kg: dos(l.reduce((s, x) => s + x, 0)) };
    });
}

/** Los totales del listado, que es lo que mira el sector de fraccionado antes de arrancar. */
export function totalesFraccionado(lineas: LineaFraccionado[]) {
  return {
    productos: lineas.length,
    paquetes: lineas.reduce((s, f) => s + f.paquetes, 0),
    kg: dos(lineas.reduce((s, f) => s + f.kg, 0)),
  };
}
