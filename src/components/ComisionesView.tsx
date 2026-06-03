import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { DollarSign, Loader2, AlertCircle, RefreshCw, Trophy, Eye, EyeOff, Replace, Plus, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import { authHeaders } from '../utils/auth';
import type { ViewPeriod } from './PeriodSelector';
import './ComisionesView.css';

const MONTH_NAMES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const CATEGORIA_ORDER = ['5%', '4%', '3.5%', '1%'] as const;
const PRIVACY_STORAGE_KEY = 'ctacte:comisiones:privacy';
const MASKED = '$ ••••';

// Vendedores comerciales visibles (espejo de COD_VENDEDORES_VISIBLES en
// server-lib/comisionesShared.ts). Si se suma un vendedor allá, agregarlo acá.
const VENDEDORES_OVERRIDE = [
    { cod: 2, nombre: 'Sebastián' },
    { cod: 3, nombre: 'Marcelo' },
    { cod: 4, nombre: 'Julio' },
    { cod: 12, nombre: 'Brian' },
];
const vendorName = (cod: number | null | undefined): string =>
    VENDEDORES_OVERRIDE.find(v => v.cod === cod)?.nombre ?? (cod != null ? `Vend ${cod}` : '—');

interface OverrideItem {
    id_comprobante: number;
    cod_vendedor: number;
    cod_vendedor_original: number | null;
    motivo: string | null;
    created_at: string;
}

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
                <AdminPanel data={data} hidden={isPrivate} onReload={load} />
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

interface AdminProps { data: ComisionesResponse; hidden: boolean; onReload: () => void }
const AdminPanel = ({ data, hidden, onReload }: AdminProps) => {
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

            <OverridesAdmin onReload={onReload} />
        </>
    );
};

// ──────────────────────── Admin: overrides de vendedor ───────────────────────
// Reasigna un comprobante a otro vendedor para comisiones/avance, cuando la
// factura se emitió en IM con el vendedor equivocado y no se puede editar allá.

interface OverridesProps { onReload: () => void }
const OverridesAdmin = ({ onReload }: OverridesProps) => {
    const [open, setOpen] = useState(false);
    const [items, setItems] = useState<OverrideItem[]>([]);
    const [listErr, setListErr] = useState<string | null>(null);
    const [loadingList, setLoadingList] = useState(false);

    // Formulario de alta.
    const [idComp, setIdComp] = useState('');
    const [codVend, setCodVend] = useState<number>(VENDEDORES_OVERRIDE[VENDEDORES_OVERRIDE.length - 1].cod); // default Brian
    const [motivo, setMotivo] = useState('');
    const [saving, setSaving] = useState(false);
    const [formErr, setFormErr] = useState<string | null>(null);

    const [recalc, setRecalc] = useState<string | null>(null);

    const loadList = useCallback(async () => {
        setLoadingList(true); setListErr(null);
        try {
            const res = await fetch('/api/comisiones/overrides', { headers: authHeaders() });
            const j = await res.json();
            if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
            setItems(j.items ?? []);
        } catch (e: any) {
            setListErr(e.message);
        } finally { setLoadingList(false); }
    }, []);

    // Carga la lista la primera vez que se abre la sección.
    useEffect(() => { if (open && items.length === 0 && !listErr) loadList(); }, [open, items.length, listErr, loadList]);

    const save = async () => {
        const id = Number(idComp.trim());
        if (!Number.isInteger(id) || id <= 0) { setFormErr('Ingresá un N° de comprobante válido (el "id" del comprobante en IM).'); return; }
        setSaving(true); setFormErr(null);
        try {
            const res = await fetch('/api/comisiones/overrides', {
                method: 'POST',
                headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ id_comprobante: id, cod_vendedor: codVend, motivo: motivo.trim() || null }),
            });
            const j = await res.json();
            if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
            setIdComp(''); setMotivo('');
            await loadList();
            onReload(); // refresca el ranking de comisiones (el override aplica en vivo)
        } catch (e: any) {
            setFormErr(e.message);
        } finally { setSaving(false); }
    };

    const remove = async (id: number) => {
        setListErr(null);
        try {
            const res = await fetch(`/api/comisiones/overrides/${id}`, { method: 'DELETE', headers: authHeaders() });
            const j = await res.json();
            if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
            await loadList();
            onReload();
        } catch (e: any) {
            setListErr(e.message);
        }
    };

    // Re-agrega vendor_sales_monthly de los meses recientes para que el panel de
    // Objetivos/avance también refleje los overrides (Comisiones ya aplica en vivo).
    const recalcularAvance = async () => {
        setRecalc('Recalculando avance en segundo plano… puede tardar ~30s. Refrescá Objetivos en un momento.');
        try {
            const res = await fetch('/api/goals/backfill', {
                method: 'POST',
                headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ months: 3 }),
            });
            const j = await res.json();
            if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
        } catch (e: any) {
            setRecalc(`No se pudo arrancar el recálculo: ${e.message}`);
        }
    };

    return (
        <section className="cv-ov">
            <button className="cv-ov-toggle" onClick={() => setOpen(o => !o)} aria-expanded={open}>
                <span><Replace size={15} /> Reasignar comprobantes (override de vendedor)</span>
                {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>

            {open && (
                <div className="cv-ov-body">
                    <p className="cv-ov-hint">
                        Cuando una factura se emitió en InfoManager con el vendedor equivocado y no se puede editar,
                        reasignala acá: la venta pasa a contarse para el vendedor correcto en Comisiones y Avance.
                        No toca InfoManager ni la cuenta corriente.
                    </p>

                    <div className="cv-ov-form">
                        <label className="cv-ov-field">
                            <span>N° comprobante (id)</span>
                            <input
                                type="number" inputMode="numeric" placeholder="57546720"
                                value={idComp} onChange={e => setIdComp(e.target.value)}
                            />
                        </label>
                        <label className="cv-ov-field">
                            <span>Asignar a</span>
                            <select value={codVend} onChange={e => setCodVend(Number(e.target.value))}>
                                {VENDEDORES_OVERRIDE.map(v => (
                                    <option key={v.cod} value={v.cod}>{v.nombre} ({v.cod})</option>
                                ))}
                            </select>
                        </label>
                        <label className="cv-ov-field cv-ov-field-wide">
                            <span>Motivo (opcional)</span>
                            <input
                                type="text" placeholder="Ej: cliente de Brian, FA salió con Marcelo"
                                value={motivo} onChange={e => setMotivo(e.target.value)}
                            />
                        </label>
                        <button className="cv-ov-add" onClick={save} disabled={saving}>
                            {saving ? <Loader2 size={15} className="cv-spin" /> : <Plus size={15} />} Guardar
                        </button>
                    </div>
                    {formErr && <div className="cv-error"><AlertCircle size={16} /> {formErr}</div>}

                    {listErr && <div className="cv-error"><AlertCircle size={16} /> {listErr}</div>}
                    {loadingList && <div className="cv-ov-loading"><Loader2 size={16} className="cv-spin" /> Cargando…</div>}

                    {!loadingList && items.length === 0 && !listErr && (
                        <p className="cv-ov-empty">No hay reasignaciones cargadas.</p>
                    )}

                    {items.length > 0 && (
                        <table className="cv-table cv-ov-table">
                            <thead>
                                <tr>
                                    <th>Comprob.</th>
                                    <th>De → A</th>
                                    <th>Motivo</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody>
                                {items.map(o => (
                                    <tr key={o.id_comprobante}>
                                        <td>{o.id_comprobante}</td>
                                        <td>{vendorName(o.cod_vendedor_original)} → <strong className="cv-strong">{vendorName(o.cod_vendedor)}</strong></td>
                                        <td className="cv-ov-motivo">{o.motivo ?? '—'}</td>
                                        <td className="num">
                                            <button className="cv-ov-del" onClick={() => remove(o.id_comprobante)} title="Eliminar reasignación">
                                                <Trash2 size={14} />
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}

                    <div className="cv-ov-recalc">
                        <button className="cv-ov-recalc-btn" onClick={recalcularAvance}>
                            <RefreshCw size={14} /> Recalcular avance (Objetivos)
                        </button>
                        <span className="cv-ov-recalc-hint">
                            Comisiones aplica el cambio al instante. Para que el panel de Objetivos también lo refleje, recalculá.
                        </span>
                    </div>
                    {recalc && <div className="cv-ov-recalc-msg">{recalc}</div>}
                </div>
            )}
        </section>
    );
};
