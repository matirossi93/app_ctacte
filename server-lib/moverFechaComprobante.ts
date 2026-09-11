/**
 * MOVER LA FECHA DE UN COMPROBANTE YA EMITIDO.
 *
 * Mati (10/09/2026): *"necesito que podamos editar la fecha de la factura dentro de la app"*.
 * Pasa seguido porque la oficina factura hoy el reparto de mañana: si se equivocan de día, la
 * factura queda corrida y el pedido no aparece donde lo buscan.
 *
 * 🔑 La fecha es UNO DE LOS TRES CAMPOS que `VentasActualizar` deja tocar de un comprobante
 * emitido —los otros son observaciones y anulada—. Los renglones y los importes no se pueden:
 * para eso están las notas de crédito y débito.
 *
 * 🔴 EL PUT ES UN REEMPLAZO, NO UN PARCHE. El schema exige nueve campos y acepta otros ocho, y lo
 * que no se manda se pierde. Mover la fecha con un cuerpo mínimo **borra los campos AFIP** y la
 * factura vuelve a salir por el controlador fiscal, que es lo que se arregló el 10/09/2026. Por
 * eso el cuerpo se arma desde la cabecera que el comprobante YA tiene y sólo se le cambia la
 * fecha.
 */

/** Lo que hace falta de `GET /ventas/{id}` para poder reescribir la cabecera sin perder nada. */
export interface CabeceraCruda {
  tipo_comprobante?: string | null;
  tipo_factura?: string | null;
  numero?: number | string | null;
  punto_de_venta?: number | string | null;
  tag?: string | null;
  condicion_venta_tipo?: number | string | null;
  observaciones?: string | null;
  fac_electronica?: number | string | null;
  anulada?: string | null;
  afip_comprobantes_fe?: string | null;
  afip_conceptos_fe?: number | string | null;
  afip_tipdoc_fe?: number | string | null;
  afip_cond_vta?: number | string | null;
  afip_cod_barra?: string | null;
  cae?: string | null;
  fecha_cae?: string | null;
  fecha?: string | null;
}

/** `2026-09-12`, que es como las guarda IM. Acepta que venga con hora y se queda con el día. */
const SOLO_FECHA = /^\d{4}-\d{2}-\d{2}$/;

export function diaValido(v: unknown): string {
  const s = String(v ?? '').slice(0, 10);
  if (!SOLO_FECHA.test(s)) throw new Error('La fecha tiene que ser del tipo 2026-09-12.');
  // 🪤 El formato solo no alcanza: "2026-13-01" lo pasa y no existe.
  const d = new Date(`${s}T12:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new Error(`La fecha ${s} no existe.`);
  }
  return s;
}

/**
 * El cuerpo del `PUT /ventas/{id}` para dejar el comprobante igual, con otra fecha.
 *
 * Función pura: es donde se decide qué se conserva, y se prueba sin tocar InfoManager.
 */
export function cuerpoParaMoverFecha(cab: CabeceraCruda, fechaNueva: string) {
  const fecha = diaValido(fechaNueva);
  const num = (v: unknown, porDefecto = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : porDefecto;
  };

  /**
   * 🔴 LO QUE IDENTIFICA AL COMPROBANTE NO SE INVENTA: SI FALTA, NO HAY PUT.
   *
   * Astra (11/09/2026), después de mandarle a IM un PUT con un body inválido sobre un
   * comprobante real para ver qué contestaba: *"IM contestó 'actualizado correctamente' y me
   * pisó todos los campos — quedó con número −1, tipo ZZ, fecha 0000-00-00 y punto de venta
   * 999. `PUT /ventas/{id}` no valida nada y sobrescribe número, tipo, fecha y punto de venta"*.
   *
   * Acá todo salía de la cabecera de IM, que es lo correcto, pero con `??` y un `Number()` que
   * cae en 0. Con una cabecera incompleta eso escribía `numero: 0`, `punto_de_venta: 0` o
   * convertía un remito en factura B — y IM lo aceptaba sin chistar, porque no valida. Un PUT
   * que REEMPLAZA la cabecera entera no puede llevar un valor adivinado: si el dato no está,
   * lo único seguro es no escribir.
   */
  const tipo = String(cab.tipo_comprobante ?? '').trim();
  if (!tipo) throw new Error('InfoManager no devolvió el tipo de comprobante: no se toca la fecha (cambiarlo lo convertiría en otra cosa).');
  const numero = num(cab.numero, 0);
  if (!(numero > 0)) throw new Error('InfoManager no devolvió el número del comprobante: no se toca la fecha (quedaría en 0).');
  const pv = String(cab.punto_de_venta ?? '').trim();
  if (!pv || !Number.isFinite(Number(pv))) throw new Error('InfoManager no devolvió el punto de venta: no se toca la fecha (quedaría en el 0).');

  return {
    fecha,
    // Los nueve obligatorios, tal como los tiene el comprobante.
    tipo_comprobante: tipo,
    // 🪤 La letra NO lleva default: inventar 'B' sobre una factura A le cambia el IVA al cliente.
    // Vacía se manda vacía —hay comprobantes que no tienen letra, como los remitos—, pero nunca
    // una distinta de la que tiene.
    tipo_factura: String(cab.tipo_factura ?? ''),
    numero,
    punto_de_venta: Number(pv),
    tag: String(cab.tag ?? 'S'),
    condicion_venta_tipo: num(cab.condicion_venta_tipo),
    observaciones: String(cab.observaciones ?? '').slice(0, 500),
    fac_electronica: num(cab.fac_electronica),
    // 🪤 Requerido: sin esto IM lo toma como 'N' y REVIVE un comprobante anulado.
    anulada: String(cab.anulada ?? 'N').toUpperCase() === 'S' ? 'S' : 'N',
    // 🔴 Sin estos cuatro la factura vuelve a imprimirse como comprobante fiscal.
    afip_comprobantes_fe: String(cab.afip_comprobantes_fe ?? ''),
    afip_conceptos_fe: num(cab.afip_conceptos_fe),
    afip_tipdoc_fe: num(cab.afip_tipdoc_fe),
    afip_cond_vta: num(cab.afip_cond_vta),
    afip_cod_barra: String(cab.afip_cod_barra ?? ''),
    // 🪤 En este circuito no hay CAE, pero si alguna vez lo hay, no mandarlo lo borraría.
    cae: cab.cae ?? null,
    fecha_cae: cab.fecha_cae ?? null,
  };
}
