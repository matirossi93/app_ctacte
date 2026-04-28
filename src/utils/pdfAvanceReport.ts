import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

const formatCurrency = (n: number | null | undefined): string => {
    if (n == null) return '—';
    return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
};

const formatPct = (p: number | null | undefined): string => {
    if (p == null) return '—';
    return `${Math.round(p * 100)}%`;
};

// Colores Semillero — match con pdfReport.ts (Cobranzas).
const GREEN: [number, number, number] = [6, 101, 47];
const GOLD: [number, number, number] = [238, 192, 69];
const BEIGE: [number, number, number] = [249, 239, 227];
const DARK: [number, number, number] = [30, 18, 12];

const MESES_LARGOS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

export interface AvanceVendorRow {
    cod_vendedor: number;
    nombre: string;
    target_neto: number | null;
    avance: number;
    pct_cumplimiento: number | null;
    proyeccion: number;
    necesario_por_dia: number | null;
    num_comprobantes: number;
    activo?: boolean;
}

export interface AvanceClienteRow {
    cod_cliente: number;
    razon_social: string | null;
    localidad: string | null;
    cod_vendedor: number | null;
    objetivo_mes: number | null;
    avance: number;
    pct_cumplimiento: number | null;
    status: string;
}

export interface AvanceReportData {
    period: { year: number; month: number; asOfDay?: number | null };
    /** true cuando year/month != actual (cierre histórico). */
    isHistoric: boolean;
    diasHabilesTotal: number;
    diasHabilesTranscurridos: number;
    diasRestantes: number;
    totales: { target: number; avance: number; pct: number | null; proyeccion: number; vendedoresConTarget: number; vendedoresTotal: number } | null;
    vendedores: AvanceVendorRow[];
    /** Top clientes con objetivo del mes (opcional, anexo). Si vacío, no se anexa. */
    clientesTop?: AvanceClienteRow[];
    /** Filtro aplicado (vendedor único, localidad). Va al header. */
    filtroLabel?: string | null;
}

function periodLabel(p: { year: number; month: number; asOfDay?: number | null }): string {
    const m = MESES_LARGOS[p.month - 1];
    if (p.asOfDay) return `${m} ${p.year} — corte al día ${p.asOfDay}`;
    return `${m} ${p.year}`;
}

function fileNameSlug(p: { year: number; month: number; asOfDay?: number | null }): string {
    const mm = String(p.month).padStart(2, '0');
    const base = `${MESES_LARGOS[p.month - 1]}-${p.year}`;
    if (p.asOfDay) return `${base}_al-${String(p.asOfDay).padStart(2, '0')}`;
    return `${base}_${mm}`;
}

/**
 * Genera el PDF de Avance de Objetivos. Pensado para reuniones de equipo
 * donde se muestra cómo viene cada vendedor vs su target del mes.
 */
export function generateAvanceReport(data: AvanceReportData) {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 14;
    const today = new Date();
    const dateStr = today.toLocaleDateString('es-AR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const headerLabel = data.isHistoric ? 'Cierre histórico' : 'Avance al día';

    // ── Portada ──
    doc.setFillColor(...GREEN);
    doc.rect(0, 0, pageWidth, 55, 'F');
    doc.setFillColor(...GOLD);
    doc.rect(0, 55, pageWidth, 3, 'F');

    doc.setTextColor(255, 255, 255);
    doc.setFontSize(20);
    doc.setFont('helvetica', 'bold');
    doc.text('SEMILLERO EL MANANTIAL', pageWidth / 2, 22, { align: 'center' });

    doc.setFontSize(13);
    doc.setFont('helvetica', 'normal');
    doc.text(`${headerLabel} de Objetivos · ${periodLabel(data.period)}`, pageWidth / 2, 33, { align: 'center' });

    doc.setFontSize(9);
    doc.text(dateStr, pageWidth / 2, 44, { align: 'center' });
    if (data.filtroLabel) {
        doc.setFontSize(9);
        doc.text(`Filtro: ${data.filtroLabel}`, pageWidth / 2, 50, { align: 'center' });
    }

    let y = 70;

    // ── Resumen ejecutivo ──
    doc.setTextColor(...DARK);
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.text('Resumen ejecutivo', margin, y);
    y += 6;

    const T = data.totales;
    const resumenRows: [string, string][] = [
        ['Período', periodLabel(data.period)],
        ['Días hábiles del mes', String(data.diasHabilesTotal)],
        [data.isHistoric ? 'Días hábiles del corte' : 'Días hábiles transcurridos', String(data.diasHabilesTranscurridos)],
        [data.isHistoric ? 'Cierre' : 'Días restantes', data.isHistoric ? '—' : String(data.diasRestantes)],
    ];
    if (T) {
        resumenRows.push(
            ['Target equipo', formatCurrency(T.target)],
            ['Avance equipo', formatCurrency(T.avance)],
            ['% cumplimiento', formatPct(T.pct)],
            ['Proyección fin de mes', formatCurrency(T.proyeccion)],
            ['Vendedores con target', `${T.vendedoresConTarget} de ${T.vendedoresTotal}`],
        );
    }
    autoTable(doc, {
        startY: y,
        margin: { left: margin, right: margin },
        head: [['Indicador', 'Valor']],
        body: resumenRows,
        theme: 'grid',
        headStyles: { fillColor: GREEN, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 9 },
        bodyStyles: { fontSize: 9, textColor: DARK },
        alternateRowStyles: { fillColor: BEIGE },
        columnStyles: { 1: { halign: 'right', fontStyle: 'bold' } },
    });

    let currentY = (doc as any).lastAutoTable.finalY + 10;

    // ── Tabla por vendedor ──
    if (currentY > 240) { doc.addPage(); currentY = 20; }
    doc.setTextColor(...DARK);
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.text('Avance por vendedor', margin, currentY);
    currentY += 6;

    // Solo vendedores activos en la tabla principal — los inactivos van al fondo.
    const activos = data.vendedores.filter(v => v.activo !== false);
    const sortedActivos = [...activos].sort((a, b) => (b.pct_cumplimiento ?? -1) - (a.pct_cumplimiento ?? -1));

    autoTable(doc, {
        startY: currentY,
        margin: { left: margin, right: margin },
        head: [['Vendedor', 'Target', 'Avance', '%', 'Proyección', 'Necesario/día', 'Comp.']],
        body: sortedActivos.map(v => [
            v.nombre,
            formatCurrency(v.target_neto),
            formatCurrency(v.avance),
            formatPct(v.pct_cumplimiento),
            formatCurrency(v.proyeccion),
            data.isHistoric ? '—' : formatCurrency(v.necesario_por_dia),
            String(v.num_comprobantes),
        ]),
        theme: 'striped',
        headStyles: { fillColor: GREEN, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8.5 },
        bodyStyles: { fontSize: 8.5, textColor: DARK },
        alternateRowStyles: { fillColor: BEIGE },
        columnStyles: {
            0: { cellWidth: 42, fontStyle: 'bold' },
            1: { halign: 'right', cellWidth: 26 },
            2: { halign: 'right', cellWidth: 26 },
            3: { halign: 'center', cellWidth: 14 },
            4: { halign: 'right', cellWidth: 28 },
            5: { halign: 'right', cellWidth: 28 },
            6: { halign: 'center', cellWidth: 14 },
        },
        didParseCell: (cell) => {
            if (cell.section !== 'body' || cell.column.index !== 3) return;
            const text = cell.cell.text[0] ?? '';
            const m = text.match(/^(\d+)/);
            if (!m) return;
            const pct = parseInt(m[1], 10);
            if (pct >= 90) cell.cell.styles.textColor = [6, 101, 47];
            else if (pct >= 50) cell.cell.styles.textColor = [181, 136, 41];
            else cell.cell.styles.textColor = [168, 62, 43];
            cell.cell.styles.fontStyle = 'bold';
        },
    });

    currentY = (doc as any).lastAutoTable.finalY + 8;

    // ── Anexo: top clientes con objetivo ──
    if (data.clientesTop && data.clientesTop.length > 0) {
        if (currentY > 220) { doc.addPage(); currentY = 20; }
        doc.setTextColor(...DARK);
        doc.setFontSize(11);
        doc.setFont('helvetica', 'bold');
        doc.text(`Anexo · Top ${data.clientesTop.length} clientes con objetivo`, margin, currentY);
        currentY += 5;

        autoTable(doc, {
            startY: currentY,
            margin: { left: margin, right: margin },
            head: [['Cliente', 'Localidad', 'Cód.', 'Objetivo', 'Avance', '%', 'Status']],
            body: data.clientesTop.map(c => [
                c.razon_social ?? '',
                c.localidad ?? '',
                String(c.cod_cliente),
                formatCurrency(c.objetivo_mes),
                formatCurrency(c.avance),
                formatPct(c.pct_cumplimiento),
                c.status,
            ]),
            theme: 'striped',
            headStyles: { fillColor: GREEN, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 7.5 },
            bodyStyles: { fontSize: 7.5, textColor: DARK },
            alternateRowStyles: { fillColor: BEIGE },
            columnStyles: {
                0: { cellWidth: 56 },
                1: { cellWidth: 28 },
                2: { halign: 'center', cellWidth: 14 },
                3: { halign: 'right', cellWidth: 24 },
                4: { halign: 'right', cellWidth: 24 },
                5: { halign: 'center', cellWidth: 14 },
                6: { halign: 'center', cellWidth: 22 },
            },
        });
    }

    // ── Pie de página ──
    const totalPages = doc.getNumberOfPages();
    for (let i = 1; i <= totalPages; i++) {
        doc.setPage(i);
        doc.setFontSize(7);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(150, 140, 130);
        doc.text(
            `Semillero El Manantial S.R.L. — ${headerLabel} ${periodLabel(data.period)} · generado ${today.toLocaleDateString('es-AR')} ${today.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}`,
            margin,
            290
        );
        doc.text(`Página ${i} de ${totalPages}`, pageWidth - margin, 290, { align: 'right' });
    }

    doc.save(`avance_${fileNameSlug(data.period)}.pdf`);
}
