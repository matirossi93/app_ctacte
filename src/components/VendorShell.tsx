import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
    Search, Phone, MessageSquare, FileText, Calendar, Receipt,
    Target, Activity as ActivityIcon, ReceiptText, Plus, RefreshCw, Loader2, AlertCircle,
    DollarSign, Truck, Edit3, Lock, Users, LogOut, FileSpreadsheet, Settings2, MapPin,
    Sun, ChevronRight, AlertTriangle, Download, Trash2, Pencil, Bell
} from 'lucide-react';
import { authHeaders, clearToken, getUser } from '../utils/auth';
import { RecibosApp } from './RecibosApp';
import { CambiarPassword } from './CambiarPassword';
import { UsuariosAdmin } from './UsuariosAdmin';
import { ImportarSheet } from './ImportarSheet';
import { ReportesModal } from './ReportesModal';
import { PeriodSelector, type ViewPeriod } from './PeriodSelector';
import { HistoricBanner } from './HistoricBanner';
import { PrintAvanceView } from './PrintAvanceView';
import { ComisionesView } from './ComisionesView';
import { ensurePushSubscription } from '../utils/webPush';
import './VendorShell.css';

const VIEW_PERIOD_KEY = 'vs_view_period';
function loadInitialPeriod(): ViewPeriod {
    const t = new Date();
    const fallback: ViewPeriod = { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, asOfDay: null };
    try {
        const raw = sessionStorage.getItem(VIEW_PERIOD_KEY);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.year !== 'number' || typeof parsed.month !== 'number') return fallback;
        return { year: parsed.year, month: parsed.month, asOfDay: parsed.asOfDay ?? null };
    } catch { return fallback; }
}
function isCurrentPeriod(p: ViewPeriod): boolean {
    const t = new Date();
    return p.year === t.getUTCFullYear() && p.month === t.getUTCMonth() + 1 && (p.asOfDay == null);
}

type Tab = 'hoy' | 'cobranzas' | 'objetivos' | 'comisiones' | 'actividad';

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
    db?: Record<string, any>; // ref a clientDbMap[cod] para acceso a direccion, dia_visita, repartidor, ABC, histórico, etc.
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
    cod_vendedor: number | null;
    razon_social: string | null;
    localidad: string | null;
    frecuencia: string | null;
    tipo_abc: string | null;
    direccion: string | null;
    repartidor: string | null;
    hoja_ruta: string | null;
    dia_entrega: string | null;
    cond_pago: string | null;
    notas: string | null;
    objetivo_mes: number | null;
    fact_mes_pasado: number | null;
    fact_prom_3m: number | null;
    saldo_cta_cte: number | null;
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
    cod_vendedor: number;
    tipo: 'nota' | 'llamada' | 'wa' | 'promesa' | 'pago' | 'visita';
    contenido: string | null;
    monto: number | null;
    fecha_promesa: string | null;
    hora_promesa: string | null;   // "HH:MM" o null
    created_at: string;
    created_by_email?: string | null;
    created_by_nombre?: string | null;
}

// Historial de compras del cliente — usado en Tasks 8-10
interface HistorialItemAgregado {
    cod_articulo: number;
    detalle: string;
    cantidad_total: number;
    importe_total: number;
    num_facturas: number;
    ultima_compra: string;
}

interface HistorialFacturaItem {
    cod_articulo: number;
    detalle: string;
    cantidad: number;
    importe: number;
}

interface HistorialFactura {
    id_comprobante: number;
    fecha: string;
    tipo: 'FA' | 'NC';
    tipo_factura: string;
    punto_venta: number;
    numero: number;
    total_neto: number;
    items: HistorialFacturaItem[];
}

interface HistorialAlertaCliente {
    dias_sin_comprar: number;
    media_dias_entre_compras: number;
    nivel: 'amarillo' | 'rojo' | null;
}

interface HistorialProductoAbandono {
    cod_articulo: number;
    detalle: string;
    dias_sin_comprar: number;
    intervalo_medio_dias: number;
    num_compras: number;
}

interface HistorialComparacion {
    actual: number;
    anterior: number;
    delta_pct: number | null;
}

interface HistorialComprasResponse {
    ok: boolean;
    cod_cliente: number;
    meses: number;
    rango: { desde: string; hasta: string };
    facturas: HistorialFactura[];
    top_importe: HistorialItemAgregado[];
    top_frecuencia: HistorialItemAgregado[];
    alertas: {
        cliente: HistorialAlertaCliente | null;
        productos: HistorialProductoAbandono[];
    };
    comparacion: HistorialComparacion;
    generated_at: string;
}
interface Props {
    onLogout: () => void;
}

export const VendorShell = ({ onLogout }: Props) => {
    const user = getUser();
    const isAdmin = user?.rol === 'admin' || user?.rol === 'gerente';
    const [tab, setTab] = useState<Tab>('hoy');
    const [showRecibos, setShowRecibos] = useState(false);
    const [bucket, setBucket] = useState<'todos' | 'reciente' | 'medio' | 'vencido'>('todos');
    const [search, setSearch] = useState('');
    // Pendiente de crear actividad (disparado desde CobranzasView)
    const [pendingNewActivity, setPendingNewActivity] = useState<{ cod_cliente?: string; name?: string } | null>(null);
    // Pendiente de abrir un cliente en Cobranzas (disparado desde HoyView)
    const [pendingCobClient, setPendingCobClient] = useState<string | null>(null);

    // Menu del avatar
    const [avatarMenu, setAvatarMenu] = useState(false);
    const [showCambiarPass, setShowCambiarPass] = useState(false);
    const [showUsuariosAdmin, setShowUsuariosAdmin] = useState(false);
    const [showImportSheet, setShowImportSheet] = useState(false);
    const [showReportes, setShowReportes] = useState(false);
    const [reloadObjetivosTick, setReloadObjetivosTick] = useState(0);

    // Período visible para tabs Objetivos y Reportes. Default = mes actual.
    // Persiste en sessionStorage (se resetea al cerrar pestaña — minimiza
    // confusión "¿por qué veo otro mes?" en próxima sesión).
    // Tabs Hoy y Cobranzas siempre operan sobre la fecha real, ignoran este state.
    const [viewPeriod, setViewPeriod] = useState<ViewPeriod>(loadInitialPeriod);
    useEffect(() => {
        sessionStorage.setItem(VIEW_PERIOD_KEY, JSON.stringify(viewPeriod));
    }, [viewPeriod]);
    const isHistoricView = !isCurrentPeriod(viewPeriod);
    const resetPeriod = () => {
        const t = new Date();
        setViewPeriod({ year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, asOfDay: null });
    };

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

    // Web Push: registramos SW al montar; el permiso lo pedimos en el primer
    // click del usuario en cualquier parte de la app porque los navegadores
    // requieren un user gesture para Notification.requestPermission. Si VAPID
    // no está en el server, el helper devuelve 'not-configured' sin error.
    useEffect(() => {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/sw.js').catch(() => { });
        }
        let asked = false;
        const onFirstClick = () => {
            if (asked) return;
            asked = true;
            ensurePushSubscription().catch(() => { });
        };
        document.addEventListener('click', onFirstClick, { once: true });
        return () => document.removeEventListener('click', onFirstClick);
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
                    db: clientDbMap[cod] ?? undefined,
                });
            }
            const c = map.get(cod)!;
            c.totalSaldo += saldo;
            const dias = Number(inv.DIAS_EMISI) || 0;
            // Aging: cuenta todo comprobante con saldo DEUDOR (positivo) para la
            // antigüedad — FA y ND suman deuda. NC, recibos y ajustes al haber
            // tienen saldo negativo y no deben contar. Antes solo miraba 'FA',
            // por eso una ND vieja no movía los días de mora del cliente.
            if (saldo > 0 && dias > c.maxDias) c.maxDias = dias;
            c.invoices.push(inv);
        }
        return Array.from(map.values())
            .filter(c => c.totalSaldo > 1000)
            .sort((a, b) => b.maxDias - a.maxDias);
    }, [invoices, clientDbMap]);

    const buckets = useMemo(() => {
        const b = { reciente: 0, medio: 0, vencido: 0 };
        clientsAgg.forEach(c => {
            if (c.maxDias <= 7) b.reciente++;
            else if (c.maxDias <= 15) b.medio++;
            else b.vencido++;
        });
        return b;
    }, [clientsAgg]);

    const clientsFiltered = useMemo(() => {
        let list = clientsAgg;
        if (bucket !== 'todos') {
            list = list.filter(c => {
                if (bucket === 'reciente') return c.maxDias <= 7;
                if (bucket === 'medio') return c.maxDias > 7 && c.maxDias <= 15;
                return c.maxDias > 15;
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
                        <img src="/logo.png" alt="Semillero El Manantial" />
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
                                                ? `Todos (${visibleCods.size} de ${vendedores.length})`
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
                    <PeriodSelector value={viewPeriod} onChange={setViewPeriod} />
                    <NotificacionesBell />
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
                                    {isAdmin && (
                                        <button onClick={() => { setAvatarMenu(false); setShowReportes(true); }}>
                                            <Download size={14} /> Exportar reportes
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

            {/* Banner amarillo cuando se está viendo un período histórico (≠ mes actual). */}
            {isHistoricView && <HistoricBanner period={viewPeriod} onReset={resetPeriod} />}

            {/* ═══════════ TAB CONTENT ═══════════ */}
            <main className="vs-main">
                {err && <div className="vs-error"><AlertCircle size={16} /> {err}</div>}

                {tab === 'hoy' && (
                    <HoyView
                        clientsAgg={clientsAgg}
                        user={user}
                        isAdmin={isAdmin}
                        selectedVendor={selectedVendor}
                        cods={codsQs}
                        onGoToTab={(t) => setTab(t)}
                        onOpenCobClient={(cod) => { setPendingCobClient(cod); setTab('cobranzas'); }}
                        onOpenActivityForClient={(cod, name) => { setPendingNewActivity({ cod_cliente: cod, name }); setTab('actividad'); }}
                    />
                )}

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
                        pendingOpenClient={pendingCobClient}
                        onPendingOpenConsumed={() => setPendingCobClient(null)}
                    />
                )}

                {tab === 'objetivos' && <ObjetivosView selectedVendor={selectedVendor} cods={codsQs} isAdmin={isAdmin} showInactivos={showInactivos} reloadTick={reloadObjetivosTick} viewPeriod={viewPeriod} />}

                {tab === 'comisiones' && <ComisionesView isAdmin={isAdmin} viewPeriod={viewPeriod} userCodVendedor={user?.cod_vendedor ?? null} />}

                {tab === 'actividad' && <ActividadView
                    vendedorKey={user?.vendedor_key ?? null}
                    clientNameMap={clientDbMap}
                    selectedVendor={selectedVendor}
                    cods={codsQs}
                    isAdmin={isAdmin}
                    vendedoresList={vendedores}
                    pendingNew={pendingNewActivity}
                    onPendingConsumed={() => setPendingNewActivity(null)}
                />}
            </main>

            {/* ═══════════ BOTTOM NAV ═══════════ */}
            <nav className="vs-nav" data-tab={tab}>
                <div className="vs-nav-pill" />
                <button className={`vs-nav-btn ${tab === 'hoy' ? 'is-active' : ''}`} onClick={() => setTab('hoy')}>
                    <Sun size={22} />
                    <span>Hoy</span>
                </button>
                <button className={`vs-nav-btn ${tab === 'cobranzas' ? 'is-active' : ''}`} onClick={() => setTab('cobranzas')}>
                    <ReceiptText size={22} />
                    <span>Cobranzas</span>
                </button>
                <button className={`vs-nav-btn ${tab === 'objetivos' ? 'is-active' : ''}`} onClick={() => setTab('objetivos')}>
                    <Target size={22} />
                    <span>Objetivos</span>
                </button>
                <button className={`vs-nav-btn ${tab === 'comisiones' ? 'is-active' : ''}`} onClick={() => setTab('comisiones')}>
                    <DollarSign size={22} />
                    <span>Comisiones</span>
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
            {showReportes && <ReportesModal onClose={() => setShowReportes(false)} period={viewPeriod} />}
        </div>
    );
};

// ═══════════════════════════════════════════════════════════════════════════
// HOY VIEW (Dashboard del día)
// ═══════════════════════════════════════════════════════════════════════════
function HoyView({ clientsAgg, user, isAdmin, selectedVendor, cods, onGoToTab, onOpenCobClient, onOpenActivityForClient }:
    {
        clientsAgg: ClientAgg[];
        user: any;
        isAdmin: boolean;
        selectedVendor: number | null;
        cods: string;
        onGoToTab: (t: Tab) => void;
        onOpenCobClient: (cod: string) => void;
        onOpenActivityForClient: (cod: string, name: string) => void;
    }) {
    const [goal, setGoal] = useState<GoalData | null>(null);
    const [rankingItems, setRankingItems] = useState<any[]>([]);
    const [teamTotales, setTeamTotales] = useState<{ target: number; avance: number; pct: number | null; proyeccion: number; diasRestantes: number } | null>(null);
    const [activity, setActivity] = useState<ActivityItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState<string | null>(null);

    const load = async () => {
        setLoading(true); setErr(null);
        try {
            const actParams = new URLSearchParams();
            if (isAdmin && selectedVendor != null) actParams.set('cod_vendedor', String(selectedVendor));
            else if (isAdmin && cods) actParams.set('cods', cods);
            actParams.set('limit', '200');
            const actQs = actParams.toString() ? `?${actParams.toString()}` : '';

            const [gr, ar] = await Promise.all([
                fetch(`/api/goals`, { headers: authHeaders() }).then(r => r.json()),
                fetch(`/api/activity${actQs}`, { headers: authHeaders() }).then(r => r.json()),
            ]);
            if (!gr.ok) throw new Error(gr.error || 'goals error');
            if (!ar.ok) throw new Error(ar.error || 'activity error');

            const items = (gr.items ?? []) as any[];
            setRankingItems(items);

            if (isAdmin && selectedVendor != null) {
                const g = items.find(i => i.cod_vendedor === selectedVendor) ?? null;
                setGoal(g);
                setTeamTotales(null);
            } else if (isAdmin) {
                // Agregado del equipo activos
                const activos = items.filter(i => i.activo !== false);
                const sumTarget = activos.reduce((a, i) => a + (i.target_neto ?? 0), 0);
                const sumAvance = activos.reduce((a, i) => a + (i.avance ?? 0), 0);
                const sumProy = activos.reduce((a, i) => a + (i.proyeccion ?? 0), 0);
                const first = activos[0] ?? items[0];
                setTeamTotales({
                    target: sumTarget,
                    avance: sumAvance,
                    pct: sumTarget > 0 ? sumAvance / sumTarget : null,
                    proyeccion: sumProy,
                    diasRestantes: first?.dias_restantes ?? 0,
                });
                setGoal(null);
            } else {
                setGoal(items[0] ?? null);
                setTeamTotales(null);
            }

            setActivity((ar.items ?? []) as ActivityItem[]);
        } catch (e: any) { setErr(e.message); }
        finally { setLoading(false); }
    };
    useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [isAdmin, selectedVendor, cods]);

    // Promesas vigentes (≤ hoy + 2d), ordenadas por urgencia
    const promesas = useMemo(() => {
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const limit = new Date(today); limit.setDate(limit.getDate() + 2);
        return activity
            .filter(a => a.tipo === 'promesa' && a.fecha_promesa)
            .map(a => {
                const fp = new Date(a.fecha_promesa + 'T00:00:00');
                const diff = Math.floor((fp.getTime() - today.getTime()) / 86400000);
                return { ...a, _fp: fp, _diff: diff };
            })
            .filter(p => p._fp <= limit)
            .sort((a, b) => a._fp.getTime() - b._fp.getTime());
    }, [activity]);

    // Top deudores (mora > 15d)
    const topDeudores = useMemo(() => {
        return clientsAgg
            .filter(c => c.maxDias > 15)
            .sort((a, b) => b.maxDias - a.maxDias)
            .slice(0, 5);
    }, [clientsAgg]);

    // Top 3 ranking equipo (admin)
    const top3 = useMemo(() => {
        return rankingItems
            .filter(i => i.activo !== false && i.target_neto && i.target_neto > 0)
            .sort((a, b) => (b.pct_cumplimiento ?? 0) - (a.pct_cumplimiento ?? 0))
            .slice(0, 3);
    }, [rankingItems]);

    // Saludo por hora
    const hour = new Date().getHours();
    const saludo = hour < 12 ? 'Buenos días' : hour < 20 ? 'Buenas tardes' : 'Buenas noches';
    const nombreCorto = (user?.nombre ?? user?.email ?? '').split(' ')[0] || 'che';

    if (loading) return <div className="vs-loading"><Loader2 className="spin" /> Cargando…</div>;

    return (
        <div className="vs-view vs-hoy">
            <div className="vs-hoy-saludo">
                <h1>{saludo}, <em>{nombreCorto}</em></h1>
                <p>
                    {promesas.length > 0
                        ? <>⚡ <strong>{promesas.length}</strong> {promesas.length === 1 ? 'promesa' : 'promesas'} en los próximos días</>
                        : <>Sin promesas urgentes esta semana.</>}
                    {topDeudores.length > 0 && <> · <strong>{topDeudores.length}</strong> {topDeudores.length === 1 ? 'cliente' : 'clientes'} con mora alta</>}
                </p>
                {err && <div className="vs-error" style={{ marginTop: 8 }}><AlertCircle size={14} /> {err}</div>}
            </div>

            <div className="vs-hoy-grid">
                {/* Promesas vigentes — fila completa */}
                <WidgetPromesas items={promesas} isAdmin={isAdmin} onOpen={(p) => {
                    const cc = clientsAgg.find(c => c.cod === String(p.cod_cliente));
                    const name = cc?.name ?? `Cliente ${p.cod_cliente}`;
                    onOpenActivityForClient(String(p.cod_cliente), name);
                }} onGoToActividad={() => onGoToTab('actividad')} />

                {/* Avance o Equipo */}
                {isAdmin
                    ? <WidgetEquipo totales={teamTotales} top3={top3} onGoTo={() => onGoToTab('objetivos')} />
                    : <WidgetAvance goal={goal} onGoTo={() => onGoToTab('objetivos')} />
                }

                {/* Top deudores */}
                <WidgetTopDeudores clients={topDeudores} onOpenClient={onOpenCobClient} onGoToCobranzas={() => onGoToTab('cobranzas')} />
            </div>
        </div>
    );
}

function WidgetPromesas({ items, isAdmin, onOpen, onGoToActividad }: { items: any[]; isAdmin: boolean; onOpen: (p: any) => void; onGoToActividad: () => void }) {
    return (
        <div className="vs-widget vs-widget--wide">
            <div className="vs-widget-head">
                <h3>📌 Promesas vigentes</h3>
                <button className="vs-widget-more" onClick={onGoToActividad} title="Ver todas">
                    Ver todo <ChevronRight size={14} />
                </button>
            </div>
            {items.length === 0 ? (
                <div className="vs-widget-empty">No tenés promesas para esta semana. 🎉</div>
            ) : (
                <div className="vs-promesa-list">
                    {items.slice(0, 6).map(p => {
                        const tone = p._diff < 0 ? 'late' : p._diff === 0 ? 'today' : 'soon';
                        const label = p._diff < 0 ? `hace ${Math.abs(p._diff)}d` : p._diff === 0 ? 'HOY' : `en ${p._diff}d`;
                        return (
                            <button key={p.id} className={`vs-promesa vs-promesa--${tone}`} onClick={() => onOpen(p)}>
                                <div className="vs-promesa-date">{label}</div>
                                <div className="vs-promesa-body">
                                    <strong>Cliente {p.cod_cliente ?? '—'}</strong>
                                    {p.monto != null && <span className="vs-promesa-monto">{formatMoney(p.monto)}</span>}
                                    {p.contenido && <span className="vs-promesa-note">{p.contenido}</span>}
                                    {isAdmin && p.created_by_nombre && <span className="vs-promesa-owner">· {p.created_by_nombre}</span>}
                                </div>
                                <ChevronRight size={16} className="vs-promesa-arrow" />
                            </button>
                        );
                    })}
                    {items.length > 6 && <button className="vs-widget-more-link" onClick={onGoToActividad}>+ {items.length - 6} más</button>}
                </div>
            )}
        </div>
    );
}

function WidgetAvance({ goal, onGoTo }: { goal: GoalData | null; onGoTo: () => void }) {
    if (!goal || goal.target_neto == null) {
        return (
            <div className="vs-widget vs-widget--avance">
                <div className="vs-widget-head"><h3>🎯 Avance del mes</h3></div>
                <div className="vs-widget-empty">Sin target este mes. Pedile a Matías o Manolo.</div>
            </div>
        );
    }
    const pct = goal.pct_cumplimiento ?? 0;
    const pctPct = Math.min(200, pct * 100);
    const circumference = 2 * Math.PI * 36;
    const offset = circumference * (1 - Math.min(1, pct));
    const tone = pct >= 0.9 ? 'ok' : pct >= 0.5 ? 'mid' : 'low';
    return (
        <button className={`vs-widget vs-widget--avance vs-widget--${tone}`} onClick={onGoTo}>
            <div className="vs-widget-head">
                <h3>🎯 Tu avance</h3>
                <ChevronRight size={14} />
            </div>
            <div className="vs-avance-body">
                <div className="vs-avance-ring">
                    <svg viewBox="0 0 80 80">
                        <circle cx="40" cy="40" r="36" fill="none" stroke="rgba(20,24,20,.08)" strokeWidth="6" />
                        <circle cx="40" cy="40" r="36" fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round"
                            style={{ strokeDasharray: circumference, strokeDashoffset: offset, transform: 'rotate(-90deg)', transformOrigin: 'center' }} />
                    </svg>
                    <div className="vs-avance-pct">{Math.round(pctPct)}<span>%</span></div>
                </div>
                <div className="vs-avance-figs">
                    <div><span className="k">Target</span><strong>{formatMoney(goal.target_neto)}</strong></div>
                    <div><span className="k">Avance</span><strong className="gold">{formatMoney(goal.avance)}</strong></div>
                    <div><span className="k">Necesario/día</span><strong>{formatMoney(goal.necesario_por_dia)}</strong></div>
                </div>
            </div>
            <div className="vs-widget-foot">{goal.dias_restantes}d restantes</div>
        </button>
    );
}

function WidgetEquipo({ totales, top3, onGoTo }: { totales: { target: number; avance: number; pct: number | null; proyeccion: number; diasRestantes: number } | null; top3: any[]; onGoTo: () => void }) {
    if (!totales) return null;
    const pct = totales.pct ?? 0;
    const pctPct = Math.min(200, pct * 100);
    const tone = pct >= 0.9 ? 'ok' : pct >= 0.5 ? 'mid' : 'low';
    const medals = ['🥇', '🥈', '🥉'];
    return (
        <button className={`vs-widget vs-widget--avance vs-widget--${tone}`} onClick={onGoTo}>
            <div className="vs-widget-head">
                <h3>🎯 Equipo</h3>
                <ChevronRight size={14} />
            </div>
            <div className="vs-avance-figs" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                <div><span className="k">Target</span><strong>{formatMoney(totales.target)}</strong></div>
                <div><span className="k">Avance</span><strong className="gold">{formatMoney(totales.avance)}</strong></div>
                <div><span className="k">Cumplimiento</span><strong>{Math.round(pctPct)}%</strong></div>
            </div>
            {top3.length > 0 && (
                <div className="vs-hoy-top3">
                    {top3.map((v, i) => {
                        const vPct = Math.round(Math.min(200, (v.pct_cumplimiento ?? 0) * 100));
                        const barPct = Math.min(100, (v.pct_cumplimiento ?? 0) * 100);
                        return (
                            <div key={v.cod_vendedor} className="vs-hoy-top3-row">
                                <span className="medal">{medals[i]}</span>
                                <strong>{v.nombre}</strong>
                                <span className="pct">{vPct}%</span>
                                <div className="bar"><div className="bar-fill" style={{ width: `${barPct}%` }} /></div>
                            </div>
                        );
                    })}
                </div>
            )}
            <div className="vs-widget-foot">{totales.diasRestantes}d restantes · proyección {formatMoney(totales.proyeccion)}</div>
        </button>
    );
}

function WidgetTopDeudores({ clients, onOpenClient, onGoToCobranzas }: { clients: ClientAgg[]; onOpenClient: (cod: string) => void; onGoToCobranzas: () => void }) {
    return (
        <div className="vs-widget vs-widget--deudores">
            <div className="vs-widget-head">
                <h3>🚨 Mora alta</h3>
                <button className="vs-widget-more" onClick={onGoToCobranzas}>
                    Ver todo <ChevronRight size={14} />
                </button>
            </div>
            {clients.length === 0 ? (
                <div className="vs-widget-empty">Sin clientes con +15d. ¡Excelente!</div>
            ) : (
                <div className="vs-deudor-list">
                    {clients.map(c => {
                        const tel = telHref(c.db?.telefono);
                        const wa = waHref(c.db?.whatsapp ?? c.db?.telefono);
                        return (
                            <div key={c.cod} className="vs-deudor">
                                <button className="vs-deudor-main" onClick={() => onOpenClient(c.cod)}>
                                    <div>
                                        <strong>{c.name}</strong>
                                        <span>{c.localidad || 'Sin localidad'}</span>
                                    </div>
                                    <div className="vs-deudor-right">
                                        <div className="vs-deudor-saldo">{formatMoney(c.totalSaldo)}</div>
                                        <span className="vs-deudor-dias"><AlertTriangle size={11} />{c.maxDias}d</span>
                                    </div>
                                </button>
                                <div className="vs-deudor-actions">
                                    {tel && <a className="vs-deudor-qa" href={tel} title="Llamar"><Phone size={14} /></a>}
                                    {wa && <a className="vs-deudor-qa" href={wa} target="_blank" rel="noreferrer" title="WhatsApp"><MessageSquare size={14} /></a>}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// COBRANZAS VIEW
// ═══════════════════════════════════════════════════════════════════════════
function CobranzasView({ clients, search, setSearch, bucket, setBucket, buckets, totalSaldo, totalClientes, onUploadPago, lastRefresh, loading, pendingOpenClient, onPendingOpenConsumed }:
    {
        clients: ClientAgg[]; search: string; setSearch: (s: string) => void;
        bucket: 'todos' | 'reciente' | 'medio' | 'vencido'; setBucket: (b: any) => void;
        buckets: { reciente: number; medio: number; vencido: number };
        totalSaldo: number; totalClientes: number;
        onUploadPago: () => void;
        lastRefresh: Date | null;
        loading: boolean;
        pendingOpenClient?: string | null;
        onPendingOpenConsumed?: () => void;
    }) {
    const [openClient, setOpenClient] = useState<string | null>(null);

    // Si vienen con un cliente pre-seleccionado desde "Hoy", expandirlo y scrollear.
    useEffect(() => {
        if (!pendingOpenClient) return;
        setOpenClient(pendingOpenClient);
        setBucket('todos');
        setSearch('');
        setTimeout(() => {
            const el = document.querySelector(`[data-client-cod="${pendingOpenClient}"]`);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 50);
        onPendingOpenConsumed?.();
        /* eslint-disable-next-line react-hooks/exhaustive-deps */
    }, [pendingOpenClient]);

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
                    Todos <span className="count">{buckets.reciente + buckets.medio + buckets.vencido}</span>
                </button>
                <button className={`vs-chip ${bucket === 'reciente' ? 'is-active' : ''}`} onClick={() => setBucket('reciente')}>
                    <span className="dot-b" style={{ background: '#06652F' }} />0-7d <span className="count">{buckets.reciente}</span>
                </button>
                <button className={`vs-chip ${bucket === 'medio' ? 'is-active' : ''}`} onClick={() => setBucket('medio')}>
                    <span className="dot-b" style={{ background: '#D18A3C' }} />7-15d <span className="count">{buckets.medio}</span>
                </button>
                <button className={`vs-chip ${bucket === 'vencido' ? 'is-active' : ''}`} onClick={() => setBucket('vencido')}>
                    <span className="dot-b" style={{ background: '#A83E2B' }} />+15d <span className="count">{buckets.vencido}</span>
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
    const bucket = client.maxDias <= 7 ? 'reciente' : client.maxDias <= 15 ? 'medio' : 'vencido';
    const bucketLabel = `${client.maxDias}d`;
    const db = client.db ?? {};
    const tel = telHref(db.telefono);
    const wa = waHref(db.whatsapp ?? db.telefono); // fallback a teléfono si no hay celular separado

    return (
        <div className={`vs-client ${isOpen ? 'is-open' : ''}`} data-client-cod={client.cod}>
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
                <a className={`vs-qa call ${tel ? '' : 'is-disabled'}`}
                   href={tel ?? undefined}
                   onClick={e => { e.stopPropagation(); if (!tel) e.preventDefault(); }}
                   title={tel ? 'Llamar' : 'Sin teléfono en InfoManager'}>
                    <Phone size={18} /><span>Llamar</span>
                </a>
                <a className={`vs-qa wa ${wa ? '' : 'is-disabled'}`}
                   href={wa ?? undefined}
                   target={wa ? '_blank' : undefined} rel="noreferrer"
                   onClick={e => { e.stopPropagation(); if (!wa) e.preventDefault(); }}
                   title={wa ? 'WhatsApp' : 'Sin teléfono en InfoManager'}>
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
function ObjetivosView({ selectedVendor, cods, isAdmin, showInactivos, reloadTick, viewPeriod }: { selectedVendor: number | null; cods: string; isAdmin: boolean; showInactivos: boolean; reloadTick: number; viewPeriod: ViewPeriod }) {
    // En modo histórico O con corte asOfDay, las acciones de edición (target, feriados,
    // sync, holidays) se deshabilitan: la data viene de un snapshot fijo, no debería mutar.
    const isHistoricMode = !isCurrentPeriod(viewPeriod);
    const [g, setG] = useState<GoalData | null>(null);
    const [meta, setMeta] = useState<GoalsMeta | null>(null);
    const [rankingItems, setRankingItems] = useState<any[]>([]);
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
    const [openCliObj, setOpenCliObj] = useState<number | null>(null);
    const [showPrint, setShowPrint] = useState(false);
    const [totales, setTotales] = useState<any>(null);

    // Cache local de respuestas {gr, cr} keyed por filtros. Vive la sesión y se
    // limpia cuando reloadTick cambia (tras import/sync). Stale-while-revalidate:
    // si hay hit, mostrar inmediatamente y refresh en background.
    const cacheRef = useRef<Map<string, { gr: any; cr: any }>>(new Map());
    // AbortController para cancelar requests viejos cuando el usuario cambia
    // rápido entre meses/cortes y evitar race conditions.
    const abortRef = useRef<AbortController | null>(null);

    // Limpiar cache local cuando el padre dispara un reload (tras import Maestro
    // o sync-now). Sin esto, la mutación se vería con delay del lado cliente.
    useEffect(() => { cacheRef.current.clear(); }, [reloadTick]);

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

    // Helper: aplica una respuesta {gr, cr} al state. Reutilizado para cache hit
    // y para fetch fresh, evitando lógica duplicada.
    const applyData = (gr: any, cr: any) => {
        let goal: GoalData | null = null;
        if (isAdmin && selectedVendor != null) {
            goal = (gr.items ?? []).find((i: any) => i.cod_vendedor === selectedVendor) ?? null;
        } else if (isAdmin) {
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
        setMeta({ holidays: gr.holidays ?? [], dias_habiles_source: gr.dias_habiles_source ?? 'auto', year: gr.year, month: gr.month });
        setRankingItems(gr.items ?? []);
        setTotales(gr.totales ?? null);
        setClientes(cr.items || []);
        setClientesStats(cr.stats);
        setSeleccion(cr.seleccion ?? null);
    };

    const load = async () => {
        const cacheKey = JSON.stringify({
            y: viewPeriod.year, m: viewPeriod.month, d: viewPeriod.asOfDay ?? null,
            sv: selectedVendor, c: cods, f: filter, l: localidad, si: showInactivos,
        });
        const cached = cacheRef.current.get(cacheKey);

        if (cached) {
            // Stale-while-revalidate: pintar inmediatamente, refresh en background.
            applyData(cached.gr, cached.cr);
            setErr(null);
        } else {
            setLoading(true); setErr(null);
        }

        // Cancelar request anterior: si el usuario cambia rápido entre meses,
        // los fetches viejos no van a pisar la UI con datos desactualizados.
        abortRef.current?.abort();
        const ctrl = new AbortController();
        abortRef.current = ctrl;

        try {
            const useSnapshot = viewPeriod.asOfDay != null;
            let gr: any, cr: any;
            if (useSnapshot) {
                // Snapshot intra-mes: 1 sola llamada que devuelve items + clientes ya con corte aplicado.
                const day = viewPeriod.asOfDay!;
                const asOfDate = `${viewPeriod.year}-${String(viewPeriod.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                const sp = new URLSearchParams();
                sp.set('year', String(viewPeriod.year));
                sp.set('month', String(viewPeriod.month));
                sp.set('asOfDate', asOfDate);
                if (showInactivos || (isAdmin && selectedVendor != null)) sp.set('incluir_inactivos', 'true');
                if (isAdmin && selectedVendor != null) sp.set('cod_vendedor', String(selectedVendor));
                else if (isAdmin && cods) sp.set('cods', cods);
                const snap = await fetch(`/api/goals/snapshot?${sp.toString()}`, { headers: authHeaders(), signal: ctrl.signal }).then(r => r.json());
                if (!snap.ok) throw new Error(snap.error);
                // Adapta el response del snapshot al shape que usa el resto del componente.
                gr = snap;
                // Stats client-side (el snapshot no las calcula)
                const items = snap.clientes ?? [];
                const normLocClient = (s: string | null | undefined): string => {
                    if (!s) return '';
                    return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase().replace(/\s+/g, ' ');
                };
                const prettyLocClient = (s: string): string => {
                    return s.toLowerCase().replace(/(^|\s|-)(\w)/g, (_m: string, pre: string, ch: string) => pre + ch.toUpperCase());
                };
                const localidades: any[] = [];
                const locMap = new Map<string, any>();
                items.forEach((it: any) => {
                    const key = it.localidad_norm || '__sin_localidad__';
                    const display = it.localidad_norm ? prettyLocClient(it.localidad_norm) : 'Sin localidad';
                    if (!locMap.has(key)) locMap.set(key, { localidad: display, count: 0, total_objetivo: 0, total_avance: 0, completados: 0 });
                    const l = locMap.get(key)!;
                    l.count++;
                    l.total_objetivo += it.objetivo_mes ?? 0;
                    l.total_avance += it.avance;
                    if (it.status === 'completado') l.completados++;
                });
                Array.from(locMap.values()).sort((a, b) => b.total_objetivo - a.total_objetivo).forEach(l => localidades.push(l));
                const totalObjetivo = items.reduce((a: number, i: any) => a + (i.objetivo_mes ?? 0), 0);
                const totalAvance = items.reduce((a: number, i: any) => a + i.avance, 0);
                const stats = {
                    total_clientes: items.length,
                    con_objetivo: items.filter((i: any) => i.objetivo_mes != null).length,
                    completados: items.filter((i: any) => i.status === 'completado').length,
                    parciales: items.filter((i: any) => i.status === 'parcial').length,
                    sin_compras: items.filter((i: any) => i.status === 'sin_compras').length,
                    sin_objetivo: items.filter((i: any) => i.status === 'sin_objetivo').length,
                    total_objetivo: totalObjetivo,
                    total_avance: totalAvance,
                    pct_equipo: totalObjetivo > 0 ? totalAvance / totalObjetivo : null,
                    localidades,
                };
                // Filtros client-side (status + localidad)
                const locFilterNorm = normLocClient(localidad);
                const selObjetivo = items.filter((i: any) => !locFilterNorm || i.localidad_norm === locFilterNorm).reduce((a: number, i: any) => a + (i.objetivo_mes ?? 0), 0);
                const selAvance = items.filter((i: any) => !locFilterNorm || i.localidad_norm === locFilterNorm).reduce((a: number, i: any) => a + i.avance, 0);
                const selNumComp = items.filter((i: any) => !locFilterNorm || i.localidad_norm === locFilterNorm).reduce((a: number, i: any) => a + (i.num_comprobantes ?? 0), 0);
                const filteredItems = items.filter((it: any) => {
                    if (locFilterNorm && it.localidad_norm !== locFilterNorm) return false;
                    if (filter === 'completado') return it.status === 'completado';
                    if (filter === 'bajo_objetivo') return it.status === 'sin_compras' || it.status === 'parcial';
                    if (filter === 'sin_compras') return it.status === 'sin_compras';
                    if (filter === 'sin_objetivo') return it.status === 'sin_objetivo';
                    return true;
                });
                cr = {
                    ok: true,
                    items: filteredItems,
                    stats,
                    seleccion: {
                        localidad: locFilterNorm ? prettyLocClient(locFilterNorm) : null,
                        total_clientes: filteredItems.length,
                        con_objetivo: filteredItems.filter((i: any) => i.objetivo_mes != null).length,
                        total_objetivo: selObjetivo,
                        total_avance: selAvance,
                        num_comprobantes: selNumComp,
                        pct: selObjetivo > 0 ? selAvance / selObjetivo : null,
                    },
                };
            } else {
                // Mes completo (sin corte intra-mes): camino tradicional con 2 endpoints.
                const qs = new URLSearchParams({ filter });
                qs.set('year', String(viewPeriod.year));
                qs.set('month', String(viewPeriod.month));
                if (localidad) qs.set('localidad', localidad);
                if (isAdmin && selectedVendor != null) qs.set('cod_vendedor', String(selectedVendor));
                else if (isAdmin && cods) qs.set('cods', cods);
                const goalsParams = new URLSearchParams();
                goalsParams.set('year', String(viewPeriod.year));
                goalsParams.set('month', String(viewPeriod.month));
                if (showInactivos || (isAdmin && selectedVendor != null)) goalsParams.set('incluir_inactivos', 'true');
                [gr, cr] = await Promise.all([
                    fetch(`/api/goals?${goalsParams.toString()}`, { headers: authHeaders(), signal: ctrl.signal }).then(r => r.json()),
                    fetch(`/api/goals/clientes?${qs.toString()}`, { headers: authHeaders(), signal: ctrl.signal }).then(r => r.json()),
                ]);
                if (!gr.ok) throw new Error(gr.error);
                if (!cr.ok) throw new Error(cr.error);
            }
            // Si el request fue cancelado mientras esperábamos, descartamos
            // este resultado para no pisar la UI con un período viejo.
            if (ctrl.signal.aborted) return;
            cacheRef.current.set(cacheKey, { gr, cr });
            applyData(gr, cr);
        } catch (e: any) {
            // Aborts no son errores reales, solo indican que el usuario
            // cambió de período antes que terminara el fetch.
            if (e?.name === 'AbortError' || ctrl.signal.aborted) return;
            // Solo mostramos error si no había cache: con cache, el usuario ya
            // ve datos válidos (aunque viejos) y el error de red es transitorio.
            if (!cached) setErr(e.message);
        } finally {
            if (!ctrl.signal.aborted) setLoading(false);
        }
    };
    useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filter, localidad, selectedVendor, cods, showInactivos, reloadTick, viewPeriod.year, viewPeriod.month, viewPeriod.asOfDay]);

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
                <p>
                    <span className="dot" /> {monthName(viewPeriod.month)} {viewPeriod.year}
                    {viewPeriod.asOfDay
                        ? <> · <strong>corte al día {viewPeriod.asOfDay}</strong> · día hábil {g.dias_habiles_transcurridos} de {g.dias_habiles_total}</>
                        : isHistoricMode
                            ? <> · <strong>cierre histórico</strong></>
                            : <> · {g.dias_habiles_transcurridos}/{g.dias_habiles_total} días · {g.dias_restantes} restantes</>}
                </p>
                <button
                    type="button"
                    className="vs-print-btn"
                    onClick={() => setShowPrint(true)}
                    title="Vista para imprimir / Descargar PDF"
                >
                    <FileText size={14} /> Imprimir / PDF
                </button>
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
                        <span className="eyebrow">
                            {isLocFilter ? 'OBJETIVO · LOCALIDAD'
                                : (isAdmin && selectedVendor != null) ? 'OBJETIVO DEL VENDEDOR'
                                    : isAdmin ? 'OBJETIVO DEL EQUIPO'
                                        : 'OBJETIVO DEL MES'}
                        </span>
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
                                            title={isHistoricMode ? `Editar target de ${monthName(viewPeriod.month)} ${viewPeriod.year}` : 'Editar target'}>
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

                {!isHistoricMode && (
                    <button className="vs-goal-refresh" onClick={syncNow} disabled={syncing}>
                        {syncing ? <><Loader2 size={12} className="spin" /> Sincronizando…</> : <><RefreshCw size={12} /> Actualizar avance</>}
                    </button>
                )}
            </div>

            {/* ─── Ranking equipo (admin sin filtro) ─── */}
            {isAdmin && selectedVendor == null && !isLocFilter && rankingItems.length > 0 && (
                <RankingEquipo items={rankingItems} />
            )}

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
                    {clientesFiltered.map(c => (
                        <ClienteObjetivoCard
                            key={c.cod_cliente}
                            c={c}
                            isOpen={openCliObj === c.cod_cliente}
                            onToggle={() => setOpenCliObj(p => p === c.cod_cliente ? null : c.cod_cliente)}
                        />
                    ))}
                </div>
            </div>

            {showPrint && (
                <PrintAvanceView
                    period={viewPeriod}
                    isHistoric={isHistoricMode}
                    diasHabilesTotal={g.dias_habiles_total}
                    diasHabilesTranscurridos={g.dias_habiles_transcurridos}
                    diasRestantes={g.dias_restantes}
                    totales={totales ? {
                        target: Number(totales.target) || 0,
                        avance: Number(totales.avance) || 0,
                        pct: totales.pct ?? null,
                        proyeccion: Number(totales.proyeccion) || 0,
                        vendedoresConTarget: totales.vendedores_con_target ?? 0,
                        vendedoresTotal: totales.vendedores_total ?? rankingItems.length,
                    } : null}
                    vendedores={rankingItems.map((it: any) => ({
                        cod_vendedor: it.cod_vendedor,
                        nombre: it.nombre,
                        target_neto: it.target_neto,
                        avance: it.avance,
                        pct_cumplimiento: it.pct_cumplimiento,
                        proyeccion: it.proyeccion,
                        necesario_por_dia: it.necesario_por_dia,
                        num_comprobantes: it.num_comprobantes,
                        activo: it.activo,
                    }))}
                    clientesTop={clientes
                        .filter(c => c.objetivo_mes != null && c.objetivo_mes > 0)
                        .sort((a, b) => (b.objetivo_mes ?? 0) - (a.objetivo_mes ?? 0))
                        .slice(0, 30)
                        .map(c => ({
                            cod_cliente: c.cod_cliente,
                            razon_social: c.razon_social ?? null,
                            localidad: c.localidad ?? null,
                            cod_vendedor: c.cod_vendedor ?? null,
                            objetivo_mes: c.objetivo_mes,
                            avance: c.avance,
                            pct_cumplimiento: c.pct_cumplimiento,
                            status: c.status,
                        }))}
                    filtroLabel={
                        isAdmin && selectedVendor != null
                            ? `Vendedor cod ${selectedVendor}`
                            : (localidad ? `Localidad: ${localidad}` : null)
                    }
                    onClose={() => setShowPrint(false)}
                />
            )}
        </div>
    );
}

// Cache compartido del historial por cod_cliente, a nivel de módulo (vive
// mientras la pestaña esté abierta). Permite que volver a un cliente ya
// visitado sea instantáneo y sin pegarle al server. TTL 5min alineado con el
// cache del backend. Cada card lee de acá al montar; si hay hit válido,
// arranca con la data ya cargada (sin spinner, sin fetch).
const HIST_CACHE_TTL_MS = 5 * 60 * 1000;
const histComprasCache = new Map<number, { data: HistorialComprasResponse; expiresAt: number }>();

function ClienteObjetivoCard({ c, isOpen, onToggle }: { c: ClienteObjetivo; isOpen: boolean; onToggle: () => void }) {
    const pct = c.pct_cumplimiento ?? 0;
    const barPct = Math.min(100, pct * 100);
    const statusCfg = {
        completado: { label: 'Completado', color: '#06652F' },
        parcial: { label: 'En curso', color: '#EEC045' },
        sin_compras: { label: 'Sin compras', color: '#A83E2B' },
        sin_objetivo: { label: 'Sin objetivo', color: '#6B7280' },
    }[c.status];

    const hasInfoComercial = c.direccion || c.cond_pago || c.hoja_ruta || c.repartidor || c.dia_entrega || c.notas;
    const hasHistorico = c.fact_mes_pasado != null || c.fact_prom_3m != null || c.saldo_cta_cte != null;
    const canExpand = true;

    const cachedHist = histComprasCache.get(c.cod_cliente);
    const cachedValid = cachedHist && cachedHist.expiresAt > Date.now() ? cachedHist.data : null;

    const [histLoading, setHistLoading] = useState(false);
    const [histErr, setHistErr] = useState<string | null>(null);
    const [histData, setHistData] = useState<HistorialComprasResponse | null>(cachedValid);
    const [histRequested, setHistRequested] = useState(!!cachedValid);

    const loadHist = async () => {
        setHistLoading(true);
        setHistErr(null);
        // Dos intentos:
        //  1) Timeout 15s — cache caliente.
        //  2) Si el primero aborta, reintento silencioso con 50s para dar
        //     margen al prewarm post-deploy (los 6 meses tardan ~1min cold).
        async function tryFetch(timeoutMs: number) {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), timeoutMs);
            try {
                const res = await fetch(
                    `/api/clientes/${c.cod_cliente}/historial-compras?meses=3`,
                    { headers: authHeaders(), signal: ctrl.signal },
                );
                const j = await res.json();
                if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
                return j;
            } finally {
                clearTimeout(timer);
            }
        }
        try {
            let data;
            try {
                data = await tryFetch(15_000);
            } catch (e: any) {
                if (e?.name === 'AbortError') {
                    data = await tryFetch(50_000);
                } else {
                    throw e;
                }
            }
            histComprasCache.set(c.cod_cliente, { data, expiresAt: Date.now() + HIST_CACHE_TTL_MS });
            setHistData(data);
        } catch (e: any) {
            const isAbort = e?.name === 'AbortError';
            setHistErr(isAbort ? 'El servidor está cargando datos. Probá en 30 segundos.' : (e.message || 'Error al cargar'));
        } finally {
            setHistLoading(false);
        }
    };

    useEffect(() => {
        if (isOpen && !histRequested) {
            setHistRequested(true);
            loadHist();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);

    return (
        <div className={`vs-cliente-obj ${isOpen ? 'is-open' : ''} ${canExpand ? 'is-expandable' : ''}`}>
            <div className="vs-cliente-obj-head" onClick={canExpand ? onToggle : undefined}>
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

            {isOpen && canExpand && (
                <div className="vs-cliente-obj-detail">
                    {hasInfoComercial && (
                        <div className="vs-client-info-comercial">
                            <h4>Info comercial</h4>
                            {c.direccion && <div className="vs-info-row"><MapPin size={13} /><span>{c.direccion}</span></div>}
                            {c.repartidor && <div className="vs-info-row"><Truck size={13} /><span>Repartidor: <strong>{c.repartidor}</strong>{c.hoja_ruta ? ` · ruta ${c.hoja_ruta}` : ''}{c.dia_entrega ? ` · entrega ${c.dia_entrega}` : ''}</span></div>}
                            {c.cond_pago && <div className="vs-info-row"><DollarSign size={13} /><span>Pago: <strong>{c.cond_pago}</strong></span></div>}
                            {c.notas && <div className="vs-info-notes">💬 {c.notas}</div>}
                        </div>
                    )}

                    {histLoading && (
                        <div className="vs-historial-loading">
                            <Loader2 size={14} className="spin" /> Cargando historial…
                        </div>
                    )}
                    {histErr && (
                        <div className="vs-historial-error">
                            <span>{histErr}</span>
                            <button type="button" onClick={loadHist}>Reintentar</button>
                        </div>
                    )}
                    {histData && histData.facturas.length === 0 && (
                        <p className="vs-historial-empty-state">Sin compras registradas en los últimos 3 meses.</p>
                    )}
                    {histData && histData.facturas.length > 0 && (
                        <HistorialTabs c={c} histData={histData} hasHistorico={!!hasHistorico} />
                    )}
                </div>
            )}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// RANKING EQUIPO (admin)
// ═══════════════════════════════════════════════════════════════════════════
function RankingEquipo({ items }: { items: any[] }) {
    const { ranked, sinTarget } = useMemo(() => {
        const activos = items.filter((i: any) => i.activo !== false);
        const conTarget = activos
            .filter((i: any) => i.target_neto && i.target_neto > 0)
            .sort((a: any, b: any) => (b.pct_cumplimiento ?? 0) - (a.pct_cumplimiento ?? 0));
        const sin = activos.filter((i: any) => !i.target_neto || i.target_neto <= 0);
        return { ranked: conTarget, sinTarget: sin };
    }, [items]);

    if (ranked.length === 0 && sinTarget.length === 0) return null;

    const medals = ['🥇', '🥈', '🥉'];

    return (
        <div className="vs-ranking">
            <div className="vs-ranking-head">
                <h2>Ranking del equipo</h2>
                <p>Ordenado por % de cumplimiento · sólo vendedores activos</p>
            </div>

            <div className="vs-ranking-list">
                {ranked.map((v: any, idx: number) => {
                    const pct = v.pct_cumplimiento ?? 0;
                    const pctPct = Math.min(200, pct * 100);
                    const barPct = Math.min(100, pct * 100);
                    const colorClass = pct >= 0.9 ? 'ok' : pct >= 0.5 ? 'mid' : 'low';
                    const medal = idx < 3 ? medals[idx] : null;
                    return (
                        <div key={v.cod_vendedor} className={`vs-ranking-row vs-ranking-row--${colorClass}`}>
                            <div className="vs-ranking-pos">
                                {medal ? <span className="medal">{medal}</span> : <span className="num">#{idx + 1}</span>}
                            </div>
                            <div className="vs-ranking-body">
                                <div className="vs-ranking-row1">
                                    <strong>{v.nombre}</strong>
                                    <span className="vs-ranking-pct">{Math.round(pctPct)}%</span>
                                </div>
                                <div className="vs-ranking-bar">
                                    <div className="vs-ranking-bar-fill" style={{ width: `${barPct}%` }} />
                                </div>
                                <div className="vs-ranking-row2">
                                    <span>{formatMoney(v.avance)} / {formatMoney(v.target_neto)}</span>
                                    <span className="vs-ranking-proy">proy {formatMoney(v.proyeccion)}</span>
                                </div>
                            </div>
                        </div>
                    );
                })}

                {sinTarget.map((v: any) => (
                    <div key={v.cod_vendedor} className="vs-ranking-row vs-ranking-row--notarget">
                        <div className="vs-ranking-pos"><span className="num">—</span></div>
                        <div className="vs-ranking-body">
                            <div className="vs-ranking-row1">
                                <strong>{v.nombre}</strong>
                                <span className="vs-ranking-notarget">sin target</span>
                            </div>
                            <div className="vs-ranking-row2">
                                <span>{formatMoney(v.avance)} vendidos · {v.num_comprobantes} comp.</span>
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTIVIDAD VIEW
// ═══════════════════════════════════════════════════════════════════════════
function ActividadView({ vendedorKey: _vendedorKey, clientNameMap, selectedVendor, cods, isAdmin, vendedoresList, pendingNew, onPendingConsumed }:
    {
        vendedorKey: string | null; clientNameMap: Record<string, any>;
        selectedVendor: number | null; cods: string; isAdmin: boolean;
        vendedoresList: Array<{ cod_vendedor: number; nombre: string; activo: boolean }>;
        pendingNew: { cod_cliente?: string; name?: string } | null;
        onPendingConsumed: () => void;
    }) {
    const [items, setItems] = useState<ActivityItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState<string | null>(null);
    const [showNew, setShowNew] = useState<{ cod_cliente?: string; name?: string } | null>(null);
    const [editing, setEditing] = useState<ActivityItem | null>(null);
    const me = getUser();
    const myEmail = me?.email ?? '';

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

    const deleteItem = async (id: string) => {
        if (!confirm('¿Borrar esta actividad?')) return;
        const res = await fetch(`/api/activity/${id}`, { method: 'DELETE', headers: authHeaders() });
        if (res.ok) load();
        else {
            const j = await res.json().catch(() => ({}));
            alert(j.error || 'Error al borrar');
        }
    };

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
                    {list.map(it => {
                        const canMutate = isAdmin || (it.created_by_email != null && it.created_by_email === myEmail);
                        return (
                            <FeedItem key={it.id} item={it}
                                clientName={it.cod_cliente ? clientNameMap[String(it.cod_cliente)]?.['Razon Social'] : null}
                                onEdit={canMutate ? () => setEditing(it) : undefined}
                                onDelete={canMutate ? () => deleteItem(it.id) : undefined}
                            />
                        );
                    })}
                </div>
            ))}

            {/* FAB secundario específico de Actividad */}
            <button className="vs-fab-act" onClick={() => setShowNew({})}>
                <Plus size={22} />
            </button>

            {showNew && <ActivityFormInline
                mode="new"
                defaultClientCod={showNew.cod_cliente ?? ''}
                defaultClientName={showNew.name ?? ''}
                isAdmin={isAdmin}
                vendedoresList={vendedoresList}
                onClose={() => setShowNew(null)}
                onSaved={() => { setShowNew(null); load(); }}
            />}

            {editing && <ActivityFormInline
                mode="edit"
                initial={editing}
                defaultClientName={editing.cod_cliente ? clientNameMap[String(editing.cod_cliente)]?.['Razon Social'] : ''}
                isAdmin={isAdmin}
                vendedoresList={vendedoresList}
                onClose={() => setEditing(null)}
                onSaved={() => { setEditing(null); load(); }}
            />}
        </div>
    );
}

function FeedItem({ item, clientName, onEdit, onDelete }:
    {
        item: ActivityItem;
        clientName: string | null;
        onEdit?: () => void;
        onDelete?: () => void;
    }) {
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
                        {item.fecha_promesa && <span> · {item.fecha_promesa}{item.hora_promesa ? ` ${item.hora_promesa}` : ''}</span>}
                    </div>
                )}
                {/* Promesa sin monto pero con fecha: mostramos la fecha aparte. */}
                {item.tipo === 'promesa' && item.monto == null && item.fecha_promesa && (
                    <div className="vs-feed-recordatorio">
                        🔔 {item.fecha_promesa}{item.hora_promesa ? ` · ${item.hora_promesa}` : ''}
                    </div>
                )}
                {item.contenido && <div className="vs-feed-text">{item.contenido}</div>}
            </div>
            {(onEdit || onDelete) && (
                <div className="vs-feed-actions">
                    {onEdit && (
                        <button className="vs-feed-edit-btn" onClick={onEdit} aria-label="Editar" title="Editar">
                            <Pencil size={14} />
                        </button>
                    )}
                    {onDelete && (
                        <button className="vs-feed-del-btn" onClick={onDelete} aria-label="Borrar" title="Borrar">
                            <Trash2 size={14} />
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

function ActivityFormInline({ mode, initial, defaultClientCod, defaultClientName, isAdmin = false, vendedoresList = [], onClose, onSaved }:
    {
        mode: 'new' | 'edit';
        initial?: ActivityItem;
        defaultClientCod?: string;
        defaultClientName?: string;
        isAdmin?: boolean;
        vendedoresList?: Array<{ cod_vendedor: number; nombre: string; activo: boolean }>;
        onClose: () => void;
        onSaved: () => void;
    }) {
    const [tipo, setTipo] = useState<ActivityItem['tipo']>(initial?.tipo ?? 'nota');
    const [contenido, setContenido] = useState(initial?.contenido ?? '');
    const [monto, setMonto] = useState(initial?.monto != null ? String(initial.monto) : '');
    const [fechaPromesa, setFechaPromesa] = useState(initial?.fecha_promesa ?? '');
    // Hora opcional: "" = recordatorio "todo el día", "HH:MM" = hora específica.
    const [horaPromesa, setHoraPromesa] = useState(initial?.hora_promesa ?? '');
    // Solo admin/gerente lo edita. En edit, arranca con el cod del item.
    // En new, vacío: el backend obliga a admin a mandar cod_vendedor (validación en activity.ts).
    const [codVendedor, setCodVendedor] = useState<string>(initial?.cod_vendedor != null ? String(initial.cod_vendedor) : '');
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    const submit = async () => {
        setSaving(true); setErr(null);
        try {
            const body: any = {
                tipo,
                contenido: contenido || null,
                monto: monto ? Number(monto) : null,
                fecha_promesa: fechaPromesa || null,
                // Solo mandamos hora si hay fecha; sino el backend la guardaría huérfana.
                hora_promesa: fechaPromesa && horaPromesa ? horaPromesa : null,
            };
            if (mode === 'new') body.cod_cliente = defaultClientCod || null;
            // Admin elige a quién asignar. Vendedor no puede cambiarlo (el backend
            // ignora cod_vendedor si rol === 'vendedor'). En edit, solo lo mandamos
            // si admin cambió la selección (sino backend lo respeta intacto).
            if (isAdmin && codVendedor) body.cod_vendedor = Number(codVendedor);
            const url = mode === 'edit' ? `/api/activity/${initial!.id}` : '/api/activity';
            const method = mode === 'edit' ? 'PUT' : 'POST';
            const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body) });
            const j = await res.json();
            if (!res.ok || !j.ok) throw new Error(j.error);
            onSaved();
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
                    <h3>{mode === 'edit' ? 'Editar actividad' : 'Nueva actividad'}</h3>
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

                {/* Hora opcional: solo si hay fecha de recordatorio. Útil para llamadas
                    pautadas ("recordame el viernes a las 14:30"). NULL = todo el día. */}
                {tipo === 'promesa' && fechaPromesa && (
                    <label className="vs-newact-field">
                        <span>Hora <em className="vs-newact-opt">(opcional)</em></span>
                        <input type="time" value={horaPromesa} onChange={e => setHoraPromesa(e.target.value)} />
                    </label>
                )}

                {/* Admin/gerente: asignar a un vendedor específico. La lista viene del
                    state global del shell (ya cargada en /api/goals) para no pegar de nuevo. */}
                {isAdmin && vendedoresList.length > 0 && (
                    <label className="vs-newact-field">
                        <span>A nombre de</span>
                        <select value={codVendedor} onChange={e => setCodVendedor(e.target.value)}>
                            <option value="">— elegí vendedor —</option>
                            {vendedoresList.filter(v => v.activo).map(v => (
                                <option key={v.cod_vendedor} value={v.cod_vendedor}>{v.nombre}</option>
                            ))}
                        </select>
                    </label>
                )}

                {err && <div className="vs-error"><AlertCircle size={14} /> {err}</div>}

                <div className="vs-newact-actions">
                    <button className="vs-btn-sec" onClick={onClose} disabled={saving}>Cancelar</button>
                    <button className="vs-btn-primary" onClick={submit} disabled={saving}>
                        {saving ? <><Loader2 size={14} className="spin" /> Guardando…</> : (mode === 'edit' ? 'Guardar cambios' : 'Guardar')}
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

// Normaliza un número argentino a 10 u 11 dígitos locales (área + número), manejando:
// - Múltiples números separados por / , ; | " y " " ó " → toma el primero.
// - 0 inicial (ej. "0381"), prefijo país "+54", prefijo móvil internacional "9".
// - "15" prefix viejo sin código área → asume Tucumán (381). Con código área → lo quita.
// - "15" intermedio (ej. "381 15 4161064") → lo saca.
// Retorna null si no llega a 10-11 dígitos válidos.
function normalizeArgPhone(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const parts = String(raw).split(/[\/;|,]|\sy\s|\só\s/i).map(s => s.trim()).filter(Boolean);
    if (parts.length === 0) return null;
    let digits = parts[0].replace(/\D/g, '');
    if (!digits) return null;
    if (digits.startsWith('0') && digits.length >= 11) digits = digits.slice(1);
    if (digits.startsWith('54') && digits.length >= 12) digits = digits.slice(2);
    if (digits.startsWith('9') && digits.length === 11) digits = digits.slice(1);
    if (digits.startsWith('15') && digits.length === 9) digits = '381' + digits.slice(2);
    else if (digits.startsWith('15') && digits.length >= 10) digits = digits.slice(2);
    digits = digits.replace(/^(\d{2,4})15(\d{6,8})$/, '$1$2');
    if (digits.length < 10 || digits.length > 11) return null;
    return digits;
}

function telHref(raw: string | null | undefined): string | null {
    const n = normalizeArgPhone(raw);
    return n ? `tel:+54${n}` : null;
}

function waHref(raw: string | null | undefined): string | null {
    const n = normalizeArgPhone(raw);
    return n ? `https://wa.me/549${n}` : null;
}

function TopProductosCliente({ topImporte, topFrecuencia }: { topImporte: HistorialItemAgregado[]; topFrecuencia: HistorialItemAgregado[] }) {
    if (topImporte.length === 0 && topFrecuencia.length === 0) return null;

    return (
        <div className="vs-historial-top">
            <h4>Top productos · últimos 3 meses</h4>
            <div className="vs-historial-top-grid">
                <div className="vs-historial-top-col">
                    <h5>Top por $</h5>
                    {topImporte.length === 0 ? (
                        <p className="vs-historial-empty">—</p>
                    ) : (
                        <ol className="vs-historial-top-list">
                            {topImporte.map((a, idx) => (
                                <li key={`imp-${a.cod_articulo}`}>
                                    <span className="rank">{idx + 1}.</span>
                                    <span className="det">{a.detalle}</span>
                                    <span className="meta">{formatMoney(a.importe_total)} · {a.num_facturas} fact</span>
                                </li>
                            ))}
                        </ol>
                    )}
                </div>
                <div className="vs-historial-top-col">
                    <h5>Más habitual</h5>
                    {topFrecuencia.length === 0 ? (
                        <p className="vs-historial-empty">—</p>
                    ) : (
                        <ol className="vs-historial-top-list">
                            {topFrecuencia.map((a, idx) => (
                                <li key={`frec-${a.cod_articulo}`}>
                                    <span className="rank">{idx + 1}.</span>
                                    <span className="det">{a.detalle}</span>
                                    <span className="meta">{a.num_facturas} fact · {a.cantidad_total} u.</span>
                                </li>
                            ))}
                        </ol>
                    )}
                </div>
            </div>
        </div>
    );
}

function ComprasRecientesCliente({ facturas }: { facturas: HistorialFactura[] }) {
    const [verTodas, setVerTodas] = useState(false);
    const [openComp, setOpenComp] = useState<number | null>(null);
    const limite = 10;
    const mostradas = verTodas ? facturas : facturas.slice(0, limite);

    if (facturas.length === 0) return null;

    return (
        <div className="vs-historial-facturas">
            <h4>Compras recientes · últimos 3 meses</h4>
            <ul className="vs-historial-facturas-list">
                {mostradas.map(f => (
                    <li
                        key={f.id_comprobante}
                        className={`vs-factura-row ${f.tipo === 'NC' ? 'is-nc' : ''} ${openComp === f.id_comprobante ? 'is-open' : ''}`}
                    >
                        <button
                            type="button"
                            className="vs-factura-head"
                            onClick={() => setOpenComp(p => p === f.id_comprobante ? null : f.id_comprobante)}
                        >
                            <span className="fecha">{formatFechaCorta(f.fecha)}</span>
                            <span className="ref">
                                {f.tipo}{f.tipo_factura ? `-${f.tipo_factura}` : ''} {String(f.punto_venta).padStart(4, '0')}-{String(f.numero).padStart(8, '0')}
                            </span>
                            <span className="monto">{formatMoney(f.total_neto)}</span>
                        </button>
                        {openComp === f.id_comprobante && f.items.length > 0 && (
                            <ul className="vs-factura-items">
                                {f.items.map((it, idx) => (
                                    <li key={`${f.id_comprobante}-${idx}`}>
                                        <span className="det">{it.detalle}</span>
                                        <span className="cant">×{it.cantidad}</span>
                                        <span className="imp">{formatMoney(it.importe)}</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                        {openComp === f.id_comprobante && f.items.length === 0 && (
                            <p className="vs-factura-items-empty">Sin desglose disponible</p>
                        )}
                    </li>
                ))}
            </ul>
            {!verTodas && facturas.length > limite && (
                <button type="button" className="vs-historial-ver-todas" onClick={() => setVerTodas(true)}>
                    Ver todas ({facturas.length})
                </button>
            )}
        </div>
    );
}

function formatFechaCorta(iso: string): string {
    if (!iso || iso.length < 10) return iso ?? '';
    return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

type HistTab = 'atencion' | 'resumen' | 'productos' | 'compras';

function HistorialTabs({ c, histData, hasHistorico }: { c: ClienteObjetivo; histData: HistorialComprasResponse; hasHistorico: boolean }) {
    const alertasCount = (histData.alertas.cliente && histData.alertas.cliente.nivel !== null ? 1 : 0)
        + histData.alertas.productos.length;
    const tieneAlertas = alertasCount > 0;

    const [tab, setTab] = useState<HistTab>(tieneAlertas ? 'atencion' : 'resumen');

    return (
        <div className="vs-hist-tabs">
            <nav className="vs-hist-tabs-strip">
                {tieneAlertas && (
                    <button
                        type="button"
                        className={`vs-hist-tab vs-hist-tab--atencion ${tab === 'atencion' ? 'is-active' : ''}`}
                        onClick={() => setTab('atencion')}
                    >
                        ⚠ Atención <span className="vs-hist-tab-badge">{alertasCount}</span>
                    </button>
                )}
                <button type="button" className={`vs-hist-tab ${tab === 'resumen' ? 'is-active' : ''}`} onClick={() => setTab('resumen')}>
                    Resumen
                </button>
                <button type="button" className={`vs-hist-tab ${tab === 'productos' ? 'is-active' : ''}`} onClick={() => setTab('productos')}>
                    Productos
                </button>
                <button type="button" className={`vs-hist-tab ${tab === 'compras' ? 'is-active' : ''}`} onClick={() => setTab('compras')}>
                    Compras
                </button>
            </nav>

            <div className="vs-hist-tabs-content">
                {tab === 'atencion' && tieneAlertas && (
                    <AtencionCliente alertas={histData.alertas} />
                )}
                {tab === 'resumen' && (
                    <div className="vs-hist-resumen">
                        {hasHistorico && (
                            <div className="vs-client-historico">
                                {c.fact_mes_pasado != null && (
                                    <div><span className="k">Mes pasado</span><strong>{formatMoney(c.fact_mes_pasado)}</strong></div>
                                )}
                                {c.fact_prom_3m != null && (
                                    <div><span className="k">Prom. 3m</span><strong>{formatMoney(c.fact_prom_3m)}</strong></div>
                                )}
                                {c.saldo_cta_cte != null && (
                                    <div><span className="k">Saldo ctacte</span><strong>{formatMoney(c.saldo_cta_cte)}</strong></div>
                                )}
                            </div>
                        )}
                        <ComparacionTrimestre comp={histData.comparacion} />
                    </div>
                )}
                {tab === 'productos' && (
                    <TopProductosCliente topImporte={histData.top_importe} topFrecuencia={histData.top_frecuencia} />
                )}
                {tab === 'compras' && (
                    <ComprasRecientesCliente facturas={histData.facturas} />
                )}
            </div>
        </div>
    );
}

function AtencionCliente({ alertas }: { alertas: { cliente: HistorialAlertaCliente | null; productos: HistorialProductoAbandono[] } }) {
    const tieneCliente = alertas.cliente && alertas.cliente.nivel !== null;
    const productos = alertas.productos ?? [];
    if (!tieneCliente && productos.length === 0) return null;

    const nivelCard = alertas.cliente?.nivel === 'rojo' || productos.length >= 3 ? 'rojo' : 'amarillo';

    return (
        <div className={`vs-atencion vs-atencion--${nivelCard}`}>
            <h4>⚠ Atención</h4>
            <ul>
                {tieneCliente && alertas.cliente && (
                    <li>
                        <strong>Cliente sin comprar hace {alertas.cliente.dias_sin_comprar} días</strong>
                        <span> (suele comprar cada {Math.round(alertas.cliente.media_dias_entre_compras)} días)</span>
                    </li>
                )}
                {productos.slice(0, 5).map(p => (
                    <li key={p.cod_articulo}>
                        <strong>{p.detalle}</strong>
                        <span> — sin llevar hace {p.dias_sin_comprar} días (antes cada {Math.round(p.intervalo_medio_dias)})</span>
                    </li>
                ))}
                {productos.length > 5 && (
                    <li className="vs-atencion-more">y {productos.length - 5} producto{productos.length - 5 === 1 ? '' : 's'} más con caída</li>
                )}
            </ul>
        </div>
    );
}

function ComparacionTrimestre({ comp }: { comp: HistorialComparacion }) {
    // Si no hay base anterior o no hay nada en actual, no mostramos nada.
    if (comp.delta_pct === null) return null;
    const positivo = comp.delta_pct >= 0;
    const pct = Math.abs(comp.delta_pct * 100);
    const arrow = positivo ? '▲' : '▼';
    return (
        <div className={`vs-comparacion vs-comparacion--${positivo ? 'up' : 'down'}`}>
            <span className="vs-comparacion-label">vs trimestre anterior:</span>
            <span className="vs-comparacion-nums">
                {formatMoney(comp.anterior)} → {formatMoney(comp.actual)}
            </span>
            <span className="vs-comparacion-delta">
                {positivo ? '+' : '-'}{Math.round(pct)}% {arrow}
            </span>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// NOTIFICACIONES — promesas / recordatorios del vendedor
// ═══════════════════════════════════════════════════════════════════════════

interface NotifItem {
    id: string;
    cod_vendedor: number;
    cod_cliente: number | null;
    tipo: string;
    contenido: string | null;
    monto: number | null;
    fecha_promesa: string;
    hora_promesa: string | null;
    created_at: string;
    vencida: boolean;
    dias_relativos: number;
}

interface NotifAlerta {
    tipo: 'cliente_abandono' | 'producto_abandono';
    cod_cliente: number;
    razon_social: string;
    cod_vendedor: number;
    dias_sin_comprar: number;
    nivel?: 'amarillo' | 'rojo';
    media_dias?: number;
    cod_articulo?: number;
    detalle?: string;
    intervalo_medio_dias?: number;
}

function alertaId(a: NotifAlerta): string {
    return a.tipo === 'cliente_abandono'
        ? `alc-${a.cod_cliente}`
        : `alp-${a.cod_cliente}-${a.cod_articulo}`;
}

const NOTIF_READ_STORAGE_KEY = 'ctacte:notif:read';
const NOTIF_POLL_MS = 5 * 60 * 1000; // 5 min

function loadReadSet(): Set<string> {
    try {
        const raw = localStorage.getItem(NOTIF_READ_STORAGE_KEY);
        if (!raw) return new Set();
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? new Set<string>(arr) : new Set();
    } catch { return new Set(); }
}

function saveReadSet(s: Set<string>) {
    try { localStorage.setItem(NOTIF_READ_STORAGE_KEY, JSON.stringify(Array.from(s))); } catch { /* ignore */ }
}

function NotificacionesBell() {
    const [items, setItems] = useState<NotifItem[]>([]);
    const [alertas, setAlertas] = useState<NotifAlerta[]>([]);
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [readIds, setReadIds] = useState<Set<string>>(() => loadReadSet());

    const load = async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/notificaciones', { headers: authHeaders() });
            const j = await res.json();
            if (res.ok && j.ok) {
                setItems(j.items ?? []);
                setAlertas(j.alertas ?? []);
            }
        } catch { /* swallow — polling reintenta */ }
        finally { setLoading(false); }
    };

    useEffect(() => {
        load();
        const id = window.setInterval(load, NOTIF_POLL_MS);
        return () => window.clearInterval(id);
    }, []);

    const unreadItems = items.filter(i => !readIds.has(i.id)).length;
    const unreadAlertas = alertas.filter(a => !readIds.has(alertaId(a))).length;
    const unread = unreadItems + unreadAlertas;

    const markAllAsRead = () => {
        const next = new Set(readIds);
        items.forEach(i => next.add(i.id));
        alertas.forEach(a => next.add(alertaId(a)));
        setReadIds(next);
        saveReadSet(next);
    };

    const handleItemClick = (n: NotifItem) => {
        // Marcar leída
        const next = new Set(readIds);
        next.add(n.id);
        setReadIds(next);
        saveReadSet(next);
        // Abrir la tab Actividad con foco en el cliente (mismo evento que ya usa la app)
        if (n.cod_cliente) {
            window.dispatchEvent(new CustomEvent('vs-open-activity', {
                detail: { cod_cliente: String(n.cod_cliente), name: '' }
            }));
        }
        setOpen(false);
    };

    const handleAlertaClick = (a: NotifAlerta) => {
        const id = alertaId(a);
        const next = new Set(readIds);
        next.add(id);
        setReadIds(next);
        saveReadSet(next);
        // Reusamos vs-open-activity: abre la tab Actividad con foco en el
        // cliente — desde ahí el vendedor puede ver historial completo,
        // registrar llamada/visita o pasar a Objetivos para más detalle.
        window.dispatchEvent(new CustomEvent('vs-open-activity', {
            detail: { cod_cliente: String(a.cod_cliente), name: a.razon_social }
        }));
        setOpen(false);
    };

    const labelRelativo = (n: NotifItem): string => {
        const d = n.dias_relativos;
        // Si hay hora cargada, la sumamos para que el vendedor sepa cuándo exacto
        // ("Hoy 14:30" vs solo "Hoy"). El backend devuelve hora_promesa como "HH:MM" o null.
        const horaStr = n.hora_promesa ? ` ${n.hora_promesa}` : '';
        if (d === 0) return `Hoy${horaStr}`;
        if (d === 1) return `Mañana${horaStr}`;
        if (d === -1) return 'Venció ayer';
        if (d > 1) return `En ${d} días${horaStr}`;
        return `Vencida hace ${Math.abs(d)} días`;
    };

    return (
        <div className="vs-notif-wrap">
            <button
                className="vs-icon-btn vs-notif-btn"
                onClick={() => setOpen(o => !o)}
                title={unread > 0 ? `${unread} notificacion${unread === 1 ? '' : 'es'} sin leer` : 'Notificaciones'}
                aria-label="Notificaciones"
            >
                <Bell size={16} />
                {unread > 0 && <span className="vs-notif-badge">{unread > 9 ? '9+' : unread}</span>}
            </button>
            {open && (
                <>
                    <div className="vs-notif-scrim" onClick={() => setOpen(false)} />
                    <div className="vs-notif-panel" role="dialog">
                        <header className="vs-notif-head">
                            <strong>Notificaciones</strong>
                            {unread > 0 && (
                                <button type="button" className="vs-notif-mark" onClick={markAllAsRead}>
                                    Marcar todas leídas
                                </button>
                            )}
                        </header>
                        {loading && items.length === 0 && alertas.length === 0 && (
                            <div className="vs-notif-empty"><Loader2 size={14} className="spin" /> Cargando…</div>
                        )}
                        {!loading && items.length === 0 && alertas.length === 0 && (
                            <div className="vs-notif-empty">Sin novedades.</div>
                        )}
                        {alertas.length > 0 && (
                            <>
                                <div className="vs-notif-section">Atención</div>
                                <ul className="vs-notif-list">
                                    {alertas.map(a => {
                                        const id = alertaId(a);
                                        const isUnread = !readIds.has(id);
                                        const isRojo = a.tipo === 'cliente_abandono' && a.nivel === 'rojo';
                                        return (
                                            <li key={id} className={`vs-notif-item vs-notif-alerta ${isRojo ? 'is-rojo' : ''} ${isUnread ? 'is-unread' : ''}`}>
                                                <button type="button" className="vs-notif-item-btn" onClick={() => handleAlertaClick(a)}>
                                                    <span className="vs-notif-when">⚠ {a.razon_social}</span>
                                                    <span className="vs-notif-text">
                                                        {a.tipo === 'cliente_abandono'
                                                            ? `Sin comprar hace ${a.dias_sin_comprar} días (suele cada ${Math.round(a.media_dias ?? 0)})`
                                                            : `${a.detalle} — sin llevar hace ${a.dias_sin_comprar} días (antes cada ${Math.round(a.intervalo_medio_dias ?? 0)})`}
                                                    </span>
                                                </button>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </>
                        )}
                        {items.length > 0 && (
                            <>
                                {alertas.length > 0 && <div className="vs-notif-section">Recordatorios</div>}
                                <ul className="vs-notif-list">
                                    {items.map(n => {
                                        const isUnread = !readIds.has(n.id);
                                        return (
                                            <li key={n.id} className={`vs-notif-item ${n.vencida ? 'is-vencida' : ''} ${isUnread ? 'is-unread' : ''}`}>
                                                <button type="button" className="vs-notif-item-btn" onClick={() => handleItemClick(n)}>
                                                    <span className="vs-notif-when">{labelRelativo(n)}</span>
                                                    <span className="vs-notif-text">
                                                        {n.cod_cliente && <strong>#{n.cod_cliente} · </strong>}
                                                        {n.contenido || (n.monto != null ? `Promesa de pago $${n.monto.toLocaleString('es-AR')}` : 'Recordatorio sin descripción')}
                                                    </span>
                                                    {n.monto != null && (
                                                        <span className="vs-notif-monto">{formatMoney(n.monto)}</span>
                                                    )}
                                                </button>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
