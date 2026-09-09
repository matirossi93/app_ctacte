/**
 * ¿ESTE PRESUPUESTO YA SE FACTURÓ?
 *
 * 🔴 El 09/09/2026 Mati facturó a propósito desde el panel un presupuesto que ya estaba
 * facturado en InfoManager, para ver qué pasaba: **se emitió una segunda factura real** (la
 * 50401, que hubo que borrar a mano). El remito falló después —el stock ya estaba descontado por
 * el remito original— pero la factura ya había salido. *"Debería darnos un aviso que ya está
 * facturado para no hacerlo dos veces"*.
 *
 * 🪤 Por qué hace falta deducirlo: **InfoManager no marca el presupuesto al facturarlo**.
 * Medido el 09/09/2026 sobre los 58 presupuestos vigentes de dos días: los 35 que ya tienen su
 * factura y los 23 que no **están todos en `tipo_presupuesto: 'C'`**. El campo no distingue nada.
 * Y la API tampoco expone el vínculo factura↔presupuesto (es el mismo agujero que con las notas
 * de crédito y con los remitos).
 *
 * Así que se compara contra las facturas reales: **mismo cliente y mismo importe al centavo**. Es
 * el criterio que ya probó bien apareando remitos (168 casos, cero falsos negativos).
 *
 * 🔑 Esto AVISA, no bloquea para siempre: un cliente puede comprar dos veces lo mismo el mismo
 * día y el segundo presupuesto ser legítimo. Por eso el resultado dice de dónde salió la
 * sospecha, y quien mira decide.
 */

export interface PresupuestoAChequear {
  im_comprobante_id: string;
  cod_cliente: number;
  total: number;
}

export interface ComprobanteEmitido {
  id: string | number;
  numero?: number | null;
  cod_cliente?: number;
  total?: number | string;
  tipo_factura?: string;
  fecha?: string;
}

export interface FacturaSospechada {
  im_factura_id: string;
  numero: number | null;
  tipo: string;
  fecha: string | null;
  /**
   * `nuestra` = la emitimos desde el panel y está guardada · `deducida` = hay una factura del
   * mismo cliente por el mismo importe, así que casi seguro es de este presupuesto.
   */
  origen: 'nuestra' | 'deducida';
}

const centavos = (v: unknown) => Math.round(Number(v ?? 0) * 100);

/**
 * Devuelve, por presupuesto, la factura que ya lo cubriría (o `undefined` si no hay ninguna).
 *
 * @param presupuestos  los que se van a facturar
 * @param facturas      las FA vigentes del rango (sin anular)
 * @param nuestras      `im_comprobante_id` → la factura que emitimos nosotros
 */
export function buscarFacturasYaEmitidas(
  presupuestos: PresupuestoAChequear[],
  facturas: ComprobanteEmitido[],
  nuestras: Map<string, { im_factura_id: string | null; im_factura_numero: number | null; im_factura_tipo: string | null }>,
): Map<string, FacturaSospechada> {
  const salida = new Map<string, FacturaSospechada>();

  /**
   * Las facturas que ya sabemos de qué presupuesto son NO pueden justificar a otro. Sin esto, un
   * cliente que compró lo mismo dos veces y facturó una tendría los DOS presupuestos marcados
   * como facturados, y el segundo no se podría emitir nunca.
   */
  const usadas = new Set<string>();

  // 1. Lo que emitimos nosotros: es el dato cierto, y reserva su factura.
  for (const p of presupuestos) {
    const n = nuestras.get(String(p.im_comprobante_id));
    if (n && (n.im_factura_numero != null || n.im_factura_id)) {
      salida.set(String(p.im_comprobante_id), {
        im_factura_id: String(n.im_factura_id ?? ''),
        numero: n.im_factura_numero ?? null,
        tipo: n.im_factura_tipo ?? 'FA',
        fecha: null,
        origen: 'nuestra',
      });
      if (n.im_factura_id) usadas.add(String(n.im_factura_id));
    }
  }
  // Y las que ya están atadas a CUALQUIER presupuesto, aunque no sea de esta tanda.
  for (const n of nuestras.values()) {
    if (n.im_factura_id) usadas.add(String(n.im_factura_id));
  }

  const porClienteImporte = new Map<string, ComprobanteEmitido[]>();
  for (const f of facturas) {
    const k = `${Number(f.cod_cliente)}|${centavos(f.total)}`;
    if (!porClienteImporte.has(k)) porClienteImporte.set(k, []);
    porClienteImporte.get(k)!.push(f);
  }

  // 2. Deducido. El orden es por comprobante, para que no dependa de cómo llegó la lista.
  const enOrden = [...presupuestos].sort((a, b) =>
    String(a.im_comprobante_id).localeCompare(String(b.im_comprobante_id)));
  for (const p of enOrden) {
    const id = String(p.im_comprobante_id);
    if (salida.has(id)) continue;
    const candidata = (porClienteImporte.get(`${Number(p.cod_cliente)}|${centavos(p.total)}`) ?? [])
      .find(f => !usadas.has(String(f.id)));
    if (!candidata) continue;
    usadas.add(String(candidata.id));
    salida.set(id, {
      im_factura_id: String(candidata.id),
      numero: candidata.numero != null ? Number(candidata.numero) : null,
      tipo: `FA ${String(candidata.tipo_factura ?? '').trim()}`.trim(),
      fecha: candidata.fecha ? String(candidata.fecha).slice(0, 10) : null,
      origen: 'deducida',
    });
  }
  return salida;
}
