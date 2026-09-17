import { authHeaders } from './auth';
import { generarPresupuestoPdf, compartirPresupuestoPdf, type DatosPresupuesto } from './pdfPresupuesto';

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

/**
 * @param valorizado  `false` imprime el papel SIN importes. Mati (10/09/2026): *"necesito que el
 *                    remito tenga la opción de valorizado o no valorizado, porque necesitamos que
 *                    salga sin importe muchas veces"*. Por defecto va con importes.
 */
/** Lo que el papel necesita, tal como lo devuelve el panel. Lo comparten imprimir y compartir. */
async function datosDelComprobante(
  id: string, titulo: TituloComprobante, valorizado: boolean,
): Promise<DatosPresupuesto> {
  const r = await fetch(`/api/comprobantes/${id}/imprimir`, { headers: authHeaders() });
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(d?.error ?? 'No se pudo traer el comprobante');
  return {
    tipo: titulo,
    numero: d.comprobante?.numero ?? null,
    cliente: d.comprobante?.cliente ?? '',
    // Con lo que la oficina lo busca en InfoManager: el endpoint ya lo devolvía.
    cod_cliente: d.comprobante?.cod_cliente ?? null,
    // Para el que reparte: a dónde va y a quién llamar si no encuentra el domicilio.
    domicilio: d.comprobante?.domicilio ?? null,
    telefono: d.comprobante?.telefono ?? null,
    /**
     * 🔑 Quién lo vendió. Mati (16/09/2026): *"en el formato de impresión del presupuesto y la
     * factura debería figurar también el nombre del vendedor relacionado"*.
     *
     * El PDF ya sabía dibujarlo —lo usa la app de los vendedores— y esta pantalla no se lo
     * pasaba: el papel de la oficina salía sin ese dato.
     */
    vendedor: d.comprobante?.vendedor ?? null,
    /** Sólo se dibuja en la factura, y sólo si el cliente tiene plazo pactado de cuenta corriente. */
    vence: d.comprobante?.vence ?? null,
    dias_cta_cte: d.comprobante?.dias_cta_cte ?? null,
    fecha: d.comprobante?.fecha ?? new Date(),
    observaciones: d.comprobante?.observaciones ?? null,
    items: d.items ?? [],
    valorizado,
  };
}

export async function imprimirComprobante(
  id: string, titulo: TituloComprobante, valorizado = true,
): Promise<void> {
  const datos = await datosDelComprobante(id, titulo, valorizado);
  const { blob } = generarPresupuestoPdf(datos);

  const url = URL.createObjectURL(blob);
  const w = window.open(url, '_blank');
  // 🪤 Si el navegador bloquea la ventana emergente, se descarga: peor que imprimir, pero mucho
  // mejor que no pasar nada y que el usuario piense que el botón está roto.
  if (!w) {
    const a = document.createElement('a');
    a.href = url;
    a.download = `${titulo}${valorizado ? '' : '-sin-importe'}-${datos.numero ?? id}.pdf`;
    a.click();
  }
  // Se libera después, para no cortarle el archivo a la pestaña recién abierta.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * COMPARTIR el comprobante desde el panel, no imprimirlo.
 *
 * Mati (17/09/2026): *"para que Jorgelina pueda compartir o a algún cliente o a los mismos
 * vendedores el presupuesto desde la ventana de facturación"*. La app de los vendedores ya lo
 * hacía: esto usa el MISMO PDF y el mismo menú nativo, así que el cliente recibe el mismo papel
 * venga de donde venga.
 *
 * 🪤 `navigator.share` quiere el gesto del usuario, y acá hay un `fetch` en el medio. En la
 * computadora de la oficina el menú abre igual; donde el navegador lo rechace, el PDF se
 * descarga — que es lo que ya hace `compartirPresupuestoPdf` cuando no puede compartir.
 */
export async function compartirComprobante(
  id: string, titulo: TituloComprobante, valorizado = true,
): Promise<'compartido' | 'descargado'> {
  return compartirPresupuestoPdf(await datosDelComprobante(id, titulo, valorizado));
}
