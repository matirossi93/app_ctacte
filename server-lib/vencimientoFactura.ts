/**
 * CUÁNDO SE LE VENCE LA FACTURA AL CLIENTE.
 *
 * Mati (16/09/2026): *"en el formato de impresión de la factura estaría bueno que le salga cuándo
 * se le vencería esa factura al cliente (tomando los días que tiene pactado de cta cte cada
 * cliente)... buscamos bajar de forma sutil la demora en el pago"*.
 *
 * 🔑 MISMO CRITERIO QUE AMIRA, para que el papel y el mensaje de cobranza nunca se contradigan.
 * Amira lo saca del maestro de clientes: la columna **VISITA** (7 o 15) cruzada con **Cond Pago**
 * en cuenta corriente. Está escrito en `recordatorio_deuda_clientes.py`:
 *
 *     PLAZOS = {"7": 7, "15": 15}  # columna VISITA del maestro (NO usar "Frecuencia": no es el plazo)
 *
 * 🪤 Esa advertencia es parte del criterio: "Frecuencia" es otra columna del mismo maestro y
 * también tiene números. Acá se lee `visita`, que es donde el import deja la columna VISITA.
 *
 * 🔴 Sin plazo no se inventa nada: un vencimiento equivocado impreso en una factura es peor que
 * ninguno. Los clientes de contado y los de cuenta corriente sin plazo cargado salen sin fecha.
 */

/** Los únicos plazos que la empresa maneja. Cualquier otro valor es un dato que no se entiende. */
const PLAZOS = new Set([7, 15]);

export interface PlazoCliente {
  /** La columna VISITA del maestro. */
  visita?: unknown;
  /** 'cc' = cuenta corriente. Contado y efectivo no vencen. */
  cond_pago?: unknown;
}

/** Los días pactados, o `null` si no se puede afirmar. */
export function diasDeCuentaCorriente(c: PlazoCliente | null | undefined): number | null {
  if (!c) return null;
  // 🪤 Sólo cuenta corriente: a un cliente de contado no se le pone fecha de vencimiento.
  if (!/^cc$/i.test(String(c.cond_pago ?? '').trim())) return null;
  /**
   * 🪤 Sólo texto o número: `String(['15'])` es "15" y un array pasaría como plazo válido. El
   * dato viene de una planilla importada, así que puede llegar de cualquier forma.
   */
  const v = c.visita;
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const n = Number(String(v).trim());
  return PLAZOS.has(n) ? n : null;
}

/**
 * La fecha en que vence, `null` si falta el plazo o la fecha no es legible.
 *
 * 🪤 Se cuenta en días calendario sobre la fecha del comprobante, al mediodía UTC: sumar
 * milisegundos sobre la medianoche local hace que un cambio de horario corra la fecha un día.
 */
export function vencimientoDeFactura(fechaComprobante: unknown, cliente: PlazoCliente | null | undefined): { fecha: string; dias: number } | null {
  const dias = diasDeCuentaCorriente(cliente);
  if (dias === null) return null;
  const f = String(fechaComprobante ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return null;
  const t = Date.parse(`${f}T12:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return { fecha: new Date(t + dias * 864e5).toISOString().slice(0, 10), dias };
}
