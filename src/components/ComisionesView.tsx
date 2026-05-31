import { Fragment, useEffect, useRef, useState } from 'react';
import { DollarSign, Loader2, AlertCircle, RefreshCw, Trophy, Eye, EyeOff } from 'lucide-react';
import { authHeaders } from '../utils/auth';
import type { ViewPeriod } from './PeriodSelector';
import './ComisionesView.css';

const MONTH_NAMES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const CATEGORIA_ORDER = ['5%', '4%', '3.5%', '1%'] as const;
const PRIVACY_STORAGE_KEY = 'ctacte:comisiones:privacy';
const MASKED = '$ ••••';

type Categoria = typeof CATEGORIA_ORDER[number];

interface BreakdownEntry { neto: number; comision: number; lineas: number }
interface ComisionVendedor {
    cod_vendedor: number;
    nombre: string;
    email: string | null;
    activo: boolean;
    neto_total: number;
    comision_total: number;
    num_lineas: number;
    num_comprobantes: number;
    breakdown: Record<Categoria, BreakdownEntry>;
}

interface ComisionesResponse {
    ok: boolean;
    year: number;
    month: number;
    items: ComisionVendedor[];
    totales: {
        neto_total: number;
        comision_total: number;
        num_lineas: number;
        num_comprobantes: number;
        breakdown: Record<Categoria, BreakdownEntry>;
    };
    categoria_labels: Record<Categoria, string>;
}

interface Props {
    isAdmin: boolean;
    viewPeriod: ViewPeriod;
    userCodVendedor: number | null;
}

const fmtMoney = (n: number) =>
    new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n);

// Wrapper: si el modo privacidad está activo, devuelve "$ ••••" en vez del
// monto real. Pensado para mostrar la pantalla al cliente sin revelar plata.
const fmtMoneyMaybe = (n: number, hidden: boolean) => hidden ? MASKED : fmtMoney(n);

export const ComisionesView = ({ isAdmin, viewPeriod, userCodVendedor }: Props) => {
    const [data, setData] = useState<ComisionesResponse | null>(null);
    const [loading, setLoading] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const [isPrivate, setIsPrivate] = useState<boolean>(() => {
        try { return localStorage.getItem(PRIVACY_STORAGE_KEY) === '1'; } catch { return false; }
    });

    const togglePrivate = () => {
        setIsPrivate(prev => {
            const next = !prev;
            try { localStorage.setItem(PRIVACY_STORAGE_KEY, next ? '1' : '0'); } catch { /* ignore */ }
            return next;
        });
    };

    const load = async () => {
        if (abortRef.current) abortRef.current.abort();
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        setLoading(true); setErr(null);
        try {
            const params = new URLSearchParams();
            params.set('year', String(viewPeriod.year));
            params.set('month', String(viewPeriod.month));
            // asOfDay del PeriodSelector → corte hasta esa fecha (incluida).
            // Si no hay asOfDay, el endpoint trae todo el mes (incluyendo
            // facturas con fecha futura del mismo mes).
            if (viewPeriod.asOfDay != null) {
                const asOfDate = `${viewPeriod.year}-${String(viewPeriod.month).padStart(2, '0')}-${String(viewPeriod.asOfDay).padStart(2, '0')}`;
                params.set('asOfDate', asOfDate);
            }
            const res = await fetch(`/api/comisiones?${params.toString()}`, {
                headers: authHeaders(), signal: ctrl.signal,
            });
            const j = await res.json();
            if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
            setData(j);
        } catch (e: any) {
            if (e.name === 'AbortError') return;
            setErr(e.message);
        } finally { setLoading(false); }
    };

    useEffect(() => {
        load();
        return () => { if (abortRef.current) abortRef.current.abort(); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [viewPeriod.year, viewPeriod.month, viewPeriod.asOfDay]);

    const monthLabel = viewPeriod.asOfDay != null
        ? `${MONTH_NAMES[viewPeriod.month - 1]} ${viewPeriod.year} · al ${String(viewPeriod.asOfDay).padStart(2, '0')}/${String(viewPeriod.month).padStart(2, '0')}`
        : `${MONTH_NAMES[viewPeriod.month - 1]} ${viewPeriod.year}`;

    // Si vendedor, su única fila. Si admin, ranking + totales.
    const ownItem = !isAdmin && data
        ? data.items.find(v => v.cod_vendedor === userCodVendedor) ?? null
        : null;

    return (
        <div className="cv">
            <header className="cv-head">
                <div className="cv-head-l">
                    <DollarSign size={24} />
                    <h2>Comisiones · {monthLabel}</h2>
                </div>
                <div className="cv-head-actions">
                    <button
                        className="cv-refresh"
                        onClick={togglePrivate}
                        title={isPrivate ? 'Mostrar importes' : 'Ocultar importes (modo privacidad)'}
                        aria-pressed={isPrivate}
                    >
                        {isPrivate ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                    <button className="cv-refresh" onClick={load} disabled={loading} title="Refrescar">
                        {loading ? <Loader2 size={16} className="cv-spin" /> : <RefreshCw size={16} />}
                    </button>
                </div>
            </header>

            {err && <div className="cv-error"><AlertCircle size={16} /> {err}</div>}

            {loading && !data && (
                <div className="cv-loading"><Loader2 size={32} className="cv-spin" /> Calculando comisiones…</div>
            )}

            {data && !isAdmin && ownItem && (
                <SingleVendorPanel item={ownItem} categoriaLabels={data.categoria_labels} hidden={isPrivate} />
            )}

            {data && !isAdmin && !ownItem && (
                <div className="cv-empty">
                    <p>No registramos ventas para tu código de vendedor en {monthLabel}.</p>
                </div>
            )}

            {data && isAdmin && (
                <AdminPanel data={data} hidden={isPrivate} />
            )}
        </div>
    );
};

// ──────────────────────────── Vendedor: vista simple ────────────────────────

interface SingleProps { item: ComisionVendedor; categoriaLabels: Record<Categoria, string>; hidden: boolean }
const SingleVendorPanel = ({ item, categoriaLabels, hidden }: SingleProps) => (
    <>
        <div className="cv-hero">
            <span className="cv-hero-label">Tu comisión acumulada</span>
            <strong className="cv-hero-amount">{fmtMoneyMaybe(item.comision_total, hidden)}</strong>
            <span className="cv-hero-sub">
                Sobre <strong>{fmtMoneyMaybe(item.neto_total, hidden)}</strong> facturado neto · {item.num_comprobantes} comprobantes · {item.num_lineas} líneas
            </span>
        </div>

        <div className="cv-breakdown">
            <h3>Detalle por categoría</h3>
            <table className="cv-table">
                <thead>
                    <tr>
                        <th>Categoría</th>
                        <th className="num">Neto</th>
                        <th className="num">Líneas</th>
                        <th className="num">Comisión</th>
                    </tr>
                </thead>
                <tbody>
                    {CATEGORIA_ORDER.map(cat => {
                        const e = item.breakdown[cat];
                        if (!e || e.lineas === 0) return null;
                        return (
                            <tr key={cat}>
                                <td>{categoriaLabels[cat]}</td>
                                <td className="num">{fmtMoneyMaybe(e.neto, hidden)}</td>
                                <td className="num">{e.lineas}</td>
                                <td className="num cv-strong">{fmtMoneyMaybe(e.comision, hidden)}</td>
                            </tr>
                        );
                    })}
                </tbody>
                <tfoot>
                    <tr>
                        <td>Total</td>
                        <td className="num">{fmtMoneyMaybe(item.neto_total, hidden)}</td>
                        <td className="num">{item.num_lineas}</td>
                        <td className="num cv-strong">{fmtMoneyMaybe(item.comision_total, hidden)}</td>
                    </tr>
                </tfoot>
            </table>
        </div>
    </>
);

// ──────────────────────────── Admin: ranking ────────────────────────────────

interface AdminProps { data: ComisionesResponse; hidden: boolean }
const AdminPanel = ({ data, hidden }: AdminProps) => {
    const [expanded, setExpanded] = useState<number | null>(null);
    return (
        <>
            <div className="cv-hero">
                <span className="cv-hero-label">Total equipo</span>
                <strong className="cv-hero-amount">{fmtMoneyMaybe(data.totales.comision_total, hidden)}</strong>
                <span className="cv-hero-sub">
                    Sobre <strong>{fmtMoneyMaybe(data.totales.neto_total, hidden)}</strong> facturado neto · {data.totales.num_comprobantes} comprobantes
                </span>
            </div>

            {data.items.length === 0 && (
                <div className="cv-empty"><p>Sin ventas registradas para los vendedores visibles en este período.</p></div>
            )}

            {data.items.length > 0 && (
                <div className="cv-ranking">
                    <h3><Trophy size={16} /> Ranking del mes</h3>
                    <table className="cv-table">
                        <thead>
                            <tr>
                                <th>#</th>
                                <th>Vendedor</th>
                                <th className="num">Neto</th>
                                <th className="num">Comprob.</th>
                                <th className="num">Comisión</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.items.map((v, i) => (
                                <Fragment key={v.cod_vendedor}>
                                    <tr className="cv-row" onClick={() => setExpanded(expanded === v.cod_vendedor ? null : v.cod_vendedor)}>
                                        <td className="cv-rank">{i + 1}</td>
                                        <td>{v.nombre}</td>
                                        <td className="num">{fmtMoneyMaybe(v.neto_total, hidden)}</td>
                                        <td className="num">{v.num_comprobantes}</td>
                                        <td className="num cv-strong">{fmtMoneyMaybe(v.comision_total, hidden)}</td>
                                    </tr>
                                    {expanded === v.cod_vendedor && (
                                        <tr className="cv-detail">
                                            <td colSpan={5}>
                                                <div className="cv-detail-grid">
                                                    {CATEGORIA_ORDER.map(cat => {
                                                        const e = v.breakdown[cat];
                                                        if (!e || e.lineas === 0) return null;
                                                        return (
                                                            <div key={cat} className="cv-detail-cat">
                                                                <span className="cv-detail-cat-name">{data.categoria_labels[cat]}</span>
                                                                <span className="cv-detail-cat-neto">Neto {fmtMoneyMaybe(e.neto, hidden)} · {e.lineas} líneas</span>
                                                                <strong className="cv-detail-cat-com">{fmtMoneyMaybe(e.comision, hidden)}</strong>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            </td>
                                        </tr>
                                    )}
                                </Fragment>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </>
    );
};
