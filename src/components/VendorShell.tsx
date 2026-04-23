import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
    Search, Phone, MessageSquare, FileText, Calendar, Receipt,
    Target, Activity as ActivityIcon, ReceiptText, Plus, RefreshCw, Loader2, AlertCircle,
    DollarSign, Truck, Edit3, Lock, Users, LogOut, FileSpreadsheet, Settings2
} from 'lucide-react';
import { authHeaders, clearToken, getUser } from '../utils/auth';
import { RecibosApp } from './RecibosApp';
import { CambiarPassword } from './CambiarPassword';
import { UsuariosAdmin } from './UsuariosAdmin';
import { ImportarSheet } from './ImportarSheet';
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

interface GoalsMeta {
    holidays: number[];
    dias_habiles_source: 'manual' | 'con_feriados' | 'auto';
    year: number;
    month: number;
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

interface LocalidadStat {
    localidad: string;
    count: number;
    total_objetivo: number;
    total_avance: number;
    completados: number;
}

interface Seleccion {
    localidad: string | null;
    total_clientes: number;
    con_objetivo: number;
    total_objetivo: number;
    total_avance: number;
    num_comprobantes: number;
    pct: number | null;
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
        localidades: LocalidadStat[];
    };
    seleccion: Seleccion;
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
    const isAdmin = user?.rol === 'admin' || user?.rol === 'gerente';
    const [tab, setTab] = useState<Tab>('cobranzas');
    const [showRecibos, setShowRecibos] = useState(false);
    const [bucket, setBucket] = useState<'todos' | 'ok' | 'warn30' | 'warn60' | 'risk'>('todos');
    const [search, setSearch] = useState('');
    // Pendiente de crear actividad (disparado desde CobranzasView)
    const [pendingNewActivity, setPendingNewActivity] = useState<{ cod_cliente?: string; name?: string } | null>(null);

    // Menu del avatar
    const [avatarMenu, setAvatarMenu] = useState(false);
    const [showCambiarPass, setShowCambiarPass] = useState(false);
    const [showUsuariosAdmin, setShowUsuariosAdmin] = useState(false);
    const [showImportSheet, setShowImportSheet] = useState(false);
    const [reloadObjetivosTick, setReloadObjetivosTick] = useState(0);

    // Listener global para 'vs-open-activity' — switchea al tab Actividad y pasa el cliente.
    useEffect(() => {
        const h = (e: Event) => {
            const d = (e as CustomEvent).detail;
            setTab('actividad');
            setPendingNewActivity({ cod_cliente: d?.cod_cliente, name: d?.name });
        };
        window.addEventListener('vs-open-activity', h);
        return () => window.removeEventListener('vs-open-activity', h);
    }, []);

    // Vendedor activo: vendedor usa el propio; admin elige (null = Todos)
    const [selectedVendor, setSelectedVendor] = useState<number | null>(
        user?.rol === 'vendedor' ? (user?.cod_vendedor ?? null) : null
    );
    const [vendedores, setVendedores] = useState<Array<{ cod_vendedor: number; nombre: string; activo: boolean }>>([]);
    const [showInactivos, setShowInactivos] = useState(false);

    // Vendedores que cuentan en la vista "Todos los vendedores" (admin-only).
    // Persiste en localStorage. Primera vez se siembra con todos los activos que trae /api/goals.
    const [visibleCods, setVisibleCods] = useState<Set<number>>(() => {
        const saved = localStorage.getItem('vendedoresVisibles');
        if (saved) {
            try { return new Set(JSON.parse(saved) as number[]); } catch { /* ignore */ }
        }
        return new Set();
    });
    const [visiblesSeeded, setVisiblesSeeded] = useState(() => localStorage.getItem('vendedoresVisibles') !== null);
    const [vendoresMenuOpen, setVendoresMenuOpen] = useState(false);

    useEffect(() => {
        if (visiblesSeeded) {
            localStorage.setItem('vendedoresVisibles', JSON.stringify([...visibleCods]));
        }
    }, [visibleCods, visiblesSeeded]);

    // Data fetching
    const [invoices, setInvoices] = useState<Invoice[]>([]);
    const [clientDbMap, setClientDbMap] = useState<Record<string, any>>({});
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState<string | null>(null);
    const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

    // Filtro multi en vista "Todos": siempre se aplica cuando hay seed, así Andrea/etc.
    // quedan fuera por default aunque no aparezcan en la lista de /api/goals.
    // El admin amplía tildando más en el popover si quiere verlos.
    const customCodsActive = isAdmin && selectedVendor == null && visiblesSeeded && visibleCods.size > 0;
    const codsQs = customCodsActive ? [...visibleCods].join(',') : '';
    // Mostrar conteo solo cuando tiene sentido (hay lista cargada y el filtro achica)
    const showCustomBadge = customCodsActive && vendedores.length > 0 && visibleCods.size < vendedores.length;

    const loadData = async (force = false) => {
        setLoading(true); setErr(null);
        try {
            const params = new URLSearchParams();
            if (force) params.set('nocache', '1');
            if (selectedVendor != null && isAdmin) params.set('cod_vendedor', String(selectedVendor));
            else if (codsQs) params.set('cods', codsQs);
            const qs = params.toString() ? `?${params.toString()}` : '';
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
    useEffect(() => { loadData(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [selectedVendor, codsQs]);

    // Admin: traer lista de vendedores desde /api/goals (filtrada por activo según toggle)
    useEffect(() => {
        if (!isAdmin) return;
        const qs = showInactivos ? '?incluir_inactivos=true' : '';
        fetch(`/api/goals${qs}`, { headers: authHeaders() })
            .then(r => r.json())
            .then(j => {
                if (j.ok && Array.isArray(j.items)) {
                    const list = j.items.map((i: any) => ({ cod_vendedor: i.cod_vendedor, nombre: i.nombre, activo: i.activo !== false }));
                    setVendedores(list);
                    // Primera vez (sin localStorage): sembrar con todos los activos.
                    if (!visiblesSeeded) {
                        setVisibleCods(new Set(list.filter((v: any) => v.activo).map((v: any) => v.cod_vendedor)));
                        setVisiblesSeeded(true);
                    }
                }
            })
            .catch(() => { });
    }, [isAdmin, showInactivos, visiblesSeeded]);

    // Agrupar por cliente (solo saldo > 0)
    // Umbral $2000 para ignorar facturas con saldo despreciable (ajustes contables,
    // redondeos, anuladas parciales). Estas ensucian el maxDias antiguedad si no se filtran.
    const UMBRAL_SALDO_FACTURA = 2000;
    const clientsAgg = useMemo<ClientAgg[]>(() => {
        const map = new Map<string, ClientAgg>();
        for (const inv of invoices) {
            const cod = inv.COD_CLIENT;
            if (!cod) continue;
            const saldo = Number(inv.SALDO) || 0;
            // Facturas con saldo practicamente 0 no suman al total ni a la antiguedad.
            if (Math.abs(saldo) <= UMBRAL_SALDO_FACTURA) continue;
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
                        <span className="name">
                            {isAdmin && vendedores.length > 0 ? (
                                <>
                                    <select className="vs-vendor-select"
                                        value={selectedVendor ?? ''}
                                        onChange={e => setSelectedVendor(e.target.value ? Number(e.target.value) : null)}>
                                        <option value="">
                                            {showCustomBadge
                                                ? `Todos los vendedores (${visibleCods.size} de ${vendedores.length})`
                                                : 'Todos los vendedores'}
                                        </option>
                                        {vendedores.map(v => (
                                            <option key={v.cod_vendedor} value={v.cod_vendedor}>
                                                {v.nombre}{!v.activo && ' (inactivo)'}
                                            </option>
                                        ))}
                                    </select>
                                    <div className="vs-vendor-gear-wrap">
                                        <button className="vs-vendor-gear"
                                            onClick={() => setVendoresMenuOpen(v => !v)}
                                            title="Configurar vendedores visibles en 'Todos'"
                                            aria-label="Configurar vendedores visibles">
                                            <Settings2 size={14} />
                                        </button>
                                        {vendoresMenuOpen && (
                                            <>
                                                <div className="vs-avatar-scrim" onClick={() => setVendoresMenuOpen(false)} />
                                                <div className="vs-vendores-menu" role="menu">
                                                    <div className="vs-vendores-menu-header">
                                                        <strong>Incluir en "Todos los vendedores"</strong>
                                                        <div className="vs-vendores-menu-quick">
                                                            <button type="button" onClick={() => setVisibleCods(new Set(vendedores.map(v => v.cod_vendedor)))}>Todos</button>
                                                            <button type="button" onClick={() => setVisibleCods(new Set(vendedores.filter(v => v.activo).map(v => v.cod_vendedor)))}>Solo activos</button>
                                                            <button type="button" onClick={() => setVisibleCods(new Set())}>Ninguno</button>
                                                        </div>
                                                    </div>
                                                    <div className="vs-vendores-menu-list">
                                                        {vendedores.map(v => (
                                                            <label key={v.cod_vendedor} className="vs-vendor-check">
                                                                <input type="checkbox"
                                                                    checked={visibleCods.has(v.cod_vendedor)}
                                                                    onChange={() => {
                                                                        setVisibleCods(prev => {
                                                                            const next = new Set(prev);
                                                                            if (next.has(v.cod_vendedor)) next.delete(v.cod_vendedor);
                                                                            else next.add(v.cod_vendedor);
                                                                            return next;
                                                                        });
                                                                        if (!visiblesSeeded) setVisiblesSeeded(true);
                                                                    }} />
                                                                <span>{v.nombre}{!v.activo && ' (inactivo)'}</span>
                                                            </label>
                                                        ))}
                                                    </div>
                                                </div>
                                            </>
                                        )}
                                    </div>
                                    <label className="vs-inactivos-toggle" title="Incluir vendedores inactivos / históricos">
                                        <input type="checkbox"
                                            checked={showInactivos}
                                            onChange={e => setShowInactivos(e.target.checked)} />
                                        <span>Ver inactivos</span>
                                    </label>
                                </>
                            ) : 'Panel Vendedor'}
                        </span>
                    </div>
                </div>
                <div className="vs-top-actions">
                    <button className="vs-icon-btn" onClick={() => loadData(true)} title="Refrescar" disabled={loading}>
                        {loading ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
                    </button>
                    <div className="vs-avatar-wrap">
                        <button className="vs-avatar" onClick={() => setAvatarMenu(v => !v)} title="Mi cuenta">
                            {(user?.nombre ?? user?.email ?? '?').slice(0, 2).toUpperCase()}
                        </button>
                        {avatarMenu && (
                            <>
                                <div className="vs-avatar-scrim" onClick={() => setAvatarMenu(false)} />
                                <div className="vs-avatar-menu" role="menu">
                                    <div className="vs-avatar-header">
                                        <strong>{user?.nombre ?? user?.email}</strong>
                                        <span>{user?.email}</span>
                                    </div>
                                    <button onClick={() => { setAvatarMenu(false); setShowCambiarPass(true); }}>
                                        <Lock size={14} /> Cambiar mi contraseña
                                    </button>
                                    {isAdmin && (
                                        <button onClick={() => { setAvatarMenu(false); setShowImportSheet(true); }}>
                                            <FileSpreadsheet size={14} /> Actualizar objetivos del mes
                                        </button>
                                    )}
                                    {isAdmin && (
                                        <button onClick={() => { setAvatarMenu(false); setShowUsuariosAdmin(true); }}>
                                            <Users size={14} /> Gestionar usuarios
                                        </button>
                                    )}
                                    <div className="vs-avatar-sep" />
                                    <button className="danger" onClick={() => { setAvatarMenu(false); clearToken(); onLogout(); }}>
                                        <LogOut size={14} /> Cerrar sesión
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
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

                {tab === 'objetivos' && <ObjetivosView selectedVendor={selectedVendor} cods={codsQs} isAdmin={isAdmin} showInactivos={showInactivos} reloadTick={reloadObjetivosTick} />}

                {tab === 'actividad' && <ActividadView
                    vendedorKey={user?.vendedor_key ?? null}
                    clientNameMap={clientDbMap}
                    selectedVendor={selectedVendor}
                    cods={codsQs}
                    isAdmin={isAdmin}
                    pendingNew={pendingNewActivity}
                    onPendingConsumed={() => setPendingNewActivity(null)}
                />}
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
            {showCambiarPass && <CambiarPassword onClose={() => setShowCambiarPass(false)} />}
            {showUsuariosAdmin && <UsuariosAdmin onClose={() => setShowUsuariosAdmin(false)} />}
            {showImportSheet && <ImportarSheet
                onClose={() => setShowImportSheet(false)}
                onImported={() => setReloadObjetivosTick(t => t + 1)}
            />}
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
function ObjetivosView({ selectedVendor, cods, isAdmin, showInactivos, reloadTick }: { selectedVendor: number | null; cods: string; isAdmin: boolean; showInactivos: boolean; reloadTick: number }) {
    const [g, setG] = useState<GoalData | null>(null);
    const [meta, setMeta] = useState<GoalsMeta | null>(null);
    const [clientes, setClientes] = useState<ClienteObjetivo[]>([]);
    const [clientesStats, setClientesStats] = useState<ClientesResponse['stats'] | null>(null);
    const [seleccion, setSeleccion] = useState<Seleccion | null>(null);
    const [filter, setFilter] = useState<'todos' | 'bajo_objetivo' | 'completado' | 'sin_compras' | 'sin_objetivo'>('todos');
    const [localidad, setLocalidad] = useState<string>('');
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState<string | null>(null);
    const [syncing, setSyncing] = useState(false);
    const [editingHolidays, setEditingHolidays] = useState(false);
    const [savingHolidays, setSavingHolidays] = useState(false);
    const [editingTarget, setEditingTarget] = useState(false);
    const [targetInput, setTargetInput] = useState('');
    const [savingTarget, setSavingTarget] = useState(false);
    const [searchClientes, setSearchClientes] = useState('');

    // Reset localidad + search al cambiar de vendedor
    useEffect(() => { setLocalidad(''); setSearchClientes(''); }, [selectedVendor]);
    useEffect(() => { setSearchClientes(''); }, [localidad]);

    const clientesFiltered = useMemo(() => {
        const q = searchClientes.trim().toLowerCase();
        if (!q) return clientes;
        return clientes.filter(c =>
            (c.razon_social ?? '').toLowerCase().includes(q) ||
            (c.localidad ?? '').toLowerCase().includes(q) ||
            String(c.cod_cliente).includes(q)
        );
    }, [clientes, searchClientes]);

    const load = async () => {
        setLoading(true); setErr(null);
        try {
            const qs = new URLSearchParams({ filter });
            if (localidad) qs.set('localidad', localidad);
            if (isAdmin && selectedVendor != null) qs.set('cod_vendedor', String(selectedVendor));
            else if (isAdmin && cods) qs.set('cods', cods);
            const goalsQs = showInactivos ? '?incluir_inactivos=true' : '';
            const [gr, cr] = await Promise.all([
                fetch(`/api/goals${goalsQs}`, { headers: authHeaders() }).then(r => r.json()),
                fetch(`/api/goals/clientes?${qs.toString()}`, { headers: authHeaders() }).then(r => r.json()),
            ]);
            if (!gr.ok) throw new Error(gr.error);
            if (!cr.ok) throw new Error(cr.error);
            // Admin + selectedVendor: mostrar goal específico del vendedor. Sin selección: agregar todos.
            let goal: GoalData | null = null;
            if (isAdmin && selectedVendor != null) {
                goal = (gr.items ?? []).find((i: any) => i.cod_vendedor === selectedVendor) ?? null;
            } else if (isAdmin) {
                // Vista agregada: solo vendedores activos (mismo criterio que backend totales).
                // Andrea/Dario/Federico estan en la lista para filtrar pero no suman al equipo.
                const allItems = gr.items ?? [];
                const items = allItems.filter((i: any) => i.activo);
                const sumTarget = items.reduce((a: number, i: any) => a + (i.target_neto ?? 0), 0);
                const sumAvance = items.reduce((a: number, i: any) => a + (i.avance ?? 0), 0);
                const first = items[0] ?? allItems[0];
                goal = first ? {
                    ...first,
                    cod_vendedor: 0,
                    nombre: 'Equipo completo',
                    target_neto: sumTarget || null,
                    avance: sumAvance,
                    num_comprobantes: items.reduce((a: number, i: any) => a + (i.num_comprobantes ?? 0), 0),
                    pct_cumplimiento: sumTarget > 0 ? sumAvance / sumTarget : null,
                    proyeccion: items.reduce((a: number, i: any) => a + (i.proyeccion ?? 0), 0),
                    necesario_por_dia: sumTarget && first.dias_restantes > 0 ? Math.max(0, (sumTarget - sumAvance) / first.dias_restantes) : null,
                } : null;
            } else {
                goal = gr.items?.[0] ?? null;
            }
            setG(goal);
            setMeta({
                holidays: gr.holidays ?? [],
                dias_habiles_source: gr.dias_habiles_source ?? 'auto',
                year: gr.year,
                month: gr.month,
            });
            setClientes(cr.items || []);
            setClientesStats(cr.stats);
            setSeleccion(cr.seleccion ?? null);
        } catch (e: any) { setErr(e.message); }
        finally { setLoading(false); }
    };
    useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filter, localidad, selectedVendor, cods, showInactivos, reloadTick]);

    const syncNow = async () => {
        setSyncing(true);
        try {
            await fetch('/api/goals/sync-now', { method: 'POST', headers: authHeaders() });
            await load();
        } finally { setSyncing(false); }
    };

    const saveHolidays = async (days: number[]) => {
        if (!meta) return;
        const clean = Array.from(new Set(days))
            .filter(n => Number.isInteger(n) && n >= 1 && n <= 31)
            .sort((a, b) => a - b);
        setSavingHolidays(true);
        try {
            const res = await fetch('/api/month-config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({ year: meta.year, month: meta.month, holidays: clean }),
            });
            const j = await res.json();
            if (!res.ok || !j.ok) throw new Error(j.error);
            setEditingHolidays(false);
            await load();
        } catch (e: any) { alert(`Error: ${e.message}`); }
        finally { setSavingHolidays(false); }
    };

    const saveTarget = async () => {
        if (!meta || selectedVendor == null) return;
        const n = Number(targetInput);
        if (!isFinite(n) || n < 0) { alert('Target inválido'); return; }
        setSavingTarget(true);
        try {
            const res = await fetch('/api/goals', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({ cod_vendedor: selectedVendor, year: meta.year, month: meta.month, target_neto: n }),
            });
            const j = await res.json();
            if (!res.ok || !j.ok) throw new Error(j.error);
            setEditingTarget(false);
            await load();
        } catch (e: any) { alert(`Error: ${e.message}`); }
        finally { setSavingTarget(false); }
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

    const isLocFilter = !!localidad && !!seleccion;
    const heroTarget = isLocFilter ? seleccion!.total_objetivo : g.target_neto;
    const heroAvance = isLocFilter ? seleccion!.total_avance : g.avance;
    const heroPct = heroTarget && heroTarget > 0 ? heroAvance / heroTarget : null;
    const heroNumComp = isLocFilter ? seleccion!.num_comprobantes : g.num_comprobantes;
    const heroProyeccion = g.dias_habiles_transcurridos > 0
        ? heroAvance * (g.dias_habiles_total / g.dias_habiles_transcurridos)
        : heroAvance;
    const heroNecesarioDia = heroTarget != null && g.dias_restantes > 0
        ? Math.max(0, (heroTarget - heroAvance) / g.dias_restantes)
        : null;
    const heroPctProy = heroTarget && heroTarget > 0 ? heroProyeccion / heroTarget : null;

    const pct = heroPct ?? 0;
    const pctPct = Math.min(200, pct * 100);
    const pctProyPct = heroPctProy != null ? Math.min(999, heroPctProy * 100) : null;
    const circumference = 2 * Math.PI * 54;
    const offset = circumference * (1 - Math.min(1, pct));
    const localidades = clientesStats?.localidades ?? [];

    return (
        <div className="vs-view">
            <div className="vs-view-title">
                <h1>Mis <em>Objetivos</em></h1>
                <p><span className="dot" /> {monthName(new Date().getUTCMonth() + 1)} · {g.dias_habiles_transcurridos}/{g.dias_habiles_total} días · {g.dias_restantes} restantes</p>
            </div>

            {/* Feriados del mes */}
            <div className={`vs-holidays-bar ${editingHolidays ? 'is-open' : ''}`}>
                <div className="vs-holidays-row">
                    <Calendar size={13} />
                    <span className="vs-holidays-label">Feriados:</span>
                    {meta && meta.holidays.length > 0 ? (
                        <span className="vs-holidays-chips">
                            {meta.holidays.map(d => <span key={d} className="vs-holiday-chip">{d}</span>)}
                        </span>
                    ) : (
                        <span className="vs-holidays-empty">Ninguno configurado</span>
                    )}
                    {isAdmin && !editingHolidays && (
                        <button className="vs-holidays-edit" onClick={() => setEditingHolidays(true)} title="Editar feriados del mes">
                            <Edit3 size={12} />
                        </button>
                    )}
                </div>
                {editingHolidays && meta && (
                    <HolidayPickerGrid
                        year={meta.year}
                        month={meta.month}
                        initialHolidays={meta.holidays}
                        saving={savingHolidays}
                        onSave={saveHolidays}
                        onCancel={() => setEditingHolidays(false)}
                    />
                )}
            </div>

            {localidades.length > 0 && (
                <div className="vs-loc-scroll">
                    <button className={`vs-loc-chip ${localidad === '' ? 'is-active' : ''}`} onClick={() => setLocalidad('')}>
                        <span className="lbl">Todas</span>
                        <span className="count">{clientesStats?.total_clientes ?? 0}</span>
                    </button>
                    {localidades.map(l => (
                        <button key={l.localidad} className={`vs-loc-chip ${localidad === l.localidad ? 'is-active' : ''}`} onClick={() => setLocalidad(l.localidad)}>
                            <span className="lbl">{l.localidad}</span>
                            <span className="count">{l.count}</span>
                        </button>
                    ))}
                </div>
            )}

            <div className="vs-hero-goal">
                <div className="vs-hero-goal-head">
                    <div>
                        <span className="eyebrow">{isLocFilter ? 'OBJETIVO · LOCALIDAD' : 'OBJETIVO DEL MES'}</span>
                        <h2>{isLocFilter ? localidad : g.nombre}</h2>
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
                        <div>
                            <span className="k">Target</span>
                            {editingTarget ? (
                                <span className="vs-target-edit">
                                    <input type="number" step="1" min="0" autoFocus
                                        value={targetInput}
                                        onChange={e => setTargetInput(e.target.value)}
                                        onKeyDown={e => { if (e.key === 'Enter') saveTarget(); if (e.key === 'Escape') setEditingTarget(false); }} />
                                    <button onClick={saveTarget} disabled={savingTarget} title="Guardar">
                                        {savingTarget ? <Loader2 size={12} className="spin" /> : '✓'}
                                    </button>
                                    <button onClick={() => setEditingTarget(false)} title="Cancelar">×</button>
                                </span>
                            ) : (
                                <span className="v">
                                    {formatMoney(heroTarget)}
                                    {isAdmin && selectedVendor != null && !isLocFilter && (
                                        <button className="vs-target-edit-btn"
                                            onClick={() => { setTargetInput(String(heroTarget ?? 0)); setEditingTarget(true); }}
                                            title="Editar target">
                                            <Edit3 size={11} />
                                        </button>
                                    )}
                                </span>
                            )}
                        </div>
                        <div>
                            <span className="k">Avance</span>
                            <span className="v gold">
                                {formatMoney(heroAvance)}
                                {pctPct > 0 && <span className="vs-goal-pct"> · {Math.round(pctPct)}%</span>}
                            </span>
                        </div>
                        <div>
                            <span className="k">Proyección</span>
                            <span className="v">
                                {formatMoney(heroProyeccion)}
                                {pctProyPct != null && <span className="vs-goal-pct"> · {Math.round(pctProyPct)}%</span>}
                            </span>
                        </div>
                    </div>
                </div>

                <div className="vs-goal-daily">
                    <div className="k-box">
                        <span className="k">Necesario por día</span>
                        <strong>{formatMoney(heroNecesarioDia)}</strong>
                    </div>
                    <div className="note">
                        {heroNumComp} comprobantes{isLocFilter ? ' en esta localidad' : ' este mes'}.
                    </div>
                </div>

                <button className="vs-goal-refresh" onClick={syncNow} disabled={syncing}>
                    {syncing ? <><Loader2 size={12} className="spin" /> Sincronizando…</> : <><RefreshCw size={12} /> Actualizar avance</>}
                </button>
            </div>

            {/* ─── Objetivos por cliente ─── */}
            <div className="vs-clientes-obj">
                <div className="vs-clientes-obj-head">
                    <h2>Objetivo por cliente{isLocFilter && <span className="vs-clientes-obj-loc"> · {localidad}</span>}</h2>
                    {clientesStats && !isLocFilter && (
                        <p>
                            {clientesStats.completados}/{clientesStats.con_objetivo} completados ·
                            {' '}{formatMoney(clientesStats.total_avance)} de {formatMoney(clientesStats.total_objetivo)}
                        </p>
                    )}
                    {isLocFilter && seleccion && (
                        <p>
                            {seleccion.total_clientes} clientes · {formatMoney(seleccion.total_avance)} de {formatMoney(seleccion.total_objetivo)}
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

                <div className="vs-search vs-search-obj">
                    <Search size={16} />
                    <input value={searchClientes} onChange={e => setSearchClientes(e.target.value)}
                        placeholder="Buscar cliente, localidad o código…" />
                    {searchClientes && (
                        <button className="vs-search-clear" onClick={() => setSearchClientes('')} aria-label="Limpiar">×</button>
                    )}
                </div>

                {clientesFiltered.length === 0 && (
                    <div className="vs-empty" style={{ padding: '24px 16px' }}>
                        <Target size={28} />
                        <p>{searchClientes ? 'Sin coincidencias para la búsqueda.' : 'Sin clientes en este filtro.'}</p>
                    </div>
                )}

                <div className="vs-clientes-obj-list">
                    {clientesFiltered.map(c => <ClienteObjetivoCard key={c.cod_cliente} c={c} />)}
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
function ActividadView({ vendedorKey: _vendedorKey, clientNameMap, selectedVendor, cods, isAdmin, pendingNew, onPendingConsumed }:
    {
        vendedorKey: string | null; clientNameMap: Record<string, any>;
        selectedVendor: number | null; cods: string; isAdmin: boolean;
        pendingNew: { cod_cliente?: string; name?: string } | null;
        onPendingConsumed: () => void;
    }) {
    const [items, setItems] = useState<ActivityItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState<string | null>(null);
    const [showNew, setShowNew] = useState<{ cod_cliente?: string; name?: string } | null>(null);

    const load = async () => {
        setLoading(true); setErr(null);
        try {
            const params = new URLSearchParams();
            if (isAdmin && selectedVendor != null) params.set('cod_vendedor', String(selectedVendor));
            else if (isAdmin && cods) params.set('cods', cods);
            const qs = params.toString() ? `?${params.toString()}` : '';
            const res = await fetch(`/api/activity${qs}`, { headers: authHeaders() });
            const j = await res.json();
            if (!res.ok || !j.ok) throw new Error(j.error);
            setItems(j.items || []);
        } catch (e: any) { setErr(e.message); }
        finally { setLoading(false); }
    };
    useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [selectedVendor, cods]);

    // Cuando llega un pendingNew desde el root (ej. tap "Nota" en Cobranzas), abrir modal.
    useEffect(() => {
        if (pendingNew) {
            setShowNew({ cod_cliente: pendingNew.cod_cliente, name: pendingNew.name });
            onPendingConsumed();
        }
        /* eslint-disable-next-line react-hooks/exhaustive-deps */
    }, [pendingNew]);

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

// ─── HolidayPickerGrid — calendario plegable para seleccionar feriados ─────
function HolidayPickerGrid({ year, month, initialHolidays, saving, onSave, onCancel }: {
    year: number; month: number; initialHolidays: number[];
    saving: boolean;
    onSave: (days: number[]) => Promise<void> | void;
    onCancel: () => void;
}) {
    const [selected, setSelected] = useState<Set<number>>(() => new Set(initialHolidays));

    const daysInMonth = new Date(year, month, 0).getDate();
    const firstDow = new Date(year, month - 1, 1).getDay(); // 0=dom, 1=lun, ...
    // Shift para grilla LUN primero: lun=0, mar=1, ..., sab=5, dom=6
    const pad = (firstDow + 6) % 7;

    const now = new Date();
    const isCurrentMonth = now.getUTCFullYear() === year && (now.getUTCMonth() + 1) === month;
    const today = isCurrentMonth ? now.getUTCDate() : null;

    const toggle = (d: number) => {
        // No permitir marcar domingos (ya excluidos por backend) — pero UX cerrada igual.
        const dow = new Date(year, month - 1, d).getDay();
        if (dow === 0) return;
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(d)) next.delete(d); else next.add(d);
            return next;
        });
    };

    const cells: ReactNode[] = [];
    for (let i = 0; i < pad; i++) cells.push(<div key={`p${i}`} className="vs-hp-day is-pad" />);
    for (let d = 1; d <= daysInMonth; d++) {
        const dow = new Date(year, month - 1, d).getDay();
        const isSunday = dow === 0;
        const isToday = today === d;
        const isPast = today != null && d < today;
        const isHoliday = selected.has(d);
        const cls = [
            'vs-hp-day',
            isSunday && 'is-sunday',
            isToday && 'is-today',
            isPast && 'is-past',
            isHoliday && 'is-holiday',
        ].filter(Boolean).join(' ');
        cells.push(
            <button key={d} className={cls} disabled={isSunday} onClick={() => toggle(d)} type="button">
                {d}
            </button>
        );
    }

    const count = selected.size;
    const mes = monthName(month);

    return (
        <div className="vs-hp-grid">
            <div className="vs-hp-title">
                {mes} {year}
                <span className="vs-hp-hint">Tocá los días que NO se trabaja (domingos ya excluidos)</span>
            </div>
            <div className="vs-hp-weekdays">
                {['L', 'M', 'X', 'J', 'V', 'S', 'D'].map(l => <div key={l}>{l}</div>)}
            </div>
            <div className="vs-hp-days">{cells}</div>
            <div className="vs-hp-legend">
                <span className="vs-hp-leg-dot today" /> Hoy
                <span className="vs-hp-leg-dot holiday" /> No laborable
                <span className="vs-hp-leg-dot sunday" /> Domingo
            </div>
            <div className="vs-hp-footer">
                <button className="vs-btn-sec" onClick={onCancel} disabled={saving}>Cancelar</button>
                <button className="vs-btn-primary" onClick={() => onSave(Array.from(selected))} disabled={saving}>
                    {saving ? <><Loader2 size={14} className="spin" /> Guardando…</> : `Guardar ${count} día${count !== 1 ? 's' : ''}`}
                </button>
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
