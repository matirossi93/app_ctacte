import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { LOGO_DATA_URI } from '../assets/logoPdf';

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

/**
 * 🪤 `Intl` mete un espacio DURO (U+00A0) entre el signo y el número. jsPDF escribe con la
 * tabla WinAnsi y ese carácter sale como un glifo raro en algunos visores de Android. Se
 * reemplaza por un espacio normal, que es lo mismo a la vista.
 */
const money = (n: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 2 })
    .format(n)
    .replace(/\u00a0/g, ' ');

/** Colores Semillero (los mismos del panel y de las demás apps). */
const GREEN: [number, number, number] = [6, 101, 47];
const GOLD: [number, number, number] = [238, 192, 69];
const BEIGE: [number, number, number] = [249, 239, 227];
const DARK: [number, number, number] = [30, 18, 12];
const GRIS: [number, number, number] = [120, 110, 100];

const MARGEN = 14;
/** Alto de la banda verde. La tabla de las páginas siguientes arranca justo abajo. */
const ALTO_BANDA = 30;
/** Desde acá para abajo ya no entra nada: es donde empieza el pie. */
const PISO = 276;

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

/** Texto en mayúsculas con aire entre letras, para los rótulos chicos. */
function rotulo(doc: jsPDF, txt: string, x: number, y: number, opts: { align?: 'left' | 'right' } = {}) {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setCharSpace(0.6);
  doc.text(txt.toUpperCase(), x, y, { align: opts.align ?? 'left' });
  doc.setCharSpace(0);
}

/**
 * Membrete: banda verde, isotipo y el número de presupuesto. Se dibuja en TODAS las páginas —
 * un presupuesto largo se imprime y se reparte, y una hoja suelta sin membrete no se sabe de
 * quién es ni a qué presupuesto pertenece.
 */
function membrete(doc: jsPDF, d: DatosPresupuesto, ancho: number) {
  doc.setFillColor(...GREEN);
  doc.rect(0, 0, ancho, ALTO_BANDA, 'F');
  doc.setFillColor(...GOLD);
  doc.rect(0, ALTO_BANDA, ancho, 1.8, 'F');

  // Isotipo dentro de un disco blanco: el logo es circular y sobre el verde necesita respirar.
  const cx = MARGEN + 9;
  const cy = ALTO_BANDA / 2;
  doc.setFillColor(255, 255, 255);
  doc.circle(cx, cy, 9.6, 'F');
  doc.addImage(LOGO_DATA_URI, 'PNG', cx - 8.6, cy - 8.6, 17.2, 17.2);

  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setCharSpace(0.3);
  doc.text('SEMILLERO EL MANANTIAL', cx + 13, cy - 1);
  doc.setCharSpace(0);
  doc.setTextColor(...GOLD);
  rotulo(doc, 'Presupuesto', cx + 13, cy + 5);

  const derecha = ancho - MARGEN;
  if (d.numero) {
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.text(`N° ${d.numero}`, derecha, cy - 1, { align: 'right' });
  }
  const fecha = new Date(d.fecha).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  doc.setTextColor(...GOLD);
  rotulo(doc, fecha, derecha, cy + 5, { align: 'right' });
}

/** Ficha del cliente. Sólo en la primera página. */
function fichaCliente(doc: jsPDF, d: DatosPresupuesto, ancho: number, y: number): number {
  const alto = 17;
  doc.setFillColor(...BEIGE);
  doc.roundedRect(MARGEN, y, ancho - MARGEN * 2, alto, 2, 2, 'F');

  doc.setTextColor(...GRIS);
  rotulo(doc, 'Cliente', MARGEN + 5, y + 6);
  doc.setTextColor(...DARK);
  doc.setFont('helvetica', 'bold');
  // El nombre puede ser larguísimo (una razón social completa). Antes que cortarlo —el
  // cliente leería su propio nombre a medias en el papel que le mandamos— se achica la
  // tipografía hasta que entre; recién si ni al mínimo entra se corta, y ahí sí con «…»
  // para que se vea que falta algo.
  const anchoNombre = ancho - MARGEN * 2 - 10 - (d.vendedor ? 55 : 0);
  let cuerpo = 12;
  while (cuerpo > 8.5 && (doc.setFontSize(cuerpo), doc.getTextWidth(d.cliente) > anchoNombre)) cuerpo -= 0.5;
  doc.setFontSize(cuerpo);
  let nombre = d.cliente;
  if (doc.getTextWidth(nombre) > anchoNombre) {
    while (nombre.length > 4 && doc.getTextWidth(nombre + '…') > anchoNombre) nombre = nombre.slice(0, -1);
    nombre += '…';
  }
  doc.text(nombre, MARGEN + 5, y + 12.5);

  if (d.vendedor) {
    const derecha = ancho - MARGEN - 5;
    doc.setTextColor(...GRIS);
    rotulo(doc, 'Te atiende', derecha, y + 6, { align: 'right' });
    doc.setTextColor(...DARK);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text(d.vendedor, derecha, y + 12.5, { align: 'right' });
  }
  return y + alto;
}

export function generarPresupuestoPdf(d: DatosPresupuesto): { blob: Blob; nombre: string } {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const ancho = doc.internal.pageSize.getWidth();

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
    head: [cabecera],
    body: filas,
    // El membrete se dibuja acá para que salga también en las páginas que agrega la tabla sola.
    // La ficha del cliente sólo en la primera: en las siguientes esos 17 mm son renglones.
    didDrawPage: (data) => {
      membrete(doc, d, ancho);
      if (data.pageNumber === 1) fichaCliente(doc, d, ancho, ALTO_BANDA + 8);
    },
    startY: ALTO_BANDA + 8 + 17 + 8,
    margin: { left: MARGEN, right: MARGEN, top: ALTO_BANDA + 8, bottom: 22 },
    styles: { fontSize: 9, cellPadding: 2.6, textColor: DARK, lineColor: [230, 220, 208], lineWidth: 0.1 },
    headStyles: { fillColor: GREEN, textColor: 255, fontStyle: 'bold', fontSize: 8.5, cellPadding: 2.8 },
    alternateRowStyles: { fillColor: BEIGE },
    columnStyles: hayDescuento
      ? { 0: { cellWidth: 'auto' }, 1: { halign: 'right', cellWidth: 16 }, 2: { halign: 'right', cellWidth: 28 }, 3: { halign: 'right', cellWidth: 16 }, 4: { halign: 'right', cellWidth: 30, fontStyle: 'bold' } }
      : { 0: { cellWidth: 'auto' }, 1: { halign: 'right', cellWidth: 18 }, 2: { halign: 'right', cellWidth: 32 }, 3: { halign: 'right', cellWidth: 34, fontStyle: 'bold' } },
  });

  // ── Total ──
  const total = d.items.reduce((s, i) => s + (Number(i.subtotal) || 0), 0);
  let y = (doc as any).lastAutoTable.finalY + 9;
  // Si el total no entra entero abajo de la tabla, va a una hoja nueva: partir la caja del
  // total entre dos páginas es la clase de detalle que hace desconfiar del número.
  if (y + 16 > PISO) { doc.addPage(); membrete(doc, d, ancho); y = ALTO_BANDA + 12; }

  const anchoTotal = 84;
  doc.setFillColor(...GREEN);
  doc.roundedRect(ancho - MARGEN - anchoTotal, y, anchoTotal, 15, 2, 2, 'F');
  doc.setTextColor(255, 255, 255);
  rotulo(doc, 'Total', ancho - MARGEN - anchoTotal + 6, y + 9.5);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text(money(total), ancho - MARGEN - 6, y + 10, { align: 'right' });

  // Cuántos renglones lleva, para que el cliente pueda controlar que no le falte nada.
  doc.setTextColor(...GRIS);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(`${d.items.length} ${d.items.length === 1 ? 'producto' : 'productos'}`, MARGEN, y + 10);
  y += 15 + 10;

  if (d.observaciones) {
    const lineas = doc.splitTextToSize(d.observaciones, ancho - MARGEN * 2 - 10);
    const alto = 10 + lineas.length * 4.6;
    if (y + alto > PISO) { doc.addPage(); membrete(doc, d, ancho); y = ALTO_BANDA + 12; }
    doc.setFillColor(...BEIGE);
    doc.roundedRect(MARGEN, y, ancho - MARGEN * 2, alto, 2, 2, 'F');
    doc.setTextColor(...GRIS);
    rotulo(doc, 'Observaciones', MARGEN + 5, y + 6);
    doc.setTextColor(...DARK);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.text(lineas, MARGEN + 5, y + 11.5);
  }

  // ── Pie, en todas las páginas ──
  // Va al final y no en didDrawPage porque recién acá se sabe cuántas páginas quedaron.
  const paginas = doc.getNumberOfPages();
  for (let p = 1; p <= paginas; p++) {
    doc.setPage(p);
    doc.setDrawColor(...GOLD);
    doc.setLineWidth(0.6);
    doc.line(MARGEN, 282, ancho - MARGEN, 282);
    doc.setTextColor(...GRIS);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.text('Presupuesto sujeto a confirmación y disponibilidad de stock.', MARGEN, 287);
    if (paginas > 1) doc.text(`Página ${p} de ${paginas}`, ancho - MARGEN, 287, { align: 'right' });
  }

  return { blob: doc.output('blob'), nombre: nombreArchivo(d) };
}

/**
 * Comparte el PDF. En el celular abre el menú nativo (WhatsApp, mail, lo que tenga), que es
 * como el vendedor se lo manda al cliente de verdad; si el navegador no soporta compartir
 * archivos, lo descarga.
 *
 * 🪤 `navigator.share` TIENE que llamarse dentro del gesto del usuario: si se arma el PDF con
 * un `await` largo antes, iOS lo rechaza por "no user activation". Por eso el PDF se genera
 * sincrónicamente (jsPDF lo es, y el logo va embebido como data URI justamente para no tener
 * que ir a buscarlo) y lo único diferido es el import del módulo, que el que llama hace ANTES
 * de este punto.
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
