import { authHeaders } from './auth';
import { generarPresupuestoPdf } from './pdfPresupuesto';

/**
 * Imprimir un comprobante de InfoManager desde el panel.
 *
 * Mati (09/09/2026): *"tenemos que tener algún botón para poder imprimir el presupuesto y también
 * la factura"*. Sirve para los dos: los renglones salen del mismo endpoint y lo único que cambia
 * es el título del papel.
 *
 * 🔑 Abre el PDF en una pestaña en vez de descargarlo: lo que la oficina quiere es mandarlo a la
 * impresora, no juntar archivos en Descargas.
 */
/**
 * Lo que va en el encabezado del PDF. Las notas de crédito y débito entran acá desde el
 * 10/09/2026: Mati pidió poder imprimirlas igual que la factura y el remito.
 */
export type TituloComprobante = 'Presupuesto' | 'Factura' | 'Remito' | 'Nota de crédito' | 'Nota de débito';

export async function imprimirComprobante(id: string, titulo: TituloComprobante): Promise<void> {
  const r = await fetch(`/api/comprobantes/${id}/imprimir`, { headers: authHeaders() });
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(d?.error ?? 'No se pudo traer el comprobante');

  const { blob } = generarPresupuestoPdf({
    tipo: titulo,
    numero: d.comprobante?.numero ?? null,
    cliente: d.comprobante?.cliente ?? '',
    // Para el que reparte: a dónde va y a quién llamar si no encuentra el domicilio.
    domicilio: d.comprobante?.domicilio ?? null,
    telefono: d.comprobante?.telefono ?? null,
    fecha: d.comprobante?.fecha ?? new Date(),
    observaciones: d.comprobante?.observaciones ?? null,
    items: d.items ?? [],
  });

  const url = URL.createObjectURL(blob);
  const w = window.open(url, '_blank');
  // 🪤 Si el navegador bloquea la ventana emergente, se descarga: peor que imprimir, pero mucho
  // mejor que no pasar nada y que el usuario piense que el botón está roto.
  if (!w) {
    const a = document.createElement('a');
    a.href = url;
    a.download = `${titulo}-${d.comprobante?.numero ?? id}.pdf`;
    a.click();
  }
  // Se libera después, para no cortarle el archivo a la pestaña recién abierta.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
