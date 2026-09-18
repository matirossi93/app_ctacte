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
  subrubro?: string | null;
}

/**
 * 🔑 LO QUE SE FABRICA ACÁ, no se fracciona.
 *
 * Mati (16/09/2026): *"necesito que incluyamos también en el reporte de fraccionados los
 * balanceados de producción propia y el maíz quebrado, es mercadería que producimos y necesitamos
 * saber también para que produzcan la gente de producción"*.
 *
 * Son bolsas cerradas —"CERDO X 40 KG", "MAIZ QUEBRADO FINO X 30 KG"— así que el fraccionado las
 * deja afuera con razón: no hay nada que pesar. Pero el sector de producción necesita el número
 * igual, y sale de los mismos pedidos.
 */
export const SUBRUBROS_PRODUCCION = ['semillero', 'quebrados'];

export interface LineaProduccion {
  cod_articulo: number;
  descripcion: string;
  subrubro: string;
  /** Bolsas a producir. Es la cantidad pedida: estos artículos se venden por bolsa. */
  bolsas: number;
  /** Kilos, cuando la presentación los declara ("X 40 KG"). */
  kg: number | null;
}

/** Qué hay que producir, por artículo, con el mismo criterio que arma el fraccionado. */
export function armarProduccion(
  renglones: RenglonFraccionable[],
  catalogo: Map<number, ArticuloFraccionado>,
): LineaProduccion[] {
  const por = new Map<number, LineaProduccion>();
  for (const r of renglones ?? []) {
    const cod = Number(r.cod_articulo);
    const art = catalogo.get(cod);
    const cant = Number(r.cantidad);
    if (!art || !(cant > 0)) continue;
    const sub = String(art.subrubro ?? '').trim().toLowerCase();
    if (!SUBRUBROS_PRODUCCION.includes(sub)) continue;
    // Los kilos por bolsa salen de la presentación, que es donde IM los declara de verdad.
    const m = /X\s*(\d+(?:[.,]\d+)?)\s*(?:KG|KILOS?|K)\b/i.exec(String(art.descripcion ?? ''));
    const kgPorBolsa = m ? Number(String(m[1]).replace(',', '.')) : null;
    const prev = por.get(cod);
    const bolsas = (prev?.bolsas ?? 0) + cant;
    por.set(cod, {
      cod_articulo: cod, descripcion: art.descripcion, subrubro: String(art.subrubro ?? '').trim(),
      bolsas, kg: kgPorBolsa ? dos(bolsas * kgPorBolsa) : null,
    });
  }
  return [...por.values()].sort((a, b) =>
    a.subrubro.localeCompare(b.subrubro) || a.descripcion.localeCompare(b.descripcion));
}

export interface LineaFraccionado {
  cod_articulo: number;
  descripcion: string;
  /** Cada cantidad es UN paquete a preparar. De mayor a menor: se arrancan por las grandes. */
  cantidades: number[];
  paquetes: number;
  kg: number;
  /**
   * Bolsas cerradas de este producto que NO hay que fraccionar: la cantidad pedida era un
   * múltiplo exacto del formato. Se informan para que el sector sepa que se contemplaron y no
   * las busque (Mati, 09/09/2026: *"si dice 60 kilos, son 2 bolsas de 30"*).
   */
  bolsas_enteras: number;
  formato_bolsa: number | null;
  /**
   * 🔴 No hay kilaje de bolsa cargado para este producto. La pantalla lo marca y ofrece
   * cargarlo: sin el dato las cantidades van enteras, sin partir (ver `paquetesDelRenglon`).
   */
  sin_formato: boolean;
  /**
   * Las cantidades TAL COMO LAS PIDIÓ el cliente, sin interpretar. Mati (17/09/2026) pidió
   * poder ver el pedido crudo al lado del desglose: mientras falte el kilaje es lo único con
   * lo que el sector puede armar el paquete a mano, y cuando está sirve para controlar.
   */
  pedidos: number[];
}

/** Kilo en cualquiera de las formas en que IM lo escribe. */
export function esKilo(unidad: unknown): boolean {
  return /^(kg|kilo|kilos|kilogramo|kilogramos)$/i.test(String(unidad ?? '').trim());
}

/** Dos decimales: 30,1 + 30,2 en punto flotante no da 60,3 y esto se pesa en una balanza. */
const dos = (n: number) => Math.round(n * 100) / 100;

/**
 * Lo máximo que el sector fracciona en un paquete.
 *
 * Mati (09/09/2026): *"no se fracciona más de 10 kilos"*. Un pedido de 100 kg no es un paquete
 * de 100: son diez de 10.
 */
export const MAX_FRACCION_KG = 10;

/**
 * ¿Este producto se fracciona?
 *
 * 🔴 Antes esto miraba SÓLO `unidad_de_medida`, y por eso MEZCLA GALLO PREMIUM no salía en el
 * listado aunque estuviera pedida (Mati, 09/09/2026): el artículo 491 tiene ese campo **vacío**
 * en InfoManager, mientras las otras mezclas dicen "Kilos" o "KG". El campo está vacío en el 72%
 * del catálogo, así que no alcanza solo.
 *
 * Ahora se combinan tres señales, de la más confiable a la menos:
 *  1. La unidad dice kilo → granel.
 *  2. La descripción trae la bolsa cerrada ("ALPISTE X 30 KG") → NO se fracciona, va como está.
 *  3. Sin unidad: `equivalencia_um: 1` es granel (se vende de a kilo). Un comedero o un collar
 *     tienen 0 y no se fraccionan aunque tampoco sean un bulto.
 *  4. Y si de los pedidos se dedujo un formato de bolsa, es granel embolsado: entra.
 */
export function seFracciona(
  art: { descripcion?: string | null; unidad_de_medida?: string | null; equivalencia_um?: number | string | null },
  formatoBolsa?: number | null,
): boolean {
  // Una bolsa cerrada no se fracciona: se entrega tal cual.
  if (/X\s*\d+(?:[.,]\d+)?\s*(?:KG|KILOS?|K)\b/i.test(String(art.descripcion ?? ''))) return false;
  if (esKilo(art.unidad_de_medida)) return true;
  if (formatoBolsa && formatoBolsa > 0) return true;
  const equiv = Number(art.equivalencia_um);
  return !String(art.unidad_de_medida ?? '').trim() && equiv === 1;
}

export type PaquetesRenglon =
  | { fracciona: false; bolsas: number; formato: number }
  /**
   * Con `bolsas`, el renglón es MIXTO: bolsas cerradas del depósito + el resto a pesar.
   * Con `sin_formato`, no se sabe cuánto trae la bolsa y la cantidad va entera, sin partir.
   */
  | { fracciona: true; paquetes: number[]; bolsas?: number; formato?: number; sin_formato?: true };

/**
 * En cuántos paquetes se parte un renglón.
 *
 * Mati (09/09/2026): *"si dice 60 kilos, no son 60 kilos fraccionados, son 2 bolsas de 30... si
 * son 90 kilos, son 3 bolsas de 30, que ya viene fraccionada la bolsa. Todo lo que no coincida
 * con el equivalente a la bolsa se fracciona en 10 kilos o menos"*.
 *
 * 🔑 O sea que un múltiplo exacto de la bolsa **no se fracciona**: el sector agarra las bolsas
 * cerradas del depósito y listo. Mandarlo al listado le hacía preparar a mano 60 kg que ya
 * estaban preparados.
 */
export function paquetesDelRenglon(cantidad: number, formatoBolsa: number | null): PaquetesRenglon {
  const q = dos(Number(cantidad));
  let enteras = 0;
  if (formatoBolsa && formatoBolsa > 0) {
    const bolsas = q / formatoBolsa;
    // 🪤 Con decimales, `q % formato === 0` falla por punto flotante: se compara redondeando.
    if (bolsas >= 1 && Math.abs(bolsas - Math.round(bolsas)) < 1e-9) {
      return { fracciona: false, bolsas: Math.round(bolsas), formato: formatoBolsa };
    }
    /**
     * 🔑 LAS BOLSAS ENTERAS SE AGARRAN DEL DEPÓSITO; SÓLO EL RESTO SE PESA.
     *
     * Mati (16/09/2026), sobre los kilos que exceden la bolsa: *"veníamos facturando esos kg
     * extra fraccionados"*. Antes, una cantidad que no fuera múltiplo exacto se fraccionaba
     * ENTERA: 30 kg de mijo con bolsa de 25 salían como tres paquetes de 10 en vez de una bolsa
     * cerrada más 5 kg. Medido sobre 16 días, eran 86 renglones de trabajo de más.
     */
    enteras = Math.floor(bolsas + 1e-9);
  }
  /**
   * 🔴 SIN KILAJE DE BOLSA NO SE INVENTA NADA.
   *
   * Mati (17/09/2026): *"el sorgo no se está contemplando la bolsa... quizás acá sea mejor que
   * directamente se ponga las cantidades textual como está en el pedido"*.
   *
   * Partir en paquetes de 10 a un producto del que no sabemos el formato no es decir "no sé":
   * es afirmar que hay que abrir la bolsa y pesar. Con el sorgo —bolsa de 40— eran cuatro
   * paquetes de trabajo sobre mercadería que ya venía preparada. La cantidad va como vino y la
   * pantalla pide que le carguen el kilaje, que es lo único que resuelve el caso de verdad.
   */
  if (!(formatoBolsa && formatoBolsa > 0)) return { fracciona: true, paquetes: [q], sin_formato: true };

  const paquetes: number[] = [];
  let resta = enteras > 0 ? dos(q - enteras * formatoBolsa) : q;
  while (resta > MAX_FRACCION_KG + 1e-9) {
    paquetes.push(MAX_FRACCION_KG);
    resta = dos(resta - MAX_FRACCION_KG);
  }
  // 🪤 Sin el redondeo aparecían paquetes de 0.00000001 al final de una resta con decimales.
  if (resta > 1e-9) paquetes.push(dos(resta));
  return enteras > 0
    ? { fracciona: true, paquetes, bolsas: enteras, formato: formatoBolsa }
    : { fracciona: true, paquetes };
}

export function armarFraccionado(
  renglones: RenglonFraccionable[],
  catalogo: Map<number, ArticuloFraccionado>,
  /** El formato de bolsa de cada producto a granel, deducido de los pedidos (formatosBolsa.ts). */
  formatos?: Map<number, number>,
): LineaFraccionado[] {
  const porProducto = new Map<number, { descripcion: string; paquetes: number[]; bolsas: number; formato: number | null; pedidos: number[] }>();
  for (const r of renglones ?? []) {
    const cod = Number(r.cod_articulo);
    const art = catalogo.get(cod);
    const cant = Number(r.cantidad);
    if (!art || !(cant > 0)) continue;
    const formato = formatos?.get(cod) ?? null;
    if (!seFracciona(art, formato)) continue;

    if (!porProducto.has(cod)) porProducto.set(cod, { descripcion: art.descripcion, paquetes: [], bolsas: 0, formato, pedidos: [] });
    const acc = porProducto.get(cod)!;
    if (acc.formato == null && formato != null) acc.formato = formato;
    acc.pedidos.push(dos(cant));

    /**
     * 🔑 Cada renglón se parte según la regla del sector: si la cantidad es un múltiplo exacto
     * de la bolsa son bolsas cerradas y NO se fraccionan; si no, va en paquetes de 10 kg o
     * menos (Mati, 09/09/2026).
     */
    const p = paquetesDelRenglon(cant, formato);
    if (p.fracciona) {
      acc.paquetes.push(...p.paquetes);
      // Un renglón mixto aporta las dos cosas: bolsas cerradas y paquetes a pesar.
      acc.bolsas += p.bolsas ?? 0;
    } else acc.bolsas += p.bolsas;
  }
  return [...porProducto.entries()]
    .sort((a, b) => a[1].descripcion.localeCompare(b[1].descripcion) || a[0] - b[0])
    // Un producto que sólo tenía bolsas enteras no se fracciona, pero igual se informa.
    .map(([cod_articulo, acc]) => {
      const l = acc.paquetes.slice().sort((a, b) => b - a);
      return {
        cod_articulo, descripcion: acc.descripcion, cantidades: l, paquetes: l.length,
        kg: dos(l.reduce((s, x) => s + x, 0)),
        bolsas_enteras: acc.bolsas,
        formato_bolsa: acc.formato,
        sin_formato: acc.formato == null,
        pedidos: acc.pedidos.slice().sort((a, b) => b - a),
      };
    })
    .filter(l => l.paquetes > 0 || l.bolsas_enteras > 0);
}

/** Los totales del listado, que es lo que mira el sector de fraccionado antes de arrancar. */
export function totalesFraccionado(lineas: LineaFraccionado[]) {
  return {
    productos: lineas.length,
    paquetes: lineas.reduce((s, f) => s + f.paquetes, 0),
    kg: dos(lineas.reduce((s, f) => s + f.kg, 0)),
  };
}
