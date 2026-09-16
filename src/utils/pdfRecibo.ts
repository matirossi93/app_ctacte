import jsPDF from 'jspdf';
import { LOGO_DATA_URI } from '../assets/logoPdf';
import { montoEnLetras } from './montoEnLetras';

/**
 * RECIBO para entregarle al cliente.
 *
 * Mati (16/09/2026): *"un botón para poder compartir el recibo que crean ellos, para reemplazar
 * el recibo manual que actualmente están escribiendo los vendedores y que después le sacan foto
 * y lo cargan"*. Este papel ocupa el lugar del talonario, así que lleva lo que lleva un recibo:
 * quién pagó, cuánto (en número y en letras), cómo, cuándo y **quién lo recibió**.
 *
 * 🔑 Mismas reglas del PDF de presupuesto: paleta pensada para láser blanco y negro (nada de
 * rellenos que salen como bloques negros), y el importe formateado sin el espacio duro de
 * `Intl`, que en algunos visores de Android sale como un glifo raro.
 */

const money = (n: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 2 })
    .format(n)
    .replace(/ /g, ' ');

const A_COLOR = String(import.meta.env?.VITE_PDF_COLOR ?? '') === '1';
const GREEN: [number, number, number] = A_COLOR ? [6, 101, 47] : [25, 25, 25];
const GOLD: [number, number, number] = A_COLOR ? [238, 192, 69] : [90, 90, 90];
const DARK: [number, number, number] = [30, 18, 12];
const GRIS: [number, number, number] = [120, 110, 100];
const LINEA: [number, number, number] = A_COLOR ? [238, 192, 69] : [150, 150, 150];

const MARGEN = 11;
const ALTO_BANDA = 14;

export interface DatosRecibo {
  /** El número de InfoManager. `null` mientras la oficina no lo imputó. */
  numero: number | string | null;
  cliente: string;
  cod_cliente?: number | null;
  fecha: string | Date;
  monto: number;
  /** Ya traducido a lo que entiende el cliente ("Efectivo", "MercadoPago"), no la clave interna. */
  medio_pago?: string | null;
  banco_origen?: string | null;
  referencia?: string | null;
  observaciones?: string | null;
  /** Quién recibió la plata. Es el dato que el cliente necesita si después hay que reclamar. */
  vendedor?: string | null;
}

/** Nombre de archivo sin acentos ni caracteres que rompan en Android/iOS. */
function nombreArchivo(d: DatosRecibo): string {
  const limpio = d.cliente
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 28);
  return `Recibo-${d.numero ?? 'SN'}${limpio ? `-${limpio}` : ''}.pdf`;
}

function rotulo(doc: jsPDF, txt: string, x: number, y: number, align: 'left' | 'right' = 'left') {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setCharSpace(0.6);
  doc.text(txt.toUpperCase(), x, y, { align });
  doc.setCharSpace(0);
}

export function generarReciboPdf(d: DatosRecibo): { blob: Blob; nombre: string } {
  /**
   * 🔑 A5, no A4. Un recibo es media hoja —el tamaño del talonario que viene a reemplazar— y
   * el caso real es mandarlo por WhatsApp: en A4 el contenido ocupaba el tercio de arriba y
   * quedaban dos tercios en blanco, que en el celular se ve como un papel roto. Impreso,
   * además, entran dos por hoja.
   */
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a5' });
  const ancho = doc.internal.pageSize.getWidth();
  const derecha = ancho - MARGEN;

  // ── Membrete ──────────────────────────────────────────────────────────────
  if (A_COLOR) {
    doc.setFillColor(...GREEN);
    doc.rect(0, 0, ancho, ALTO_BANDA, 'F');
    doc.setFillColor(...GOLD);
    doc.rect(0, ALTO_BANDA, ancho, 1.2, 'F');
  } else {
    doc.setDrawColor(...GREEN);
    doc.setLineWidth(0.7);
    doc.line(0, ALTO_BANDA, ancho, ALTO_BANDA);
    doc.setLineWidth(0.2);
  }
  const cx = MARGEN + 6.5, cy = ALTO_BANDA / 2;
  if (A_COLOR) { doc.setFillColor(255, 255, 255); doc.circle(cx, cy, 6.8, 'F'); }
  doc.addImage(LOGO_DATA_URI, 'PNG', cx - 6, cy - 6, 12, 12);
  doc.setTextColor(...(A_COLOR ? [255, 255, 255] as [number, number, number] : GREEN));
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setCharSpace(0.2);
  doc.text('SEMILLERO EL MANANTIAL', cx + 10, cy - 0.5);
  doc.setCharSpace(0);
  doc.setTextColor(...GOLD);
  rotulo(doc, 'Recibo', cx + 10, cy + 4.5);
  if (d.numero) {
    doc.setTextColor(...(A_COLOR ? [255, 255, 255] as [number, number, number] : GREEN));
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
    doc.text(`N° ${d.numero}`, derecha, cy - 0.5, { align: 'right' });
  }
  const fecha = new Date(d.fecha).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  doc.setTextColor(...GOLD);
  rotulo(doc, fecha, derecha, cy + 4.5, 'right');

  let y = ALTO_BANDA + 12;

  // ── Recibí de… ────────────────────────────────────────────────────────────
  doc.setTextColor(...GRIS);
  rotulo(doc, 'Recibí de', MARGEN, y);
  y += 5.5;
  doc.setTextColor(...DARK);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
  doc.text(doc.splitTextToSize(d.cliente, ancho - MARGEN * 2 - 26)[0], MARGEN, y);
  if (d.cod_cliente != null) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...GRIS);
    doc.text(`Cliente ${d.cod_cliente}`, derecha, y, { align: 'right' });
  }
  y += 9;

  // ── La suma de… (el importe, que es el centro del papel) ──────────────────
  doc.setDrawColor(...LINEA);
  doc.roundedRect(MARGEN, y, ancho - MARGEN * 2, 26, 2, 2, 'S');
  doc.setTextColor(...GRIS);
  rotulo(doc, 'La suma de', MARGEN + 5, y + 6);
  doc.setTextColor(...DARK);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(19);
  doc.text(money(d.monto), MARGEN + 5, y + 15);
  // En letras, que es la defensa contra que al número le agreguen un dígito.
  doc.setFont('helvetica', 'italic'); doc.setFontSize(9);
  doc.setTextColor(...GRIS);
  const letras = doc.splitTextToSize(montoEnLetras(d.monto).toUpperCase(), ancho - MARGEN * 2 - 10);
  doc.text(letras.slice(0, 2), MARGEN + 5, y + 21);
  y += 34;

  // ── Cómo pagó ─────────────────────────────────────────────────────────────
  const datos: Array<[string, string]> = [];
  if (d.medio_pago) datos.push(['Forma de pago', d.medio_pago]);
  if (d.banco_origen) datos.push(['Banco', d.banco_origen]);
  if (d.referencia) datos.push(['Comprobante', d.referencia]);
  if (datos.length) {
    doc.setDrawColor(...LINEA);
    doc.line(MARGEN, y, derecha, y);
    y += 6;
    let x = MARGEN;
    const col = (ancho - MARGEN * 2) / Math.min(datos.length, 3);
    for (const [k, v] of datos) {
      doc.setTextColor(...GRIS);
      rotulo(doc, k, x, y);
      doc.setTextColor(...DARK);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
      doc.text(doc.splitTextToSize(v, col - 4)[0], x, y + 5.5);
      x += col;
    }
    y += 12;
  }

  if (d.observaciones) {
    doc.setTextColor(...GRIS);
    rotulo(doc, 'Observaciones', MARGEN, y);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5);
    doc.setTextColor(...DARK);
    doc.text(doc.splitTextToSize(d.observaciones, ancho - MARGEN * 2).slice(0, 3), MARGEN, y + 5);
    y += 16;
  }

  // ── Firma de quien recibió ────────────────────────────────────────────────
  // 🪤 Estaba clavada a 150 mm y dejaba media hoja en blanco: impreso pasa, pero el caso real
  // es mandarlo por WhatsApp, y en el celular un papel con un agujero en el medio se ve mal.
  // Va después del contenido, con el aire justo para firmar arriba de la línea.
  y = Math.max(y + 20, 118);
  const anchoFirma = 58;
  doc.setDrawColor(...GRIS);
  doc.line(derecha - anchoFirma, y, derecha, y);
  doc.setTextColor(...GRIS);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  doc.text(d.vendedor ? `Recibió: ${d.vendedor}` : 'Recibió', derecha - anchoFirma / 2, y + 5, { align: 'center' });

  // ── Pie ───────────────────────────────────────────────────────────────────
  const pie = 200;   // A5 mide 210 mm de alto
  doc.setDrawColor(...LINEA);
  doc.line(MARGEN, pie - 6, derecha, pie - 6);
  doc.setTextColor(...GRIS);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5);
  /**
   * 🔑 Mientras la oficina no lo imputó, este papel respalda que el VENDEDOR recibió la plata,
   * no que la empresa la aplicó a la cuenta corriente. Decirlo evita el reclamo por una
   * imputación que todavía no pasó — y es lo mismo que pasaba con el recibo de papel.
   */
  doc.text(
    d.numero
      ? 'Comprobante emitido por Semillero El Manantial.'
      : 'CONSTANCIA PROVISORIA de recepción: vale como comprobante de entrega al vendedor. La imputación a la cuenta corriente se confirma en las próximas horas.',
    MARGEN, pie, { maxWidth: ancho - MARGEN * 2 });

  return { blob: doc.output('blob'), nombre: nombreArchivo(d) };
}

/** Abre el menú de compartir del celular; si el navegador no lo soporta, descarga el archivo. */
export async function compartirReciboPdf(d: DatosRecibo): Promise<'compartido' | 'descargado'> {
  const { blob, nombre } = generarReciboPdf(d);
  const file = new File([blob], nombre, { type: 'application/pdf' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: nombre });
      return 'compartido';
    } catch (e: any) {
      if (e?.name === 'AbortError') return 'compartido';   // lo canceló el usuario
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = nombre; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return 'descargado';
}
