/**
 * QUÉ SUBTIPO DE NOTA DE CRÉDITO CORRESPONDE A UNA CORRECCIÓN.
 *
 * Mati (21/09/2026): *"DE es hay que cambiar la cantidad o algún producto... financiera si es
 * sólo por un tema de precios! dc es por dif en el tipo de cambio"*.
 *
 * InfoManager lo exige en la API v2 (`tipo_nc`) y el campo no existe en la v1, así que no se
 * puede deducir de las notas ya emitidas. Pero tampoco hace falta que alguien lo elija en una
 * pantalla: `calcularCorreccion` ya separa las dos causas —la cantidad y el precio— y el subtipo
 * sale del mismo diff. Una cosa menos que tildar, y una cosa menos que tildar mal.
 *
 * 🪤 DC (diferencia de cotización) NO se contempla: el circuito factura en pesos. Si algún día se
 * vende en dólares esto tiene que volver a mirarse en serio — no alcanza con agregar el valor al
 * tipo, porque la diferencia de cambio no se deduce comparando cantidades y precios.
 */
export type SubtipoCorreccion = 'DE' | 'FI';

export interface RenglonComparable {
  cod_articulo: number | string;
  cantidad: number | string;
  precio?: number | string | null;
  descuento_porc?: number | string | null;
}

/** Cantidades y precios se comparan con tolerancia de centavo: son números con decimales. */
const CERO = 1e-9;
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Cuánto se lleva de cada artículo, sumando los renglones repetidos. */
function porArticulo(rs: RenglonComparable[]) {
  const m = new Map<number, { cantidad: number; neto: number }>();
  for (const r of rs ?? []) {
    const cod = Number(r?.cod_articulo);
    if (!Number.isFinite(cod)) continue;
    const q = num(r?.cantidad);
    const d = Math.max(0, Math.min(100, num(r?.descuento_porc)));
    const neto = num(r?.precio) * (1 - d / 100);
    const acc = m.get(cod) ?? { cantidad: 0, neto: 0 };
    // El neto unitario del artículo: el del último renglón que lo trae con cantidad.
    m.set(cod, { cantidad: acc.cantidad + q, neto: q > CERO ? neto : acc.neto });
  }
  return m;
}

/**
 * `DE` si se movió mercadería, `FI` si sólo cambió plata, `null` si no cambió nada.
 *
 * 🔴 Cuando cambian las dos cosas manda **DE**: la mercadería es la que se mueve de verdad, y
 * emitir FI dejaría a InfoManager sin esperar el movimiento de stock de los bultos que volvieron.
 */
export function subtipoDeCorreccion(
  originales: RenglonComparable[],
  finales: RenglonComparable[],
): SubtipoCorreccion | null {
  const viejos = porArticulo(originales);
  const nuevos = porArticulo(finales);
  const codigos = new Set([...viejos.keys(), ...nuevos.keys()]);

  let cambioPrecio = false;
  for (const cod of codigos) {
    const v = viejos.get(cod);
    const n = nuevos.get(cod);
    // Un artículo que aparece o desaparece es un cambio de cantidad contra cero.
    if (Math.abs((n?.cantidad ?? 0) - (v?.cantidad ?? 0)) > CERO) return 'DE';
    if (v && n && Math.abs(n.neto - v.neto) > CERO) cambioPrecio = true;
  }
  return cambioPrecio ? 'FI' : null;
}
