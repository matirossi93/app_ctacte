import { useEffect, useRef, useState } from 'react';
import { PackageX, Loader2, AlertCircle, RefreshCw, DownloadCloud } from 'lucide-react';
import { authHeaders } from '../utils/auth';
import type { ViewPeriod } from './PeriodSelector';
import './RebotesView.css';

const MONTH_NAMES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

// Espejo de MotivoRebote en server-lib/rebotesParser.ts.
// grupo: quién causó el rebote — define el color del badge y el orden de los chips.
//   vendedor → fase 2 le descuenta 3% de comisión (M.C. VENDEDOR)
//   cliente  → fase 3 le recarga 3% si rebotó el pedido completo
const MOTIVO_META: Record<string, { label: string; grupo: 'vendedor' | 'cliente' | 'empresa' | 'otro' }> = {
    mc_vendedor: { label: 'M.C. Vendedor', grupo: 'vendedor' },
    devolucion: { label: 'Devolución', grupo: 'cliente' },
    sin_dinero: { label: 'Sin dinero', grupo: 'cliente' },
    cerrado: { label: 'Cerrado', grupo: 'cliente' },
    mc_deposito: { label: 'M.C. Depósito', grupo: 'empresa' },
    falto: { label: 'Faltó', grupo: 'empresa' },
    sin_stock: { label: 'Sin stock', grupo: 'empresa' },
    error_adm: { label: 'Error adm.', grupo: 'empresa' },
    logistica: { label: 'Logística', grupo: 'empresa' },
    error_sistema: { label: 'Error sistema', grupo: 'empresa' },
    sin_clasificar: { label: 'Sin clasificar', grupo: 'otro' },
};
const MOTIVO_ORDER = Object.keys(MOTIVO_META);

interface RebotesRow {
    fila: number;
    fecha: string | null;
    cliente_raw: string;
    cod_cliente: number | null;
    vendedor_raw: string | null;
    cod_vendedor: number | null;
    cod_articulo: number | null;
    articulo: string | null;
    motivo: string;
    motivo_raw: string | null;
    cantidad: number | null;
    total: number | null;
}

interface RebotesResponse {
    ok: boolean;
    year: number;
    month: number;
    rows: RebotesRow[];
    resumen: {
        filas: number;
        total: number;
        por_motivo: Record<string, { filas: number; total: number }>;
        sin_clasificar: number;
        clientes_sin_match: number;
        ultima_sync: string | null;
    };
}

interface EventoRecargo {
    cod_cliente: number | null;
    cliente_raw: string;
    cod_vendedor: number | null;
    vendedor_raw: string | null;
    fecha: string;
    motivos: string[];
    total_rebotado: number;
    renglones: number;
    match: {
        estado: 'completo' | 'parcial' | 'sin_factura' | 'revisar';
        id_comprobante: number | null;
        total_factura: number | null;
        ratio: number | null;
    };
    recargo: number | null;
    reincidencia: number;
}

interface RecargosResponse {
    ok: boolean;
    rige: boolean;
    eventos: EventoRecargo[];
    resumen: {
        eventos: number;
        completos: number;
        recargo_total: number;
        parciales: number;
        sin_factura: number;
        revisar: number;
    };
}

const ESTADO_META: Record<EventoRecargo['match']['estado'], { label: string; hint: string }> = {
    completo: { label: 'Pedido completo', hint: 'Lo rebotado coincide con una factura: corresponde recargo 3%' },
    parcial: { label: 'Parcial', hint: 'Devolvió una parte del pedido: sin recargo' },
    sin_factura: { label: 'Sin factura', hint: 'No encontré factura para cruzar: revisar a mano' },
    revisar: { label: 'Revisar', hint: 'Lo rebotado supera la factura más cercana: revisar a mano' },
};

interface Props {
    isAdmin: boolean;
    viewPeriod: ViewPeriod;
    userCodVendedor: number | null;
}

const fmtMoney = (n: number) =>
    new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n);

const fmtFecha = (iso: string | null) => {
    if (!iso) return '—';
    const [, m, d] = iso.split('-');
    return `${d}/${m}`;
};

export const RebotesView = ({ isAdmin, viewPeriod }: Props) => {
    const [data, setData] = useState<RebotesResponse | null>(null);
    const [recargos, setRecargos] = useState<RecargosResponse | null>(null);
    const [loading, setLoading] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const [filtroMotivo, setFiltroMotivo] = useState<string | null>(null);
    const [filtroVendedor, setFiltroVendedor] = useState<number | null>(null);
    const abortRef = useRef<AbortController | null>(null);

    const load = async () => {
        if (abortRef.current) abortRef.current.abort();
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        setLoading(true); setErr(null);
        try {
            const params = new URLSearchParams();
            params.set('year', String(viewPeriod.year));
            params.set('month', String(viewPeriod.month));
            const res = await fetch(`/api/rebotes?${params.toString()}`, {
                headers: authHeaders(), signal: ctrl.signal,
            });
            const j = await res.json();
            if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
            setData(j);
            // Recargos al cliente (rige desde julio 2026): best-effort, no
            // bloquea la vista principal si falla el cruce con IM.
            try {
                const res2 = await fetch(`/api/rebotes/recargos?${params.toString()}`, {
                    headers: authHeaders(), signal: ctrl.signal,
                });
                const j2 = await res2.json();
                setRecargos(res2.ok && j2.ok ? j2 : null);
            } catch { setRecargos(null); }
        } catch (e: any) {
            if (e.name === 'AbortError') return;
            setErr(e.message);
        } finally { setLoading(false); }
    };

    useEffect(() => {
        load();
        return () => { if (abortRef.current) abortRef.current.abort(); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [viewPeriod.year, viewPeriod.month]);

    const syncNow = async () => {
        setSyncing(true); setErr(null);
        try {
            const res = await fetch('/api/rebotes/sync-now', { method: 'POST', headers: authHeaders() });
            const j = await res.json();
            if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
            await load();
        } catch (e: any) {
            setErr(`Sync: ${e.message}`);
        } finally { setSyncing(false); }
    };

    const monthLabel = `${MONTH_NAMES[viewPeriod.month - 1]} ${viewPeriod.year}`;
    const rows = data?.rows ?? [];

    // Corte "al día X" del PeriodSelector: filtra client-side (las filas sin
    // fecha se muestran siempre — mejor de más que esconder un rebote).
    const asOfIso = viewPeriod.asOfDay != null
        ? `${viewPeriod.year}-${String(viewPeriod.month).padStart(2, '0')}-${String(viewPeriod.asOfDay).padStart(2, '0')}`
        : null;

    // Vendedores presentes en el mes (chips admin). Sin cod (celda vacía o
    // ex-vendedor tipo DARIO) se agrupan bajo -1 "Sin vendedor".
    const vendedores = new Map<number, string>();
    if (isAdmin) {
        for (const r of rows) {
            const cod = r.cod_vendedor ?? -1;
            if (!vendedores.has(cod)) vendedores.set(cod, r.cod_vendedor == null ? 'Sin vendedor' : (r.vendedor_raw ?? `#${cod}`));
        }
    }

    const visibles = rows.filter(r =>
        (filtroMotivo == null || r.motivo === filtroMotivo)
        && (filtroVendedor == null || (r.cod_vendedor ?? -1) === filtroVendedor)
        && (asOfIso == null || r.fecha == null || r.fecha <= asOfIso),
    );
    const totalVisible = Math.round(visibles.reduce((a, r) => a + (Number(r.total) || 0), 0) * 100) / 100;

    const motivosDelMes = MOTIVO_ORDER.filter(m => (data?.resumen.por_motivo[m]?.filas ?? 0) > 0);

    return (
        <div className="rb-wrap">
            <div className="rb-head">
                <div>
                    <h2 className="rb-title"><PackageX size={20} /> Rebotes de reparto</h2>
                    <div className="rb-sub">{monthLabel}</div>
                </div>
                <div className="rb-head-actions">
                    {isAdmin && (
                        <button className="rb-btn" onClick={syncNow} disabled={syncing} title="Volver a leer el sheet de faltantes ahora">
                            {syncing ? <Loader2 size={16} className="rb-spin" /> : <DownloadCloud size={16} />}
                            <span>Sync</span>
                        </button>
                    )}
                    <button className="rb-btn rb-btn--icon" onClick={load} disabled={loading} title="Refrescar">
                        <RefreshCw size={16} className={loading ? 'rb-spin' : ''} />
                    </button>
                </div>
            </div>

            {err && <div className="rb-error"><AlertCircle size={16} /> {err}</div>}

            {loading && !data && <div className="rb-loading"><Loader2 size={22} className="rb-spin" /> Cargando…</div>}

            {data && (
                <>
                    <div className="rb-hero">
                        <div className="rb-hero-item">
                            <span className="rb-hero-num">{fmtMoney(totalVisible)}</span>
                            <span className="rb-hero-label">{filtroMotivo || filtroVendedor || asOfIso ? 'total filtrado' : 'total del mes'}</span>
                        </div>
                        <div className="rb-hero-item">
                            <span className="rb-hero-num">{visibles.length}</span>
                            <span className="rb-hero-label">renglones</span>
                        </div>
                    </div>

                    {recargos?.rige && recargos.eventos.length > 0 && (
                        <div className="rb-recargos">
                            <div className="rb-recargos-head">
                                <span className="rb-recargos-title">Recargo 3% a clientes</span>
                                {recargos.resumen.completos > 0 && (
                                    <span className="rb-recargos-total">{recargos.resumen.completos} pedido(s) completo(s) · {fmtMoney(recargos.resumen.recargo_total)}</span>
                                )}
                            </div>
                            <p className="rb-recargos-hint">
                                Rebotes por culpa del cliente (devolución / sin dinero / cerrado). Si rebotó el <b>pedido completo</b> corresponde
                                recargo del 3%: avisale y recordáselo antes del próximo reparto.{isAdmin ? ' El recargo se factura a mano en IM.' : ''}
                            </p>
                            <div className="rb-recargos-list">
                                {recargos.eventos.map((e, i) => {
                                    const meta = ESTADO_META[e.match.estado];
                                    return (
                                        <div key={i} className={`rb-ev rb-ev--${e.match.estado}`}>
                                            <div className="rb-ev-top">
                                                <span className="rb-row-fecha">{fmtFecha(e.fecha || null)}</span>
                                                <span className="rb-ev-cliente">
                                                    {e.cliente_raw}
                                                    {e.reincidencia > 1 && <span className="rb-ev-reinc" title="Rebotes de este cliente en el mes">{e.reincidencia}ª vez</span>}
                                                </span>
                                                <span className="rb-ev-estado" title={meta.hint}>{meta.label}</span>
                                            </div>
                                            <div className="rb-ev-bottom">
                                                <span className="rb-ev-det">
                                                    {fmtMoney(e.total_rebotado)} rebotado ({e.renglones} renglones)
                                                    {isAdmin && e.match.total_factura != null && <> · factura {fmtMoney(e.match.total_factura)}{e.match.ratio != null ? ` (${Math.round(e.match.ratio * 100)}%)` : ''}</>}
                                                </span>
                                                {e.recargo != null && <span className="rb-ev-recargo">+{fmtMoney(e.recargo)}</span>}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {isAdmin && (data.resumen.sin_clasificar > 0 || data.resumen.clientes_sin_match > 0) && (
                        <div className="rb-warns">
                            {data.resumen.sin_clasificar > 0 && (
                                <span className="rb-warn">⚠ {data.resumen.sin_clasificar} con motivo sin clasificar</span>
                            )}
                            {data.resumen.clientes_sin_match > 0 && (
                                <span className="rb-warn rb-warn--soft">{data.resumen.clientes_sin_match} cliente(s) sin match con IM</span>
                            )}
                        </div>
                    )}

                    {motivosDelMes.length > 0 && (
                        <div className="rb-chips">
                            {motivosDelMes.map(m => {
                                const meta = MOTIVO_META[m] ?? { label: m, grupo: 'otro' as const };
                                const stat = data.resumen.por_motivo[m];
                                return (
                                    <button
                                        key={m}
                                        className={`rb-chip rb-chip--${meta.grupo} ${filtroMotivo === m ? 'is-active' : ''}`}
                                        onClick={() => setFiltroMotivo(filtroMotivo === m ? null : m)}
                                    >
                                        {meta.label} <b>{stat.filas}</b>
                                    </button>
                                );
                            })}
                        </div>
                    )}

                    {isAdmin && vendedores.size > 1 && (
                        <div className="rb-chips rb-chips--vend">
                            {[...vendedores.entries()].map(([cod, nombre]) => (
                                <button
                                    key={cod}
                                    className={`rb-chip ${filtroVendedor === cod ? 'is-active' : ''}`}
                                    onClick={() => setFiltroVendedor(filtroVendedor === cod ? null : cod)}
                                >
                                    {nombre}
                                </button>
                            ))}
                        </div>
                    )}

                    {visibles.length === 0 ? (
                        <div className="rb-empty">
                            {rows.length === 0
                                ? `Sin rebotes cargados en ${monthLabel}.`
                                : 'Nada que mostrar con estos filtros.'}
                        </div>
                    ) : (
                        <div className="rb-list">
                            {visibles.map(r => {
                                const meta = MOTIVO_META[r.motivo] ?? { label: r.motivo_raw ?? r.motivo, grupo: 'otro' as const };
                                return (
                                    <div key={`${r.fila}`} className="rb-row">
                                        <div className="rb-row-top">
                                            <span className="rb-row-fecha">{fmtFecha(r.fecha)}</span>
                                            <span className="rb-row-cliente">
                                                {r.cliente_raw}
                                                {isAdmin && r.cod_cliente == null && <span className="rb-dot" title="Sin match con maestro IM">●</span>}
                                            </span>
                                            <span className={`rb-badge rb-badge--${meta.grupo}`}>{meta.label}</span>
                                        </div>
                                        <div className="rb-row-bottom">
                                            <span className="rb-row-art">
                                                {r.articulo}
                                                {r.cantidad != null && <em> ×{r.cantidad}</em>}
                                            </span>
                                            <span className="rb-row-total">{r.total != null ? fmtMoney(r.total) : '—'}</span>
                                        </div>
                                        {isAdmin && r.vendedor_raw && vendedores.size > 1 && filtroVendedor == null && (
                                            <div className="rb-row-vend">{r.vendedor_raw}</div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {data.resumen.ultima_sync && (
                        <div className="rb-foot">
                            Última sincronización con el sheet: {new Date(data.resumen.ultima_sync).toLocaleString('es-AR', { timeZone: 'America/Argentina/Tucuman' })}
                        </div>
                    )}
                </>
            )}
        </div>
    );
};
