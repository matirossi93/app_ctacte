import type { ComprobantePendiente } from './saldoCliente.js';

/** HTTP200 no acredita saldo consultado: IM también devuelve errores dentro del cuerpo. */
export function parsearPendientesCliente(data: any): ComprobantePendiente[] {
  const errorExplicito = data?.error != null && ![false, 0, '0', ''].includes(data.error);
  if (errorExplicito || data?.ok === false || data?.success === false || data?.exito === false) {
    throw new Error('InfoManager no confirmó la consulta de saldos pendientes.');
  }
  const filas = Array.isArray(data) ? data : data?.results ?? data?.comprobantes;
  if (!Array.isArray(filas)) throw new Error('InfoManager no devolvió una lista de saldos pendientes válida.');
  const ids = new Set<string>();
  return filas.map(f => {
    const id = typeof f?.id === 'string' || typeof f?.id === 'number' ? String(f.id).trim() : '';
    const saldoRaw = f?.saldo;
    const saldo = Number(saldoRaw);
    if (!/^\d+$/.test(id) || /^0+$/.test(id) || ids.has(id) ||
        (typeof saldoRaw !== 'number' && typeof saldoRaw !== 'string') ||
        (typeof saldoRaw === 'string' && !saldoRaw.trim()) || !Number.isFinite(saldo)) {
      throw new Error('InfoManager devolvió un saldo pendiente sin identidad o importe verificable.');
    }
    ids.add(id);
    return {
      id, saldo,
      tipo_comprobante: String(f.tipo_comprobante ?? '').trim(),
      numero: f.numero != null ? String(f.numero) : null,
      punto_de_venta: f.punto_de_venta != null ? String(f.punto_de_venta) : null,
      fecha: typeof f.fecha_factura === 'string' ? f.fecha_factura.slice(0, 10) : null,
    };
  });
}
