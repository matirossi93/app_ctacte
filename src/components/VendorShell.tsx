import { useEffect, useMemo, useState } from 'react';
import {
    Search, Phone, MessageSquare, FileText, Calendar, Receipt,
    Target, Activity as ActivityIcon, ReceiptText, Plus, RefreshCw, Loader2, AlertCircle,
    DollarSign, Truck
} from 'lucide-react';
import { authHeaders, clearToken, getUser } from '../utils/auth';
import { RecibosApp } from './RecibosApp';
import './VendorShell.css';

type Tab = 'cobranzas' | 'objetivos' | 'actividad';

interface Invoice {
    ID: string;
    COD_CLIENT: string;
    CLIENTES_N: string;
    NUMERO: string;
    FECHA: string;
    TOTAL: number;
    IMPORTE_PA: number;
    SALDO: number;
    TIPO_COMPR: string;
    DIAS_EMISI: number;
    COD_VENDED: string;
    VENDEDORES: string;
    COD_EMPRES: string;
}

interface ClientAgg {
    cod: string;
    name: string;
    localidad: string;
    totalSaldo: number;
    maxDias: number;
    invoices: Invoice[];
    lastPayDate: string | null;
}

interface GoalData {
    cod_vendedor: number;
    nombre: string;
    target_neto: number | null;
    avance: number;
    num_comprobantes: number;
    pct_cumplimiento: number | null;
    proyeccion: number;
    necesario_por_dia: number | null;
    dias_habiles_total: number;
    dias_habiles_transcurridos: number;
    dias_restantes: number;
}

interface ClienteObjetivo {
    cod_cliente: number;
    razon_social: string | null;
    localidad: string | null;
    frecuencia: string | null;
    tipo_abc: string | null;
    objetivo_mes: number | null;
    fact_mes_pasado: number | null;
    fact_prom_3m: number | null;
    avance: number;
    num_comprobantes: number;
    pct_cumplimiento: number | null;
    falta: number | null;
    sobrante: number;
    status: 'completado' | 'parcial' | 'sin_compras' | 'sin_objetivo';
}

interface ClientesResponse {
    ok: boolean;
    items: ClienteObjetivo[];
    stats: {
        total_clientes: number;
        con_objetivo: number;
        completados: number;
        parciales: number;
        sin_compras: number;
        sin_objetivo: number;
        total_objetivo: number;
        total_avance: number;
        pct_equipo: number | null;
    };
}

interface ActivityItem {
    id: string;
    cod_cliente: number | null;
    tipo: 'nota' | 'llamada' | 'wa' | 'promesa' | 'pago' | 'visita';
    contenido: string | null;
    monto: number | null;
    fecha_promesa: string | null;
    created_at: string;
}

interface Props {
    onLogout: () => void;
}

export const VendorShell = ({ onLogout }: Props) => {
    const user = getUser();
    const [tab, setTab] = useState<Tab>('cobranzas');
    const [showRecibos, setShowRecibos] = useState(false);
    const [bucket, setBucket] = useState<'todos' | 'ok' | 'warn30' | 'warn60' | 'risk'>('todos');
    const [search, setSearch] = useState('');

    // Data fetching
    const [invoices, setInvoices] = useState<Invoice[]>([]);
    const [clientDbMap, setClientDbMap] = useState<Record<string, any>>({});
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState<string | null>(null);
    const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

    const loadData = async (force = false) => {
        setLoading(true); setErr(null);
        try {
            const qs = force ? '?nocache=1' : '';
            const res = await fetch(`/api/data${qs}`, { headers: authHeaders() });
            if (res.status === 401) { onLogout(); return; }
            const d = await res.json();
            if (d.error) throw new Error(d.error);
            setInvoices(d.invoices || []);
            setClientDbMap(d.clientDbMap || {});
            setLastRefresh(new Date());
        } catch (e: any) { setErr(e.message); }
        finally { setLoading(false); }
    };
    useEffect(() => { loadData(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

    // Agrupar por cliente (solo saldo > 0)
    const clientsAgg = useMemo<ClientAgg[]>(() => {
        const map = new Map<string, ClientAgg>();
        for (const inv of invoices) {
            const cod = inv.COD_CLIENT;
            if (!cod) continue;
            const saldo = Number(inv.SALDO) || 0;
            if (!map.has(cod)) {
                map.set(cod, {
                    cod,
                    name: inv.CLIENTES_N,
                    localidad: clientDbMap[cod]?.Localidad ?? '',
                    totalSaldo: 0,
                    maxDias: 0,
                    invoices: [],
                    lastPayDate: null,
                });
            }
            const c = map.get(cod)!;
            c.totalSaldo += saldo;
            const dias = Number(inv.DIAS_EMISI) || 0;
            if (inv.TIPO_COMPR === 'FA' && dias > c.maxDias) c.maxDias = dias;
            c.invoices.push(inv);
        }
        return Array.from(map.values())
            .filter(c => c.totalSaldo > 1000)
            .sort((a, b) => b.maxDias - a.maxDias);
    }, [invoices, clientDbMap]);

    const buckets = useMemo(() => {
        const b = { ok: 0, warn30: 0, warn60: 0, risk: 0 };
        clientsAgg.forEach(c => {
            if (c.maxDias <= 30) b.ok++;
            else if (c.maxDias <= 60) b.warn30++;
            else if (c.maxDias <= 90) b.warn60++;
            else b.risk++;
        });
        return b;
    }, [clientsAgg]);

    const clientsFiltered = useMemo(() => {
        let list = clientsAgg;
        if (bucket !== 'todos') {
            list = list.filter(c => {
                if (bucket === 'ok') return c.maxDias <= 30;
                if (bucket === 'warn30') return c.maxDias > 30 && c.maxDias <= 60;
                if (bucket === 'warn60') return c.maxDias > 60 && c.maxDias <= 90;
                return c.maxDias > 90;
            });
        }
        if (search.trim()) {
            const q = search.toLowerCase();
            list = list.filter(c => c.name.toLowerCase().includes(q) || c.cod.includes(q) || c.localidad.toLowerCase().includes(q));
        }
        return list;
    }, [clientsAgg, bucket, search]);

    const totalSaldoCartera = clientsAgg.reduce((a, c) => a + c.totalSaldo, 0);

    return (
        <div className="vs-root" data-tab={tab}>
            <div className="vs-backdrop" />

            {/* ═══════════ HEADER ═══════════ */}
            <header className="vs-top">
                <div className="vs-brand">
                    <div className="vs-mark">
                        <svg viewBox="0 0 24 24" fill="none"><path d="M12 2C7 7 5 10 5 14a7 7 0 0 0 14 0c0-4-2-7-7-12Z" fill="currentColor" /><path d="M9 13c1.5-2 2.5-3 3-6M10 17c1-1 2-2 2-3" stroke="#06652F" strokeWidth="1.4" strokeLinecap="round" /></svg>
                    </div>
                    <div className="vs-brand-text">
                        <span className="eyebrow">SEMILLERO</span>
                        <span className="name">Panel Vendedor</span>
                    </div>
                </div>
                <div className="vs-top-actions">
                    <button className="vs-icon-btn" onClick={() => loadData(true)} title="Refrescar" disabled={loading}>
                        {loading ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
                    </button>
                    <button className="vs-avatar" onClick={() => {
                        if (confirm(`¿Cerrar sesión de ${user?.nombre ?? user?.email}?`)) { clearToken(); onLogout(); }
                    }} title="Cerrar sesión">
                        {(user?.nombre ?? user?.email ?? '?').slice(0, 2).toUpperCase()}
                    </button>
                </div>
            </header>

            {/* ═══════════ TAB CONTENT ═══════════ */}
            <main className="vs-main">
                {err && <div className="vs-error"><AlertCircle size={16} /> {err}</div>}

                {tab === 'cobranzas' && (
                    <CobranzasView
                        clients={clientsFiltered}
                        search={search} setSearch={setSearch}
                        bucket={bucket} setBucket={setBucket}
                        buckets={buckets}
                        totalSaldo={totalSaldoCartera}
                        totalClientes={clientsAgg.length}
                        onUploadPago={() => setShowRecibos(true)}
                        lastRefresh={lastRefresh}
                        loading={loading && invoices.length === 0}
                    />
                )}

                {tab === 'objetivos' && <ObjetivosView />}

                {tab === 'actividad' && <ActividadView vendedorKey={user?.vendedor_key ?? null} clientNameMap={clientDbMap} />}
            </main>

            {/* ═══════════ BOTTOM NAV ═══════════ */}
            <nav className="vs-nav" data-tab={tab}>
                <div className="vs-nav-pill" />
                <button className={`vs-nav-btn ${tab === 'cobranzas' ? 'is-active' : ''}`} onClick={() => setTab('cobranzas')}>
                    <ReceiptText size={22} />
                    <span>Cobranzas</span>
                </button>
                <button className={`vs-nav-btn ${tab === 'objetivos' ? 'is-active' : ''}`} onClick={() => setTab('objetivos')}>
                    <Target size={22} />
                    <span>Objetivos</span>
                </button>
                <button className={`vs-nav-btn ${tab === 'actividad' ? 'is-active' : ''}`} onClick={() => setTab('actividad')}>
                    <ActivityIcon size={22} />
                    <span>Actividad</span>
                </button>
            </nav>

            {/* FAB global: cargar pago */}
            <button className="vs-fab" onClick={() => setShowRecibos(true)} title="Cargar pago">
                <Receipt size={22} />
            </button>

            {showRecibos && (
                <RecibosApp onClose={() => setShowRecibos(false)} clients={clientsAgg.map(c => ({ cod: c.cod, name: c.name, localidad: c.localidad }))} />
            )}
        </div>
    );
};

// ═══════════════════════════════════════════════════════════════════════════
// COBRANZAS VIEW
// ═══════════════════════════════════════════════════════════════════════════
function CobranzasView({ clients, search, setSearch, bucket, setBucket, buckets, totalSaldo, totalClientes, onUploadPago, lastRefresh, loading }:
    {
        clients: ClientAgg[]; search: string; setSearch: (s: string) => void;
        bucket: 'todos' | 'ok' | 'warn30' | 'warn60' | 'risk'; setBucket: (b: any) => void;
        buckets: { ok: number; warn30: number; warn60: number; risk: number };
        totalSaldo: number; totalClientes: number;
        onUploadPago: () => void;
        lastRefresh: Date | null;
        loading: boolean;
    }) {
    const [openClient, setOpenClient] = useState<string | null>(null);

    return (
        <div className="vs-view">
            <div className="vs-view-title">
                <h1>Mis <em>Cobranzas</em></h1>
                <p><span className="dot" /> {formatMoney(totalSaldo)} pendientes · {totalClientes} clientes{lastRefresh && ` · ${lastRefresh.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}`}</p>
            </div>

            <div className="vs-search">
                <Search size={16} />
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Cliente, código, localidad…" />
            </div>

            <div className="vs-chips">
                <button className={`vs-chip ${bucket === 'todos' ? 'is-active' : ''}`} onClick={() => setBucket('todos')}>
                    Todos <span className="count">{buckets.ok + buckets.warn30 + buckets.warn60 + buckets.risk}</span>
                </button>
                <button className={`vs-chip ${bucket === 'ok' ? 'is-active' : ''}`} onClick={() => setBucket('ok')}>
                    <span className="dot-b" style={{ background: '#06652F' }} />0-30d <span className="count">{buckets.ok}</span>
                </button>
                <button className={`vs-chip ${bucket === 'warn30' ? 'is-active' : ''}`} onClick={() => setBucket('warn30')}>
                    <span className="dot-b" style={{ background: '#EEC045' }} />30-60d <span className="count">{buckets.warn30}</span>
                </button>
                <button className={`vs-chip ${bucket === 'warn60' ? 'is-active' : ''}`} onClick={() => setBucket('warn60')}>
                    <span className="dot-b" style={{ background: '#D18A3C' }} />60-90d <span className="count">{buckets.warn60}</span>
                </button>
                <button className={`vs-chip ${bucket === 'risk' ? 'is-active' : ''}`} onClick={() => setBucket('risk')}>
                    <span className="dot-b" style={{ background: '#A83E2B' }} />+90d <span className="count">{buckets.risk}</span>
                </button>
            </div>

            {loading && <div className="vs-loading"><Loader2 className="spin" /> Cargando facturas…</div>}

            {!loading && clients.length === 0 && (
                <div className="vs-empty">
                    <ReceiptText size={32} />
                    <p>No hay clientes con saldo en este filtro.</p>
                </div>
            )}

            <div className="vs-clients">
                {clients.map(c => (
                    <ClientCard key={c.cod} client={c}
                        isOpen={openClient === c.cod}
                        onToggle={() => setOpenClient(p => p === c.cod ? null : c.cod)}
                        onUploadPago={onUploadPago} />
                ))}
            </div>
        </div>
    );
}

function ClientCard({ client, isOpen, onToggle, onUploadPago }: { client: ClientAgg; isOpen: boolean; onToggle: () => void; onUploadPago: () => void }) {
    const bucket = client.maxDias <= 30 ? 'ok' : client.maxDias <= 60 ? 'warn30' : client.maxDias <= 90 ? 'warn60' : 'risk';
    const bucketLabel = bucket === 'ok' ? `${client.maxDias}d` : bucket === 'warn30' ? `${client.maxDias}d` : bucket === 'warn60' ? `${client.maxDias}d` : `+${client.maxDias}d`;
    const phoneHref = `tel:`; // a futuro: obtener teléfono de InfoManager client detail
    const waHref = `https://wa.me/`;

    return (
        <div className={`vs-client ${isOpen ? 'is-open' : ''}`}>
            <div className="vs-client-head" onClick={onToggle}>
                <div className={`vs-client-strip bucket-${bucket}`} />
                <div className="vs-client-info">
                    <div className="vs-client-row1">
                        <div>
                            <h3>{client.name}</h3>
                            <div className="vs-client-meta">
                                <span>{client.localidad || 'Sin localidad'}</span>
                                <span className="sep" />
                                <span>Cod {client.cod}</span>
                            </div>
                        </div>
                        <div className="vs-client-saldo">{formatMoney(client.totalSaldo)}</div>
                    </div>
                    <div className="vs-client-row2">
                        <span className={`vs-bucket-pill bucket-${bucket}`}>
                            <span className="dot-b" />{bucketLabel}
                        </span>
                        <span className="vs-client-docs">{client.invoices.length} comprob.</span>
                    </div>
                </div>
            </div>

            <div className="vs-quick-actions">
                <a className="vs-qa call" href={phoneHref} onClick={e => e.stopPropagation()}>
                    <Phone size={18} /><span>Llamar</span>
                </a>
                <a className="vs-qa wa" href={waHref} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>
                    <MessageSquare size={18} /><span>WhatsApp</span>
                </a>
                <button className="vs-qa note" onClick={e => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('vs-open-activity', { detail: { cod_cliente: client.cod, name: client.name } })); }}>
                    <FileText size={18} /><span>Nota</span>
                </button>
                <button className="vs-qa pay" onClick={e => { e.stopPropagation(); onUploadPago(); }}>
                    <Receipt size={18} /><span>Pago</span>
                </button>
            </div>

            {isOpen && (
                <div className="vs-timeline">
                    <h4>Facturas pendientes</h4>
                    {client.invoices.slice(0, 12).map(inv => (
                        <div key={inv.ID} className="vs-tl-item">
                            <div className="vs-tl-icon">
                                <FileText size={14} />
                            </div>
                            <div className="vs-tl-body">
                                <div className="vs-tl-head">
                                    <span className="vs-tl-kind">{inv.TIPO_COMPR} {inv.NUMERO}</span>
                                    <span className="vs-tl-amount">{formatMoney(inv.SALDO)}</span>
                                </div>
                                <div className="vs-tl-meta">{inv.FECHA} · Emisión hace {inv.DIAS_EMISI}d</div>
                            </div>
                        </div>
                    ))}
                    {client.invoices.length > 12 && (
                        <div className="vs-tl-more">+ {client.invoices.length - 12} comprobantes más</div>
                    )}
                </div>
            )}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// OBJETIVOS VIEW
// ═══════════════════════════════════════════════════════════════════════════
function ObjetivosView() {
    const [g, setG] = useState<GoalData | null>(null);
    const [clientes, setClientes] = useState<ClienteObjetivo[]>([]);
    const [clientesStats, setClientesStats] = useState<ClientesResponse['stats'] | null>(null);
    const [filter, setFilter] = useState<'todos' | 'bajo_objetivo' | 'completado' | 'sin_compras' | 'sin_objetivo'>('todos');
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState<string | null>(null);
    const [syncing, setSyncing] = useState(false);

    const load = async () => {
        setLoading(true); setErr(null);
        try {
            const [gr, cr] = await Promise.all([
                fetch('/api/goals', { headers: authHeaders() }).then(r => r.json()),
                fetch(`/api/goals/clientes?filter=${filter}`, { headers: authHeaders() }).then(r => r.json()),
            ]);
            if (!gr.ok) throw new Error(gr.error);
            if (!cr.ok) throw new Error(cr.error);
            setG(gr.items?.[0] ?? null);
            setClientes(cr.items || []);
            setClientesStats(cr.stats);
        } catch (e: any) { setErr(e.message); }
        finally { setLoading(false); }
    };
    useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filter]);

    const syncNow = async () => {
        setSyncing(true);
        try {
            await fetch('/api/goals/sync-now', { method: 'POST', headers: authHeaders() });
            await load();
        } finally { setSyncing(false); }
    };

    if (loading) return <div className="vs-loading"><Loader2 className="spin" /> Cargando objetivo…</div>;
    if (err) return <div className="vs-error"><AlertCircle size={16} /> {err}</div>;
    if (!g) return (
        <div className="vs-view">
            <div className="vs-empty">
                <Target size={32} />
                <p>Aún no tenés objetivo para este mes.</p>
                <p className="vs-empty-hint">Pedile a Matías o Manolo que te asigne un target.</p>
            </div>
        </div>
    );

    const pct = g.pct_cumplimiento ?? 0;
    const pctPct = Math.min(200, pct * 100);
    const circumference = 2 * Math.PI * 54;
    const offset = circumference * (1 - Math.min(1, pct));

    return (
        <div className="vs-view">
            <div className="vs-view-title">
                <h1>Mis <em>Objetivos</em></h1>
                <p><span className="dot" /> {monthName(new Date().getUTCMonth() + 1)} · {g.dias_habiles_transcurridos}/{g.dias_habiles_total} días · {g.dias_restantes} restantes</p>
            </div>

            <div className="vs-hero-goal">
                <div className="vs-hero-goal-head">
                    <div>
                        <span className="eyebrow">OBJETIVO DEL MES</span>
                        <h2>{g.nombre}</h2>
                    </div>
                    <div className="vs-goal-badge">{g.dias_restantes}d restantes</div>
                </div>

                <div className="vs-goal-main">
                    <div className="vs-goal-ring">
                        <svg viewBox="0 0 120 120">
                            <circle className="track" cx="60" cy="60" r="54" />
                            <circle className="fill" cx="60" cy="60" r="54"
                                style={{ strokeDasharray: circumference, strokeDashoffset: offset }} />
                        </svg>
                        <div className="vs-goal-ring-center">
                            <div className="pct">{Math.round(pctPct)}<span>%</span></div>
                            <div className="sub">cumplimiento</div>
                        </div>
                    </div>
                    <div className="vs-goal-figs">
                        <div><span className="k">Target</span><span className="v">{formatMoney(g.target_neto)}</span></div>
                        <div><span className="k">Avance</span><span className="v gold">{formatMoney(g.avance)}</span></div>
                        <div><span className="k">Proyección</span><span className="v">{formatMoney(g.proyeccion)}</span></div>
                    </div>
                </div>

                <div className="vs-goal-daily">
                    <div className="k-box">
                        <span className="k">Necesario por día</span>
                        <strong>{formatMoney(g.necesario_por_dia)}</strong>
                    </div>
                    <div className="note">
                        {g.num_comprobantes} comprobantes este mes.
                    </div>
                </div>

                <button className="vs-goal-refresh" onClick={syncNow} disabled={syncing}>
                    {syncing ? <><Loader2 size={12} className="spin" /> Sincronizando…</> : <><RefreshCw size={12} /> Actualizar avance</>}
                </button>
            </div>

            {/* ─── Objetivos por cliente ─── */}
            <div className="vs-clientes-obj">
                <div className="vs-clientes-obj-head">
                    <h2>Objetivo por cliente</h2>
                    {clientesStats && (
                        <p>
                            {clientesStats.completados}/{clientesStats.con_objetivo} completados ·
                            {' '}{formatMoney(clientesStats.total_avance)} de {formatMoney(clientesStats.total_objetivo)}
                        </p>
                    )}
                </div>

                <div className="vs-chips">
                    <button className={`vs-chip ${filter === 'todos' ? 'is-active' : ''}`} onClick={() => setFilter('todos')}>
                        Todos {clientesStats && <span className="count">{clientesStats.total_clientes}</span>}
                    </button>
                    <button className={`vs-chip ${filter === 'bajo_objetivo' ? 'is-active' : ''}`} onClick={() => setFilter('bajo_objetivo')}>
                        <span className="dot-b" style={{ background: '#EEC045' }} />Bajo objetivo
                        {clientesStats && <span className="count">{clientesStats.parciales}</span>}
                    </button>
                    <button className={`vs-chip ${filter === 'completado' ? 'is-active' : ''}`} onClick={() => setFilter('completado')}>
                        <span className="dot-b" style={{ background: '#06652F' }} />Completados
                        {clientesStats && <span className="count">{clientesStats.completados}</span>}
                    </button>
                    <button className={`vs-chip ${filter === 'sin_compras' ? 'is-active' : ''}`} onClick={() => setFilter('sin_compras')}>
                        <span className="dot-b" style={{ background: '#A83E2B' }} />Sin compras
                        {clientesStats && <span className="count">{clientesStats.sin_compras}</span>}
                    </button>
                </div>

                {clientes.length === 0 && (
                    <div className="vs-empty" style={{ padding: '24px 16px' }}>
                        <Target size={28} />
                        <p>Sin clientes en este filtro.</p>
                    </div>
                )}

                <div className="vs-clientes-obj-list">
                    {clientes.map(c => <ClienteObjetivoCard key={c.cod_cliente} c={c} />)}
                </div>
            </div>
        </div>
    );
}

function ClienteObjetivoCard({ c }: { c: ClienteObjetivo }) {
    const pct = c.pct_cumplimiento ?? 0;
    const barPct = Math.min(100, pct * 100);
    const statusCfg = {
        completado: { label: 'Completado', color: '#06652F' },
        parcial: { label: 'En curso', color: '#EEC045' },
        sin_compras: { label: 'Sin compras', color: '#A83E2B' },
        sin_objetivo: { label: 'Sin objetivo', color: '#6B7280' },
    }[c.status];

    return (
        <div className="vs-cliente-obj">
            <div className="vs-cliente-obj-head">
                <div>
                    <h3>{c.razon_social || `Cliente #${c.cod_cliente}`}</h3>
                    <div className="vs-cliente-obj-meta">
                        <span>{c.localidad || 'Sin localidad'}</span>
                        {c.tipo_abc && <><span className="sep" /><span>ABC {c.tipo_abc}</span></>}
                        {c.frecuencia && <><span className="sep" /><span>{c.frecuencia}</span></>}
                    </div>
                </div>
                <span className="vs-cliente-obj-status" style={{ background: statusCfg.color + '22', color: statusCfg.color }}>
                    {statusCfg.label}
                </span>
            </div>

            {c.objetivo_mes != null && (
                <>
                    <div className="vs-cliente-obj-bar">
                        <div className="vs-cliente-obj-bar-fill" style={{ width: `${barPct}%`, background: statusCfg.color }} />
                    </div>
                    <div className="vs-cliente-obj-figs">
                        <div><span className="k">Objetivo</span><span className="v">{formatMoney(c.objetivo_mes)}</span></div>
                        <div><span className="k">Avance</span><span className="v gold">{formatMoney(c.avance)}</span></div>
                        <div>
                            <span className="k">{c.status === 'completado' ? 'Sobrante' : 'Falta'}</span>
                            <span className="v">{formatMoney(c.status === 'completado' ? c.sobrante : c.falta)}</span>
                        </div>
                    </div>
                </>
            )}

            {c.objetivo_mes == null && (
                <div className="vs-cliente-obj-no-target">
                    Avance: <strong>{formatMoney(c.avance)}</strong> ({c.num_comprobantes} comprob.)
                </div>
            )}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTIVIDAD VIEW
// ═══════════════════════════════════════════════════════════════════════════
function ActividadView({ vendedorKey: _vendedorKey, clientNameMap }: { vendedorKey: string | null; clientNameMap: Record<string, any> }) {
    const [items, setItems] = useState<ActivityItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState<string | null>(null);
    const [showNew, setShowNew] = useState<{ cod_cliente?: string; name?: string } | null>(null);

    const load = async () => {
        setLoading(true); setErr(null);
        try {
            const res = await fetch('/api/activity', { headers: authHeaders() });
            const j = await res.json();
            if (!res.ok || !j.ok) throw new Error(j.error);
            setItems(j.items || []);
        } catch (e: any) { setErr(e.message); }
        finally { setLoading(false); }
    };
    useEffect(() => { load(); }, []);

    useEffect(() => {
        const h = (e: Event) => {
            const d = (e as CustomEvent).detail;
            setShowNew({ cod_cliente: d?.cod_cliente, name: d?.name });
        };
        window.addEventListener('vs-open-activity', h);
        return () => window.removeEventListener('vs-open-activity', h);
    }, []);

    const byDay = useMemo(() => {
        const map = new Map<string, ActivityItem[]>();
        items.forEach(it => {
            const d = new Date(it.created_at).toISOString().slice(0, 10);
            if (!map.has(d)) map.set(d, []);
            map.get(d)!.push(it);
        });
        return Array.from(map.entries()).sort((a, b) => b[0].localeCompare(a[0]));
    }, [items]);

    return (
        <div className="vs-view">
            <div className="vs-view-title">
                <h1>Tu <em>Actividad</em></h1>
                <p><span className="dot" /> {items.length} eventos</p>
            </div>

            {loading && <div className="vs-loading"><Loader2 className="spin" /> Cargando…</div>}
            {err && <div className="vs-error"><AlertCircle size={16} /> {err}</div>}

            {!loading && items.length === 0 && (
                <div className="vs-empty">
                    <ActivityIcon size={32} />
                    <p>Sin actividad registrada todavía.</p>
                    <button className="vs-empty-cta" onClick={() => setShowNew({})}>
                        <Plus size={14} /> Crear la primera
                    </button>
                </div>
            )}

            {byDay.map(([day, list]) => (
                <div key={day} className="vs-feed-day">
                    <div className="vs-feed-day-head">
                        <span className="when">{formatDay(day)}</span>
                        <span className="bar" />
                    </div>
                    {list.map(it => (
                        <FeedItem key={it.id} item={it} clientName={it.cod_cliente ? clientNameMap[String(it.cod_cliente)]?.['Razon Social'] : null} />
                    ))}
                </div>
            ))}

            {/* FAB secundario específico de Actividad */}
            <button className="vs-fab-act" onClick={() => setShowNew({})}>
                <Plus size={22} />
            </button>

            {showNew && <NewActivityInline
                defaultClientCod={showNew.cod_cliente ?? ''}
                defaultClientName={showNew.name ?? ''}
                onClose={() => setShowNew(null)}
                onCreated={() => { setShowNew(null); load(); }}
            />}
        </div>
    );
}

function FeedItem({ item, clientName }: { item: ActivityItem; clientName: string | null }) {
    const iconProps: Record<ActivityItem['tipo'], { Icon: any; color: string; label: string }> = {
        nota: { Icon: FileText, color: 'ochre', label: 'Nota' },
        llamada: { Icon: Phone, color: 'green', label: 'Llamada' },
        wa: { Icon: MessageSquare, color: 'wa', label: 'WhatsApp' },
        promesa: { Icon: Calendar, color: 'rust', label: 'Promesa' },
        pago: { Icon: DollarSign, color: 'forest', label: 'Pago' },
        visita: { Icon: Truck, color: 'ochre', label: 'Visita' },
    };
    const { Icon, color, label } = iconProps[item.tipo];
    return (
        <div className="vs-feed-item">
            <div className={`vs-feed-icon ${color}`}><Icon size={17} /></div>
            <div className="vs-feed-body">
                <div className="vs-feed-row1">
                    <span className="kind">{label}</span>
                    <span className="time">{formatTime(item.created_at)}</span>
                </div>
                <div className="vs-feed-client">{clientName ?? (item.cod_cliente ? `Cliente #${item.cod_cliente}` : 'General')}</div>
                {item.monto != null && (
                    <div className={`vs-feed-amount ${item.tipo === 'promesa' ? 'promise' : ''}`}>
                        {item.tipo === 'pago' ? '+ ' : ''}{formatMoney(item.monto)}
                        {item.fecha_promesa && <span> · {item.fecha_promesa}</span>}
                    </div>
                )}
                {item.contenido && <div className="vs-feed-text">{item.contenido}</div>}
            </div>
        </div>
    );
}

function NewActivityInline({ defaultClientCod, defaultClientName, onClose, onCreated }:
    { defaultClientCod: string; defaultClientName: string; onClose: () => void; onCreated: () => void }) {
    const [tipo, setTipo] = useState<ActivityItem['tipo']>('nota');
    const [contenido, setContenido] = useState('');
    const [monto, setMonto] = useState('');
    const [fechaPromesa, setFechaPromesa] = useState('');
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    const submit = async () => {
        setSaving(true); setErr(null);
        try {
            const body: any = { tipo, cod_cliente: defaultClientCod || null, contenido: contenido || null, monto: monto ? Number(monto) : null, fecha_promesa: fechaPromesa || null };
            const res = await fetch('/api/activity', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body) });
            const j = await res.json();
            if (!res.ok || !j.ok) throw new Error(j.error);
            onCreated();
        } catch (e: any) { setErr(e.message); }
        finally { setSaving(false); }
    };

    const tipos: Array<{ v: ActivityItem['tipo']; label: string; emoji: string }> = [
        { v: 'nota', label: 'Nota', emoji: '📝' },
        { v: 'llamada', label: 'Llamada', emoji: '📞' },
        { v: 'wa', label: 'WhatsApp', emoji: '💬' },
        { v: 'promesa', label: 'Promesa', emoji: '📅' },
        { v: 'pago', label: 'Pago', emoji: '💰' },
        { v: 'visita', label: 'Visita', emoji: '🚚' },
    ];

    return (
        <div className="vs-newact-backdrop" onClick={onClose}>
            <div className="vs-newact" onClick={e => e.stopPropagation()}>
                <header>
                    <h3>Nueva actividad</h3>
                    <button onClick={onClose}><span aria-hidden>×</span></button>
                </header>
                {defaultClientName && <div className="vs-newact-cliente">Cliente: <strong>{defaultClientName}</strong></div>}

                <div className="vs-newact-tipos">
                    {tipos.map(t => (
                        <button key={t.v} className={`vs-newact-tipo ${tipo === t.v ? 'is-active' : ''}`} onClick={() => setTipo(t.v)}>
                            <span>{t.emoji}</span><span className="lbl">{t.label}</span>
                        </button>
                    ))}
                </div>

                <textarea rows={3} value={contenido} onChange={e => setContenido(e.target.value)}
                    placeholder={tipo === 'promesa' ? 'Ej: promete mitad viernes...' : 'Detalle de la actividad'} />

                {(tipo === 'pago' || tipo === 'promesa') && (
                    <div className="vs-newact-row">
                        <input type="number" step="0.01" value={monto} onChange={e => setMonto(e.target.value)} placeholder="Monto" />
                        {tipo === 'promesa' && <input type="date" value={fechaPromesa} onChange={e => setFechaPromesa(e.target.value)} />}
                    </div>
                )}

                {err && <div className="vs-error"><AlertCircle size={14} /> {err}</div>}

                <div className="vs-newact-actions">
                    <button className="vs-btn-sec" onClick={onClose} disabled={saving}>Cancelar</button>
                    <button className="vs-btn-primary" onClick={submit} disabled={saving}>
                        {saving ? <><Loader2 size={14} className="spin" /> Guardando…</> : 'Guardar'}
                    </button>
                </div>
            </div>
        </div>
    );
}

// ─── helpers ────────────────────────────────────────────────────────────────
function formatMoney(n: number | null | undefined): string {
    if (n == null) return '—';
    return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n);
}
function formatDay(iso: string): string {
    const d = new Date(iso + 'T00:00:00');
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = Math.floor((today.getTime() - d.getTime()) / 86400000);
    if (diff === 0) return 'Hoy';
    if (diff === 1) return 'Ayer';
    if (diff < 7) return `Hace ${diff} días`;
    return d.toLocaleDateString('es-AR', { weekday: 'short', day: '2-digit', month: 'short' });
}
function formatTime(iso: string): string {
    const d = new Date(iso);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short' });
}
function monthName(m: number): string {
    return ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'][m - 1];
}
