import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

/**
 * PDF del presupuesto para MANDARLE AL CLIENTE.
 *
 * Es lo único de la app que sale de la empresa, así que no lleva nada interno: ni el código de
 * la lista de precios (L1/L2/L3 es nuestra estructura de precios, no asunto del cliente), ni
 * los avisos del control de listas, ni el margen. Sólo lo que el cliente necesita para decidir:
 * qué, cuánto, a cuánto y cuál es el total.
 *
 * El total sale de SUMAR los renglones que se muestran, no de un campo aparte: un pie que no
 * cuadra con las filas de arriba es exactamente la clase de error que no puede salir a un
 * cliente.
 */

const money = (n: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 2 }).format(n);

/** Colores Semillero (mismos que pdfReport.ts). */
const GREEN: [number, number, number] = [6, 101, 47];
const GOLD: [number, number, number] = [238, 192, 69];
const DARK: [number, number, number] = [30, 18, 12];

export interface RenglonPresupuesto {
  descripcion: string | null;
  cod_articulo: number;
  cantidad: number;
  precio_unit: number;
  descuento_porc: number | null;
  subtotal: number;
}

export interface DatosPresupuesto {
  numero: number | null;
  cliente: string;
  vendedor?: string | null;
  fecha: string | Date;
  items: RenglonPresupuesto[];
  observaciones?: string | null;
}

/** Nombre de archivo sin acentos ni caracteres que rompan en Android/iOS. */
function nombreArchivo(d: DatosPresupuesto): string {
  const limpio = d.cliente
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 28);
  return `Presupuesto-${d.numero ?? 'SN'}${limpio ? `-${limpio}` : ''}.pdf`;
}

export function generarPresupuestoPdf(d: DatosPresupuesto): { blob: Blob; nombre: string } {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const ancho = doc.internal.pageSize.getWidth();
  const margen = 14;

  // ── Encabezado ──
  doc.setFillColor(...GREEN);
  doc.rect(0, 0, ancho, 32, 'F');
  doc.setFillColor(...GOLD);
  doc.rect(0, 32, ancho, 2, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(17);
  doc.text('SEMILLERO EL MANANTIAL', margen, 15);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.text(d.numero ? `Presupuesto N° ${d.numero}` : 'Presupuesto', margen, 24);

  const fecha = new Date(d.fecha).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  doc.text(fecha, ancho - margen, 24, { align: 'right' });

  // ── Cliente ──
  let y = 45;
  doc.setTextColor(...DARK);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.text('Cliente', margen, y);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text(d.cliente, margen, y + 6);
  if (d.vendedor) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text(`Vendedor: ${d.vendedor}`, ancho - margen, y + 6, { align: 'right' });
  }
  y += 14;

  // ── Renglones ──
  // La columna de descuento sólo aparece si hay alguno: una columna de ceros es ruido.
  const hayDescuento = d.items.some((i) => Number(i.descuento_porc) > 0);
  const cabecera = hayDescuento
    ? ['Producto', 'Cant.', 'Precio unit.', 'Desc.', 'Subtotal']
    : ['Producto', 'Cant.', 'Precio unit.', 'Subtotal'];

  const filas = d.items.map((i) => {
    const base = [
      i.descripcion ?? `Artículo ${i.cod_articulo}`,
      String(Number(i.cantidad)),
      money(Number(i.precio_unit)),
    ];
    if (hayDescuento) base.push(Number(i.descuento_porc) > 0 ? `${Number(i.descuento_porc)}%` : '—');
    base.push(money(Number(i.subtotal)));
    return base;
  });

  autoTable(doc, {
    startY: y,
    head: [cabecera],
    body: filas,
    margin: { left: margen, right: margen },
    styles: { fontSize: 9, cellPadding: 2.5 },
    headStyles: { fillColor: GREEN, textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [249, 239, 227] },
    columnStyles: hayDescuento
      ? { 0: { cellWidth: 'auto' }, 1: { halign: 'right', cellWidth: 16 }, 2: { halign: 'right', cellWidth: 28 }, 3: { halign: 'right', cellWidth: 16 }, 4: { halign: 'right', cellWidth: 30 } }
      : { 0: { cellWidth: 'auto' }, 1: { halign: 'right', cellWidth: 18 }, 2: { halign: 'right', cellWidth: 32 }, 3: { halign: 'right', cellWidth: 34 } },
  });

  // ── Total ──
  const total = d.items.reduce((s, i) => s + (Number(i.subtotal) || 0), 0);
  y = (doc as any).lastAutoTable.finalY + 10;
  doc.setFillColor(...GREEN);
  doc.rect(ancho - margen - 78, y - 6, 78, 12, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('TOTAL', ancho - margen - 72, y + 2);
  doc.text(money(total), ancho - margen - 4, y + 2, { align: 'right' });
  y += 16;

  if (d.observaciones) {
    doc.setTextColor(...DARK);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text(doc.splitTextToSize(d.observaciones, ancho - margen * 2), margen, y);
    y += 10;
  }

  doc.setTextColor(120, 110, 100);
  doc.setFontSize(8);
  doc.text('Presupuesto sujeto a confirmación y disponibilidad de stock.', margen, 285);

  return { blob: doc.output('blob'), nombre: nombreArchivo(d) };
}

/**
 * Comparte el PDF. En el celular abre el menú nativo (WhatsApp, mail, lo que tenga), que es
 * como el vendedor se lo manda al cliente de verdad; si el navegador no soporta compartir
 * archivos, lo descarga.
 *
 * 🪤 `navigator.share` TIENE que llamarse dentro del gesto del usuario: si se arma el PDF con
 * un `await` largo antes, iOS lo rechaza por "no user activation". Por eso el PDF se genera
 * sincrónicamente (jsPDF lo es) y lo único diferido es el import del módulo, que el que llama
 * hace ANTES de este punto.
 */
export async function compartirPresupuestoPdf(d: DatosPresupuesto): Promise<'compartido' | 'descargado'> {
  const { blob, nombre } = generarPresupuestoPdf(d);
  const file = new File([blob], nombre, { type: 'application/pdf' });

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: nombre });
      return 'compartido';
    } catch (e: any) {
      // El usuario canceló el menú: no es un error y no hay que descargar nada a la fuerza.
      if (e?.name === 'AbortError') return 'compartido';
      // Cualquier otra cosa cae a la descarga.
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return 'descargado';
}
