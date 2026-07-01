import { useEffect, useMemo, useRef, useState } from 'react';
import { Calendar, Check, Clock } from 'lucide-react';
import './PeriodSelector.css';

export interface ViewPeriod {
    year: number;
    month: number;
    /** Día del mes para corte intra-mes. null = mes completo (último día del mes en histórico, hoy en mes actual). */
    asOfDay?: number | null;
}

interface Props {
    value: ViewPeriod;
    onChange: (p: ViewPeriod) => void;
    /** Cantidad de meses hacia atrás disponibles. Default 12. */
    monthsBack?: number;
    /** Cantidad de meses hacia adelante (para precargar objetivos del mes que viene). Default 0. */
    monthsForward?: number;
}

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

function nowYM(): { year: number; month: number; day: number } {
    const d = new Date();
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function isCurrent(p: ViewPeriod): boolean {
    const t = nowYM();
    return p.year === t.year && p.month === t.month && (p.asOfDay == null);
}

function buildOptions(monthsBack: number, monthsForward: number): Array<{ year: number; month: number; label: string; isCurrent: boolean; isFuture: boolean }> {
    const t = nowYM();
    const out: Array<{ year: number; month: number; label: string; isCurrent: boolean; isFuture: boolean }> = [];
    // Meses futuros primero (arriba en la lista), de +N hasta +1: sirven para
    // precargar los objetivos del mes que viene antes de que empiece.
    for (let i = monthsForward; i >= 1; i--) {
        let m = t.month + i;
        let y = t.year;
        while (m > 12) { m -= 12; y += 1; }
        out.push({ year: y, month: m, label: `${MESES[m - 1]} ${y}`, isCurrent: false, isFuture: true });
    }
    // Mes actual + meses hacia atrás.
    for (let i = 0; i < monthsBack; i++) {
        let m = t.month - i;
        let y = t.year;
        while (m <= 0) { m += 12; y -= 1; }
        out.push({ year: y, month: m, label: `${MESES[m - 1]} ${y}`, isCurrent: i === 0, isFuture: false });
    }
    return out;
}

/** Días del mes que caen miércoles (1=Lunes, 2=Martes, ..., 3=Miércoles UTC). */
function miercolesDelMes(year: number, month: number): number[] {
    const days = new Date(year, month, 0).getDate();
    const out: number[] = [];
    for (let d = 1; d <= days; d++) {
        // getDay con UTC: 0=Dom, 1=Lun, 2=Mar, 3=Mié.
        const wd = new Date(Date.UTC(year, month - 1, d)).getUTCDay();
        if (wd === 3) out.push(d);
    }
    return out;
}

function lastDayOfMonth(year: number, month: number): number {
    return new Date(year, month, 0).getDate();
}

function pad2(n: number): string { return String(n).padStart(2, '0'); }

export function PeriodSelector({ value, onChange, monthsBack = 12, monthsForward = 0 }: Props) {
    const [open, setOpen] = useState(false);
    const [tab, setTab] = useState<'mes' | 'corte'>('mes');
    const ref = useRef<HTMLDivElement | null>(null);
    const historic = !isCurrent(value);
    const options = buildOptions(monthsBack, monthsForward);
    const today = nowYM();
    const isCurrentMonthSelected = value.year === today.year && value.month === today.month;
    // ¿El período elegido es futuro? (para etiquetar "próximo" en vez de "histórico").
    const isFutureSel = value.year > today.year || (value.year === today.year && value.month > today.month);
    const miercoles = useMemo(() => miercolesDelMes(value.year, value.month), [value.year, value.month]);
    const lastDay = lastDayOfMonth(value.year, value.month);
    // Permitir días futuros dentro del mes en curso: en Semillero se factura
    // con fa_fecha posterior a hoy y esas ventas deben poder verse en el corte.
    // El backend valida que asOfDate esté dentro del mes elegido.
    const maxDay = lastDay;
    const minDate = `${value.year}-${pad2(value.month)}-01`;
    const maxDate = `${value.year}-${pad2(value.month)}-${pad2(maxDay)}`;

    const pillLabel = `${MESES[value.month - 1]} ${value.year}` + (value.asOfDay ? ` · día ${value.asOfDay}` : '');

    useEffect(() => {
        if (!open) return;
        const onClick = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', onClick);
        document.addEventListener('keydown', onEsc);
        return () => {
            document.removeEventListener('mousedown', onClick);
            document.removeEventListener('keydown', onEsc);
        };
    }, [open]);

    const handlePickMonth = (year: number, month: number) => {
        // Al cambiar de mes, asOfDay se resetea (no tiene sentido cargar el mismo día en otro mes).
        onChange({ year, month, asOfDay: null });
        setTab('corte');
    };

    const handlePickDay = (day: number | null) => {
        onChange({ ...value, asOfDay: day });
        setOpen(false);
    };

    return (
        <div className={`ps-wrap ${historic ? 'is-historic' : ''}`} ref={ref}>
            <button
                type="button"
                className={`ps-pill ${historic ? 'is-historic' : ''}`}
                onClick={() => { setOpen(o => !o); setTab('mes'); }}
                title={historic ? 'Viendo período histórico' : 'Cambiar período'}
                aria-haspopup="listbox"
                aria-expanded={open}
            >
                <Calendar size={14} />
                <span className="ps-pill-label">{pillLabel}</span>
                {historic && <span className="ps-pill-tag">{isFutureSel ? 'próximo' : 'histórico'}</span>}
            </button>
            {open && (
                <div className="ps-popover" role="dialog">
                    <div className="ps-popover-header">
                        <strong>Período</strong>
                        {/* "Volver al actual" ya vive en el HistoricBanner — no duplicar acá. */}
                    </div>

                    <div className="ps-tabs" role="tablist">
                        <button type="button" role="tab"
                            className={`ps-tab ${tab === 'mes' ? 'is-active' : ''}`}
                            aria-selected={tab === 'mes'}
                            onClick={() => setTab('mes')}>
                            <Calendar size={12} /> Mes
                        </button>
                        <button type="button" role="tab"
                            className={`ps-tab ${tab === 'corte' ? 'is-active' : ''}`}
                            aria-selected={tab === 'corte'}
                            onClick={() => setTab('corte')}>
                            <Clock size={12} /> Corte
                        </button>
                    </div>

                    {tab === 'mes' && (
                        <div className="ps-popover-list" role="listbox">
                            {options.map(o => {
                                const selected = o.year === value.year && o.month === value.month;
                                return (
                                    <button
                                        key={`${o.year}-${o.month}`}
                                        type="button"
                                        className={`ps-opt ${selected ? 'is-selected' : ''} ${o.isCurrent ? 'is-current' : ''}`}
                                        onClick={() => handlePickMonth(o.year, o.month)}
                                        role="option"
                                        aria-selected={selected}
                                    >
                                        <span className="ps-opt-label">
                                            {o.label}
                                            {o.isCurrent && <span className="ps-opt-tag">mes actual</span>}
                                            {o.isFuture && <span className="ps-opt-tag ps-opt-tag--next">próximo</span>}
                                        </span>
                                        {selected && <Check size={14} />}
                                    </button>
                                );
                            })}
                        </div>
                    )}

                    {tab === 'corte' && (
                        <div className="ps-corte">
                            <p className="ps-corte-help">
                                Elegí cómo ver <strong>{MESES[value.month - 1]} {value.year}</strong>:
                            </p>
                            <div className="ps-chips">
                                <button type="button"
                                    className={`ps-chip ${value.asOfDay == null ? 'is-active' : ''}`}
                                    onClick={() => handlePickDay(null)}>
                                    {isCurrentMonthSelected ? 'Hoy (mes en curso)' : 'Mes completo'}
                                </button>
                                {miercoles
                                    .filter(d => d <= maxDay)
                                    .map(d => (
                                        <button key={d} type="button"
                                            className={`ps-chip ${value.asOfDay === d ? 'is-active' : ''}`}
                                            onClick={() => handlePickDay(d)}
                                            title={`Avance al miércoles ${d} de ${MESES[value.month - 1]}`}>
                                            Mié {pad2(d)}
                                        </button>
                                    ))}
                            </div>
                            <label className="ps-otro-dia">
                                <span>Otro día:</span>
                                <input
                                    type="date"
                                    min={minDate}
                                    max={maxDate}
                                    value={value.asOfDay ? `${value.year}-${pad2(value.month)}-${pad2(value.asOfDay)}` : ''}
                                    onChange={e => {
                                        const v = e.target.value;
                                        if (!v) { handlePickDay(null); return; }
                                        const day = parseInt(v.slice(8, 10), 10);
                                        if (Number.isInteger(day) && day >= 1 && day <= maxDay) handlePickDay(day);
                                    }}
                                />
                            </label>
                            {value.asOfDay && (
                                <button type="button" className="ps-clear-day" onClick={() => handlePickDay(null)}>
                                    Limpiar corte (ver mes completo)
                                </button>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
