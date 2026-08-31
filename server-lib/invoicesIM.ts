import type { PendienteIM } from './conciliacion.js';

/**
 * Traduce los comprobantes crudos de InfoManager al shape que lee la pantalla (`InvoiceRaw`).
 *
 * 🔑 Este código vivía adentro de `fetchIMData` en server.ts. Se movió acá TAL CUAL —misma
 * lógica, mismos nombres de campo— porque desde el 31/08/2026 lo usan dos caminos:
 *   · la lista de hoy, que sale del reporte vivo de IM
 *   · la lista a una fecha pasada, que sale de la foto diaria (`conciliacion_snapshot`)
 * y las dos tienen que mostrar exactamente lo mismo. Duplicado, el primer arreglo que alguien
 * hiciera en uno de los dos lados dejaría las pantallas discrepando en plata.
 */

/** Sólo los campos que la app usa de verdad; IM manda bastante más. */
export interface InvoiceIM {
  COD_CLIENT: string;
  CLIENTES_N: string;
  COD_VENDED: string;
  VENDEDORES: string;
  NUMERO: string;
  ID: string;
  FECHA: string;
  TOTAL: number | undefined;
  IMPORTE_PA: number | undefined;
  SALDO: number | undefined;
  TIPO_COMPR: string;
  DIAS_EMISI: number;
  COD_EMPRES: string;
}

/**
 * @param nombreVendedor cómo se llama el vendedor `cod`. Se recibe como función para no
 *   atar esto a de dónde salió el maestro (IM vivo o el congelado en la foto).
 */
export function normalizarInvoices(
  rows: PendienteIM[],
  codEmpresa: number,
  nombreVendedor: (cod: number) => string,
): InvoiceIM[] {
  return rows.map(inv => {
    // La app muestra D/M/AAAA, no ISO.
    let fecha = '';
    if (inv.fecha_factura) {
      const d = new Date(inv.fecha_factura);
      if (!isNaN(d.getTime())) fecha = `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
    }
    return {
      COD_CLIENT: String(inv.cod_cliente),
      CLIENTES_N: inv.nombre || '',
      COD_VENDED: String(inv.cod_vendedor),
      VENDEDORES: inv.cod_vendedor === 0 ? 'SIN VENDEDOR' : nombreVendedor(inv.cod_vendedor as number),
      NUMERO: String(inv.numero || ''),
      ID: `IM-${codEmpresa}-${inv.tipo_comprobante}-${inv.punto_de_venta || 0}-${inv.numero || 0}`,
      FECHA: fecha,
      TOTAL: inv.importe_factura,
      IMPORTE_PA: inv.importe_pagado,
      SALDO: inv.saldo,
      TIPO_COMPR: inv.tipo_comprobante || '',
      DIAS_EMISI: inv.dias_deuda || 0,
      COD_EMPRES: String(codEmpresa),
    };
  });
}

/**
 * Los ASD/ASH que el sistema genera no traen vendedor en IM: se les pone el del cliente.
 * El que no se puede resolver se descarta — dejarlo con vendedor 0 lo metería en el total
 * de alguien que no lo vendió.
 */
export function resolverSinVendedor(invoices: InvoiceIM[]): InvoiceIM[] {
  const porCliente = new Map<string, { id: string; name: string }>();
  for (const inv of invoices) {
    if (inv.COD_VENDED !== '0' && !porCliente.has(inv.COD_CLIENT)) {
      porCliente.set(inv.COD_CLIENT, { id: inv.COD_VENDED, name: inv.VENDEDORES });
    }
  }
  return invoices.filter(inv => {
    if (inv.COD_VENDED !== '0') return true;
    const real = porCliente.get(inv.COD_CLIENT);
    if (!real) return false;
    inv.COD_VENDED = real.id;
    inv.VENDEDORES = real.name;
    return true;
  });
}
