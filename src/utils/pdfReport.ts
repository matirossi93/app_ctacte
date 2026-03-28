import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { VendorSummary, ClientSummary } from '../types';

const formatCurrency = (amount: number): string =>
    new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(amount);

// Colores Semillero
const GREEN: [number, number, number] = [6, 101, 47];
const GOLD: [number, number, number] = [238, 192, 69];
const BEIGE: [number, number, number] = [249, 239, 227];
const DARK: [number, number, number] = [30, 18, 12];

/**
 * Genera un PDF con informe de deudas por vendedor, clientes agrupados por zona.
 * Diseñado para la reunión de los miércoles con vendedores.
 */
export const generateVendorReport = (vendors: VendorSummary[]) => {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 14;
    const today = new Date();
    const dateStr = today.toLocaleDateString('es-AR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    // Filtrar vendedores con deuda real
    const activeVendors = vendors.filter(v => v.totalBalance > 1 && v.clients.length > 0);

    // ── Portada ──
    doc.setFillColor(...GREEN);
    doc.rect(0, 0, pageWidth, 55, 'F');

    // Línea dorada decorativa
    doc.setFillColor(...GOLD);
    doc.rect(0, 55, pageWidth, 3, 'F');

    doc.setTextColor(255, 255, 255);
    doc.setFontSize(22);
    doc.setFont('helvetica', 'bold');
    doc.text('SEMILLERO EL MANANTIAL', pageWidth / 2, 22, { align: 'center' });

    doc.setFontSize(14);
    doc.setFont('helvetica', 'normal');
    doc.text('Informe de Cobranzas por Vendedor', pageWidth / 2, 33, { align: 'center' });

    doc.setFontSize(10);
    doc.text(dateStr, pageWidth / 2, 44, { align: 'center' });

    // Resumen ejecutivo
    let y = 70;
    doc.setTextColor(...DARK);
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.text('Resumen Ejecutivo', margin, y);
    y += 8;

    const totalDeuda = activeVendors.reduce((s, v) => s + v.totalBalance, 0);
    const totalConInteres = activeVendors.reduce((s, v) => s + v.totalWithInterest, 0);
    const totalClientes = activeVendors.reduce((s, v) => s + v.clients.length, 0);
    const totalMora = activeVendors.reduce((s, v) => s + v.clients.filter(c => c.maxDaysOverdue > 0).length, 0);

    autoTable(doc, {
        startY: y,
        margin: { left: margin, right: margin },
        head: [['Indicador', 'Valor']],
        body: [
            ['Vendedores activos', String(activeVendors.length)],
            ['Total clientes con deuda', String(totalClientes)],
            ['Clientes en mora', String(totalMora)],
            ['Deuda total (sin interés)', formatCurrency(totalDeuda)],
            ['Deuda total (con interés)', formatCurrency(totalConInteres)],
        ],
        theme: 'grid',
        headStyles: { fillColor: GREEN, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 9 },
        bodyStyles: { fontSize: 9, textColor: DARK },
        alternateRowStyles: { fillColor: BEIGE },
        columnStyles: { 1: { halign: 'right', fontStyle: 'bold' } },
    });

    // ── Detalle por vendedor ──
    activeVendors.forEach(vendor => {
        doc.addPage();

        // Header verde del vendedor
        doc.setFillColor(...GREEN);
        doc.rect(0, 0, pageWidth, 28, 'F');
        doc.setFillColor(...GOLD);
        doc.rect(0, 28, pageWidth, 2, 'F');

        doc.setTextColor(255, 255, 255);
        doc.setFontSize(16);
        doc.setFont('helvetica', 'bold');
        doc.text(vendor.vendorName.toUpperCase(), margin, 14);

        doc.setFontSize(9);
        doc.setFont('helvetica', 'normal');
        doc.text(
            `${vendor.clients.length} clientes  |  Deuda: ${formatCurrency(vendor.totalBalance)}  |  Con interés: ${formatCurrency(vendor.totalWithInterest)}`,
            margin, 23
        );

        // Agrupar clientes por zona/localidad
        const clientsByZone = new Map<string, ClientSummary[]>();
        vendor.clients.forEach(c => {
            const zone = c.localidad?.trim() || 'SIN LOCALIDAD';
            if (!clientsByZone.has(zone)) clientsByZone.set(zone, []);
            clientsByZone.get(zone)!.push(c);
        });

        // Ordenar zonas alfabéticamente
        const sortedZones = Array.from(clientsByZone.entries()).sort(([a], [b]) => a.localeCompare(b));

        let currentY = 38;

        sortedZones.forEach(([zone, clients]) => {
            // Verificar espacio en página
            if (currentY > 260) {
                doc.addPage();
                currentY = 20;
            }

            // Título de zona con fondo dorado suave
            doc.setFillColor(252, 243, 222);
            doc.rect(margin, currentY - 5, pageWidth - margin * 2, 8, 'F');
            doc.setTextColor(...GREEN);
            doc.setFontSize(10);
            doc.setFont('helvetica', 'bold');

            const zoneTotal = clients.reduce((s, c) => s + c.totalWithInterest, 0);
            doc.text(`${zone}`, margin + 2, currentY);
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(8);
            doc.text(`${clients.length} clientes — ${formatCurrency(zoneTotal)}`, pageWidth - margin - 2, currentY, { align: 'right' });
            currentY += 6;

            // Ordenar clientes por saldo descendente
            const sortedClients = [...clients].sort((a, b) => b.totalBalance - a.totalBalance);

            const tableBody = sortedClients.map(c => [
                c.clientName,
                c.clientId,
                formatCurrency(c.totalBalance),
                formatCurrency(c.totalInterest),
                formatCurrency(c.totalWithInterest),
                c.maxDaysOverdue > 0 ? `${c.maxDaysOverdue} d.` : 'Al día',
            ]);

            autoTable(doc, {
                startY: currentY,
                margin: { left: margin, right: margin },
                head: [['Cliente', 'Código', 'Saldo', 'Interés', 'Total', 'Mora']],
                body: tableBody,
                theme: 'striped',
                headStyles: {
                    fillColor: GREEN,
                    textColor: [255, 255, 255],
                    fontStyle: 'bold',
                    fontSize: 7.5,
                    cellPadding: 2,
                },
                bodyStyles: {
                    fontSize: 7.5,
                    textColor: DARK,
                    cellPadding: 2,
                },
                alternateRowStyles: { fillColor: BEIGE },
                columnStyles: {
                    0: { cellWidth: 55 },
                    1: { cellWidth: 18, halign: 'center' },
                    2: { halign: 'right', cellWidth: 28 },
                    3: { halign: 'right', cellWidth: 25 },
                    4: { halign: 'right', fontStyle: 'bold', cellWidth: 28 },
                    5: { halign: 'center', cellWidth: 18 },
                },
                didParseCell: (data) => {
                    // Resaltar mora en rojo
                    if (data.section === 'body' && data.column.index === 5) {
                        const text = data.cell.text[0];
                        if (text && text !== 'Al día') {
                            const days = parseInt(text);
                            if (days >= 30) {
                                data.cell.styles.textColor = [239, 68, 68];
                                data.cell.styles.fontStyle = 'bold';
                            } else if (days > 0) {
                                data.cell.styles.textColor = [229, 155, 51];
                                data.cell.styles.fontStyle = 'bold';
                            }
                        }
                    }
                },
            });

            currentY = (doc as any).lastAutoTable.finalY + 8;
        });

        // Subtotal del vendedor al pie
        if (currentY > 270) {
            doc.addPage();
            currentY = 20;
        }

        doc.setDrawColor(...GREEN);
        doc.setLineWidth(0.5);
        doc.line(margin, currentY, pageWidth - margin, currentY);
        currentY += 5;

        doc.setTextColor(...GREEN);
        doc.setFontSize(10);
        doc.setFont('helvetica', 'bold');
        doc.text(`Total ${vendor.vendorName}: ${formatCurrency(vendor.totalWithInterest)}`, pageWidth - margin, currentY, { align: 'right' });
    });

    // ── Pie en cada página ──
    const totalPages = doc.getNumberOfPages();
    for (let i = 1; i <= totalPages; i++) {
        doc.setPage(i);
        doc.setFontSize(7);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(150, 140, 130);
        doc.text(
            `Semillero El Manantial S.R.L. — Informe generado el ${today.toLocaleDateString('es-AR')} a las ${today.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}`,
            margin,
            290
        );
        doc.text(`Página ${i} de ${totalPages}`, pageWidth - margin, 290, { align: 'right' });
    }

    // Descargar
    const dateSlug = today.toISOString().slice(0, 10);
    doc.save(`informe_cobranzas_${dateSlug}.pdf`);
};
