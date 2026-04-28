import { CalendarClock, RotateCcw } from 'lucide-react';
import type { ViewPeriod } from './PeriodSelector';
import './HistoricBanner.css';

interface Props {
    period: ViewPeriod;
    onReset: () => void;
}

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

export function HistoricBanner({ period, onReset }: Props) {
    const monthLabel = `${MESES[period.month - 1]} ${period.year}`;
    const corteLabel = period.asOfDay
        ? ` al día ${period.asOfDay}`
        : '';
    return (
        <div className="hb-wrap" role="status" aria-live="polite">
            <div className="hb-content">
                <CalendarClock size={16} />
                <span className="hb-text">
                    Viendo cierre histórico: <strong>{monthLabel}{corteLabel}</strong> · solo lectura
                </span>
            </div>
            <button type="button" className="hb-reset" onClick={onReset} title="Volver al período actual">
                <RotateCcw size={13} />
                <span>Volver al actual</span>
            </button>
        </div>
    );
}
