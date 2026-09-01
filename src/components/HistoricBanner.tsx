import { CalendarClock, RotateCcw } from 'lucide-react';
import type { ViewPeriod } from './PeriodSelector';
import { mesEnCursoArgentina } from '../utils/hoyArgentina';
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
    // Mes FUTURO ≠ cierre histórico: es la precarga de objetivos del mes que
    // viene (editable), no un snapshot de solo lectura.
    // 🪤 En hora argentina: con UTC, a partir de las 21:00 del último día del mes, el mes
    // en curso pasaba a contar como "futuro" y el cartel cambiaba de sentido solo.
    const hoyAR = mesEnCursoArgentina();
    const isFuture = period.year > hoyAR.year
        || (period.year === hoyAR.year && period.month > hoyAR.month);
    return (
        <div className="hb-wrap" role="status" aria-live="polite">
            <div className="hb-content">
                <CalendarClock size={16} />
                <span className="hb-text">
                    {isFuture
                        ? <>Viendo mes próximo: <strong>{monthLabel}</strong> · podés precargar objetivos</>
                        : <>Viendo cierre histórico: <strong>{monthLabel}{corteLabel}</strong> · solo lectura</>}
                </span>
            </div>
            <button type="button" className="hb-reset" onClick={onReset} title="Volver al período actual">
                <RotateCcw size={13} />
                <span>Volver al actual</span>
            </button>
        </div>
    );
}
