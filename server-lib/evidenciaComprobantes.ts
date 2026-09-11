import { compararFacturaRemito, type RenglonEvidencia, type ResultadoControl } from './controlFacturaRemito.js';

/**
 * La evidencia para comparar una factura con su remito, sacada de lo que la vista YA leyó.
 *
 * Los renglones del día se piden igual para calcular los kilos de los pedidos, y esa respuesta
 * trae los de TODOS los comprobantes del día, factura y remito incluidos. Comparar no cuesta
 * ninguna consulta nueva: sólo quedarse con los ids que hacen falta.
 *
 * 🪤 Se proyecta a `cod_articulo` + `cantidad` + marcadores de unidad, y se descarta el resto.
 * Conservar los renglones crudos de todos los comprobantes en cada vista cacheada multiplicaría
 * la memoria del proceso por la cantidad de rangos guardados.
 */

/**
 * Dónde queda colgada la evidencia dentro de los datos de la vista.
 *
 * 🪤 Un Symbol NO se serializa a JSON: la evidencia no viaja al navegador ni aparece en ninguna
 * respuesta pública, pero sigue disponible para el tablero dentro del mismo proceso.
 */
export const EVIDENCIA = Symbol('evidencia-comprobantes');

/** Lo mínimo de la cabecera para saber que el comprobante es el que dice ser. */
export interface CabeceraMinima {
  id: string;
  tipo_comprobante?: unknown;
  tipo_factura?: unknown;
  numero?: unknown;
  cod_cliente?: unknown;
  cod_empresa?: unknown;
  anulada?: unknown;
}

export interface Evidencia {
  /** Cuándo se leyó lo que hay acá. 🪤 No es "ahora": una vista servida del cache es más vieja. */
  leidoEn: number;
  cabeceras: Map<string, CabeceraMinima>;
  renglones: Map<string, RenglonEvidencia[]>;
}

/** El par a comparar, tal como lo guardamos nosotros. */
export interface ParVinculado {
  im_factura_id?: unknown;
  im_remito_id?: unknown;
  im_factura_numero?: unknown;
  im_factura_tipo?: unknown;
  im_remito_numero?: unknown;
  cod_cliente?: unknown;
  cod_empresa?: unknown;
}

const txt = (v: unknown) => String(v ?? '').trim();
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/**
 * ¿La cabecera leída es el comprobante que dice nuestro registro?
 *
 * 🪤 `leerComprobante` no devuelve el id, así que sin contrastar el NÚMERO se podría estar
 * mirando otra factura del mismo cliente. Cuando el número está guardado, tiene que coincidir.
 */
function esElMismo(c: CabeceraMinima | undefined, tipo: 'FA' | 'RE', par: ParVinculado, numeroGuardado: unknown): boolean {
  if (!c) return false;
  if (txt(c.tipo_comprobante).toUpperCase() !== tipo) return false;
  const cliente = num(par.cod_cliente), empresa = num(par.cod_empresa);
  if (cliente !== null && num(c.cod_cliente) !== cliente) return false;
  if (empresa !== null && num(c.cod_empresa) !== empresa) return false;
  const esperado = num(numeroGuardado);
  if (esperado !== null && num(c.numero) !== esperado) return false;
  // La letra sólo se exige cuando la tenemos guardada: los remitos no llevan.
  const letra = txt(par.im_factura_tipo).replace(/^FA\s*/i, '').toUpperCase();
  if (tipo === 'FA' && letra && txt(c.tipo_factura).toUpperCase() !== letra) return false;
  return true;
}

/**
 * Compara un par contra la evidencia disponible.
 *
 * Cualquier duda —falta un id, el comprobante no está en la evidencia, la identidad no cierra,
 * está anulado— es `no_verificado`. Nunca "coinciden".
 */
export function compararPar(par: ParVinculado, ev: Evidencia | null | undefined): ResultadoControl {
  if (!ev) return { estado: 'no_verificado', motivo: 'No hay datos para comparar en esta pantalla.' };
  const idFa = txt(par.im_factura_id), idRe = txt(par.im_remito_id);
  if (!idFa || !idRe) return { estado: 'no_verificado', motivo: 'Todavía no están emitidos los dos comprobantes.' };

  const cFa = ev.cabeceras.get(idFa), cRe = ev.cabeceras.get(idRe);
  // 🪤 No estar en la evidencia NO es un problema del comprobante: es que su día quedó fuera de
  // lo que esta pantalla leyó. Se dice así, y se ofrece comparar a pedido.
  if (!cFa || !cRe) return { estado: 'no_verificado', motivo: 'Los comprobantes son de días que esta pantalla no trajo. Se puede comparar a pedido.' };
  if (txt(cFa.anulada).toUpperCase() === 'S' || txt(cRe.anulada).toUpperCase() === 'S') {
    return { estado: 'no_verificado', motivo: 'Alguno de los dos está anulado en InfoManager.' };
  }
  if (!esElMismo(cFa, 'FA', par, par.im_factura_numero)) return { estado: 'no_verificado', motivo: 'La factura registrada no coincide con la que hay en InfoManager.' };
  if (!esElMismo(cRe, 'RE', par, par.im_remito_numero)) return { estado: 'no_verificado', motivo: 'El remito registrado no coincide con el que hay en InfoManager.' };

  return compararFacturaRemito(ev.renglones.get(idFa), ev.renglones.get(idRe));
}

/**
 * Arma la evidencia quedándose SÓLO con los comprobantes de los pares que se van a comparar.
 *
 * @param itemsPorComprobante todos los renglones del día, agrupados por comprobante
 * @param ventas              el listado del rango, de donde salen las cabeceras
 * @param pares               lo que tenemos vinculado: define qué ids se conservan
 * @param leidoEn             cuándo se leyó. 🪤 Se pasa: una vista servida del cache no es "ahora".
 */
export function proyectarEvidencia(
  itemsPorComprobante: Map<string, any[]>,
  ventas: any[],
  pares: ParVinculado[],
  leidoEn: number,
): Evidencia {
  const interesan = new Set<string>();
  for (const p of pares) {
    const fa = txt(p.im_factura_id), re = txt(p.im_remito_id);
    if (fa && re) { interesan.add(fa); interesan.add(re); }
  }
  const cabeceras = new Map<string, CabeceraMinima>();
  for (const v of ventas) {
    const id = txt(v?.id);
    if (!interesan.has(id)) continue;
    cabeceras.set(id, {
      id, tipo_comprobante: v.tipo_comprobante, tipo_factura: v.tipo_factura,
      numero: v.numero, cod_cliente: v.cod_cliente, cod_empresa: v.cod_empresa, anulada: v.anulada,
    });
  }
  const renglones = new Map<string, RenglonEvidencia[]>();
  for (const id of interesan) {
    const rs = itemsPorComprobante.get(id);
    if (!rs) continue;
    renglones.set(id, rs.map((it: any) => ({
      cod_articulo: it.cod_articulo,
      // 🪤 CRUDA: normalizarla acá volvería a perder la diferencia entre "0" y "no vino".
      cantidad: it.cantidad,
      cod_uni_venta: it.cod_uni_venta,
      cant_uni_venta: it.cant_uni_venta,
    })));
  }
  return { leidoEn, cabeceras, renglones };
}
