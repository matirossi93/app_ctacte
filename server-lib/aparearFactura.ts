/**
 * QUÉ FACTURA LE CORRESPONDE A CADA REMITO.
 *
 * 🔴 InfoManager **no guarda esa relación**: el remito tiene 47 campos y ninguno apunta a la
 * factura (mismo problema que con las notas de crédito). Así que hay que deducirla.
 *
 * Medido contra IM sobre 168 remitos de Casa Central (2, 3 y 4 de septiembre de 2026):
 *  · **Todos** tienen una factura del mismo cliente por el mismo importe. Cero excepciones.
 *  · Entre 82% y 96% aparea con UNA sola factura: ahí no hay nada que decidir.
 *  · El resto es un cliente con dos facturas del mismo importe el mismo día — dos pedidos
 *    iguales. Para ésos se elige la emitida más cerca en el tiempo.
 *
 * 🔑 El orden importa: primero el vínculo REAL, el de lo que emitimos desde el panel y quedó
 * guardado en `presupuestos_facturados`. Deducir sólo hace falta para lo que se facturó a mano
 * en InfoManager.
 */

export interface ComprobanteIM {
  id: string | number;
  numero?: number | null;
  cod_cliente?: number;
  total?: number | string;
  tipo_factura?: string;
  /** Cuándo lo grabó el usuario. Es lo que desempata cuando hay dos facturas iguales. */
  usuario_fecha?: string;
}

export interface FacturaDeRemito {
  im_factura_id: string | null;
  im_factura_numero: number | null;
  im_factura_tipo: string | null;
  /**
   * Cómo se supo. `vinculo` = lo emitimos nosotros y está guardado · `unica` = hay una sola
   * factura que puede ser · `elegida` = había varias iguales y se tomó la más cercana en el
   * tiempo · `ninguna` = no apareció ninguna.
   */
  origen: 'vinculo' | 'unica' | 'elegida' | 'ninguna';
}

/** Los centavos, como entero: comparar floats por igualdad es pedir un bug. */
const centavos = (v: unknown) => Math.round(Number(v ?? 0) * 100);
const instante = (v: unknown) => {
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? t : null;
};

/**
 * Empareja cada remito con su factura.
 *
 * @param remitos     los comprobantes RE del día
 * @param facturas    los comprobantes FA del mismo rango
 * @param vinculados  lo que ya sabemos de cierto: `im_remito_id` → datos de la factura
 */
export function aparearFacturas(
  remitos: ComprobanteIM[],
  facturas: ComprobanteIM[],
  vinculados: Map<string, { im_factura_id: string | null; im_factura_numero: number | null; im_factura_tipo: string | null }>,
): Map<string, FacturaDeRemito> {
  // Índice por cliente + importe exacto, que es lo que probó aparear bien.
  const porClienteImporte = new Map<string, ComprobanteIM[]>();
  for (const f of facturas) {
    const k = `${Number(f.cod_cliente)}|${centavos(f.total)}`;
    if (!porClienteImporte.has(k)) porClienteImporte.set(k, []);
    porClienteImporte.get(k)!.push(f);
  }

  const salida = new Map<string, FacturaDeRemito>();
  for (const r of remitos) {
    const id = String(r.id);

    // 1. El vínculo real: lo emitimos nosotros y lo guardamos al emitirlo.
    const guardado = vinculados.get(id);
    if (guardado && (guardado.im_factura_numero != null || guardado.im_factura_id)) {
      salida.set(id, { ...guardado, origen: 'vinculo' });
      continue;
    }

    // 2. Deducido. Sólo hace falta para lo facturado a mano en InfoManager.
    const candidatas = porClienteImporte.get(`${Number(r.cod_cliente)}|${centavos(r.total)}`) ?? [];
    if (!candidatas.length) {
      salida.set(id, { im_factura_id: null, im_factura_numero: null, im_factura_tipo: null, origen: 'ninguna' });
      continue;
    }

    let elegida = candidatas[0];
    let origen: FacturaDeRemito['origen'] = 'unica';
    if (candidatas.length > 1) {
      origen = 'elegida';
      // 🪤 Dos facturas del mismo cliente por el mismo importe el mismo día son dos pedidos
      // iguales. La que corresponde es la que se grabó junto con este remito, así que se toma
      // la más cercana en el tiempo. Sin hora utilizable queda la de número más bajo, que al
      // menos es determinista: dos cargas de la misma pantalla no pueden dar resultados
      // distintos.
      const tr = instante(r.usuario_fecha);
      if (tr != null) {
        const conHora = candidatas.filter(c => instante(c.usuario_fecha) != null);
        if (conHora.length) {
          elegida = conHora.reduce((mejor, c) =>
            Math.abs(instante(c.usuario_fecha)! - tr) < Math.abs(instante(mejor.usuario_fecha)! - tr) ? c : mejor);
        } else {
          elegida = [...candidatas].sort((a, b) => Number(a.numero ?? 0) - Number(b.numero ?? 0))[0];
        }
      } else {
        elegida = [...candidatas].sort((a, b) => Number(a.numero ?? 0) - Number(b.numero ?? 0))[0];
      }
    }

    salida.set(id, {
      im_factura_id: String(elegida.id),
      im_factura_numero: elegida.numero != null ? Number(elegida.numero) : null,
      im_factura_tipo: `FA ${String(elegida.tipo_factura ?? '').trim()}`.trim(),
      origen,
    });
  }
  return salida;
}
