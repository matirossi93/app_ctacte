import { useState } from 'react';
import { X, Download, Loader2, AlertCircle } from 'lucide-react';
import { authHeaders } from '../utils/auth';
import type { ViewPeriod } from './PeriodSelector';
import './ReportesModal.css';

interface Props {
    onClose: () => void;
    /** Período activo (mes a exportar). Viene del state global viewPeriod del VendorShell. */
    period: ViewPeriod;
}

interface Reporte {
    tipo: string;
    nombre: string;
    descripcion: string;
}

const REPORTES: Reporte[] = [
    {
        tipo: 'target-cero',
        nombre: 'Clientes con objetivo $0',
        descripcion: 'Clientes cuyo objetivo del mes es 0 o no está seteado. Útil para chequear con vendedores cuáles están inactivos o pendientes de asignación.',
    },
    {
        tipo: 'matriz-target-real',
        nombre: 'Matriz target vs real del mes',
        descripcion: 'Por cada cliente con target o facturación en el mes: target asignado, real facturado, diferencia, % cumplimiento y status.',
    },
    {
        tipo: 'sin-actividad-30d',
        nombre: 'Clientes sin actividad 30d',
        descripcion: 'Clientes con saldo, target o facturación histórica que no tuvieron nota/llamada/pago registrado en los últimos 30 días.',
    },
];

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

export function ReportesModal({ onClose, period }: Props) {
    // Período controlado externamente desde VendorShell (PeriodSelector global).
    const year = period.year;
    const month = period.month;
    const [busy, setBusy] = useState<string | null>(null);
    const [err, setErr] = useState<string | null>(null);

    const descargar = async (tipo: string, nombreReporte: string) => {
        setBusy(tipo);
        setErr(null);
        try {
            const res = await fetch(`/api/reportes/${tipo}?year=${year}&month=${month}`, {
                headers: authHeaders(),
            });
            if (!res.ok) {
                const errBody = await res.json().catch(() => ({}));
                throw new Error(errBody.error ?? `HTTP ${res.status}`);
            }
            const blob = await res.blob();
            const rows = res.headers.get('X-Report-Rows');
            const cd = res.headers.get('content-disposition') || '';
            const match = cd.match(/filename="([^"]+)"/);
            const fileName = match ? match[1] : `${tipo}-${year}-${String(month).padStart(2, '0')}.xlsx`;
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            if (rows === '0') setErr(`${nombreReporte}: 0 filas — el archivo está vacío`);
        } catch (e: any) {
            setErr(e?.message ?? 'Error al descargar');
        } finally {
            setBusy(null);
        }
    };

    return (
        <div className="rep-overlay" onClick={onClose}>
            <div className="rep-modal" onClick={e => e.stopPropagation()}>
                <header className="rep-head">
                    <h2><Download size={18} /> Exportar reportes</h2>
                    <button className="rep-close" onClick={onClose} aria-label="Cerrar"><X size={20} /></button>
                </header>

                <div className="rep-period rep-period-readonly">
                    <span className="rep-period-label">Período:</span>
                    <strong>{MESES[month - 1]} {year}</strong>
                    <span className="rep-period-hint">cambialo con el selector de período</span>
                </div>

                {err && <div className="rep-error"><AlertCircle size={16} /> {err}</div>}

                <div className="rep-list">
                    {REPORTES.map(r => (
                        <div key={r.tipo} className="rep-card">
                            <div className="rep-card-info">
                                <h3>{r.nombre}</h3>
                                <p>{r.descripcion}</p>
                            </div>
                            <button
                                className="rep-dl-btn"
                                disabled={busy != null}
                                onClick={() => descargar(r.tipo, r.nombre)}
                            >
                                {busy === r.tipo
                                    ? <><Loader2 size={16} className="rep-spin" /> Generando...</>
                                    : <><Download size={16} /> Descargar</>}
                            </button>
                        </div>
                    ))}
                </div>

                <footer className="rep-foot">
                    <span>Los archivos se descargan en formato .xlsx. Filas ordenadas por prioridad.</span>
                </footer>
            </div>
        </div>
    );
}
