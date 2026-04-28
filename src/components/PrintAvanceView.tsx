import { useEffect } from 'react';
import { X, Printer, Download } from 'lucide-react';
import type { ViewPeriod } from './PeriodSelector';
import { generateAvanceReport, type AvanceReportData } from '../utils/pdfAvanceReport';
import './PrintAvanceView.css';

interface Props {
    period: ViewPeriod;
    isHistoric: boolean;
    diasHabilesTotal: number;
    diasHabilesTranscurridos: number;
    diasRestantes: number;
    totales: AvanceReportData['totales'];
    vendedores: AvanceReportData['vendedores'];
    clientesTop?: AvanceReportData['clientesTop'];
    filtroLabel?: string | null;
    onClose: () => void;
}

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

const formatMoney = (n: number | null | undefined): string => {
    if (n == null) return '—';
    return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
};
const formatPct = (p: number | null | undefined): string => {
    if (p == null) return '—';
    return `${Math.round(p * 100)}%`;
};

export function PrintAvanceView(props: Props) {
    const { period, isHistoric, diasHabilesTotal, diasHabilesTranscurridos, diasRestantes, totales, vendedores, clientesTop, filtroLabel, onClose } = props;

    // Activar modo print: agrega clase al body para CSS @media print pueda ocultar
    // todo lo que no sea esta vista (sin esto, el browser imprime también el shell).
    useEffect(() => {
        document.body.classList.add('pav-print-active');
        return () => document.body.classList.remove('pav-print-active');
    }, []);

    // ESC para cerrar
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    const periodLabel = `${MESES[period.month - 1]} ${period.year}${period.asOfDay ? ` — al día ${period.asOfDay}` : ''}`;
    const headerLabel = isHistoric ? 'Cierre histórico' : 'Avance al día';
    const generadoStr = new Date().toLocaleString('es-AR', { dateStyle: 'long', timeStyle: 'short' });

    const handleDescargar = () => {
        generateAvanceReport({
            period,
            isHistoric,
            diasHabilesTotal,
            diasHabilesTranscurridos,
            diasRestantes,
            totales,
            vendedores,
            clientesTop,
            filtroLabel,
        });
    };

    const sortedVendedores = [...vendedores]
        .filter(v => v.activo !== false)
        .sort((a, b) => (b.pct_cumplimiento ?? -1) - (a.pct_cumplimiento ?? -1));

    return (
        <div className="pav-overlay" role="dialog" aria-modal="true">
            {/* Toolbar — sólo visible en pantalla, oculta al imprimir */}
            <div className="pav-toolbar pav-no-print">
                <div className="pav-toolbar-left">
                    <strong>{headerLabel}: {periodLabel}</strong>
                </div>
                <div className="pav-toolbar-actions">
                    <button className="pav-btn" onClick={() => window.print()} title="Imprimir directo (Ctrl+P)">
                        <Printer size={14} /> Imprimir
                    </button>
                    <button className="pav-btn pav-btn-primary" onClick={handleDescargar} title="Descargar PDF">
                        <Download size={14} /> Descargar PDF
                    </button>
                    <button className="pav-btn pav-btn-icon" onClick={onClose} aria-label="Cerrar">
                        <X size={16} />
                    </button>
                </div>
            </div>

            {/* Contenido a imprimir */}
            <div className="pav-print-root">
                <header className="pav-head">
                    <div className="pav-head-brand">
                        <h1>SEMILLERO EL MANANTIAL</h1>
                        <p>{headerLabel} de Objetivos · {periodLabel}</p>
                    </div>
                    <div className="pav-head-meta">
                        <span>Generado {generadoStr}</span>
                        {filtroLabel && <span>Filtro: {filtroLabel}</span>}
                    </div>
                </header>

                <section className="pav-resumen">
                    <h2>Resumen ejecutivo</h2>
                    <div className="pav-resumen-grid">
                        <div className="pav-resumen-cell">
                            <span className="k">Período</span>
                            <strong>{periodLabel}</strong>
                        </div>
                        <div className="pav-resumen-cell">
                            <span className="k">Días hábiles del mes</span>
                            <strong>{diasHabilesTotal}</strong>
                        </div>
                        <div className="pav-resumen-cell">
                            <span className="k">{isHistoric ? 'Días hábiles del corte' : 'Días transcurridos'}</span>
                            <strong>{diasHabilesTranscurridos}</strong>
                        </div>
                        <div className="pav-resumen-cell">
                            <span className="k">{isHistoric ? 'Cierre' : 'Días restantes'}</span>
                            <strong>{isHistoric ? 'Mes cerrado' : diasRestantes}</strong>
                        </div>
                        {totales && (
                            <>
                                <div className="pav-resumen-cell">
                                    <span className="k">Target equipo</span>
                                    <strong>{formatMoney(totales.target)}</strong>
                                </div>
                                <div className="pav-resumen-cell">
                                    <span className="k">Avance equipo</span>
                                    <strong className="pav-gold">{formatMoney(totales.avance)}</strong>
                                </div>
                                <div className="pav-resumen-cell">
                                    <span className="k">% Cumplimiento</span>
                                    <strong>{formatPct(totales.pct)}</strong>
                                </div>
                                <div className="pav-resumen-cell">
                                    <span className="k">Proyección</span>
                                    <strong>{formatMoney(totales.proyeccion)}</strong>
                                </div>
                            </>
                        )}
                    </div>
                </section>

                <section className="pav-vendedores">
                    <h2>Avance por vendedor</h2>
                    <table>
                        <thead>
                            <tr>
                                <th>Vendedor</th>
                                <th className="r">Target</th>
                                <th className="r">Avance</th>
                                <th className="c">%</th>
                                <th className="r">Proyección</th>
                                <th className="r">Necesario/día</th>
                                <th className="c">Comp.</th>
                            </tr>
                        </thead>
                        <tbody>
                            {sortedVendedores.map(v => {
                                const pct = v.pct_cumplimiento ?? 0;
                                const colorClass = pct >= 0.9 ? 'pav-pct-ok' : pct >= 0.5 ? 'pav-pct-mid' : 'pav-pct-low';
                                return (
                                    <tr key={v.cod_vendedor}>
                                        <td><strong>{v.nombre}</strong></td>
                                        <td className="r">{formatMoney(v.target_neto)}</td>
                                        <td className="r">{formatMoney(v.avance)}</td>
                                        <td className={`c ${colorClass}`}>{formatPct(v.pct_cumplimiento)}</td>
                                        <td className="r">{formatMoney(v.proyeccion)}</td>
                                        <td className="r">{isHistoric ? '—' : formatMoney(v.necesario_por_dia)}</td>
                                        <td className="c">{v.num_comprobantes}</td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </section>

                {clientesTop && clientesTop.length > 0 && (
                    <section className="pav-clientes">
                        <h2>Anexo · Top {clientesTop.length} clientes con objetivo</h2>
                        <table>
                            <thead>
                                <tr>
                                    <th>Cliente</th>
                                    <th>Localidad</th>
                                    <th className="c">Cód.</th>
                                    <th className="r">Objetivo</th>
                                    <th className="r">Avance</th>
                                    <th className="c">%</th>
                                    <th className="c">Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                {clientesTop.map(c => (
                                    <tr key={c.cod_cliente}>
                                        <td>{c.razon_social ?? ''}</td>
                                        <td>{c.localidad ?? ''}</td>
                                        <td className="c">{c.cod_cliente}</td>
                                        <td className="r">{formatMoney(c.objetivo_mes)}</td>
                                        <td className="r">{formatMoney(c.avance)}</td>
                                        <td className="c">{formatPct(c.pct_cumplimiento)}</td>
                                        <td className="c">{c.status}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </section>
                )}

                <footer className="pav-foot">
                    <span>Semillero El Manantial S.R.L. — {headerLabel} {periodLabel} · generado {generadoStr}</span>
                </footer>
            </div>
        </div>
    );
}
