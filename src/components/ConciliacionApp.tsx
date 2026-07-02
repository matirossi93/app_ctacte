import { useEffect, useMemo, useRef, useState } from 'react';
import {
    X, RefreshCw, Download, Loader2, AlertCircle, ChevronDown, ChevronRight,
    Search, Clock, Receipt, ExternalLink, Scale, ShieldAlert,
    Upload, FileSpreadsheet, CheckCircle2, AlertTriangle,
} from 'lucide-react';
import { authHeaders } from '../utils/auth';
import { formatCurrency, formatCurrency2 } from '../utils/formatters';
import './ConciliacionApp.css';

// ═══════════════════════════════════════════════════════════════════════════
// Panel Conciliación de cta cte (solo admin/gerente)
// Cruza EN VIVO el saldo de InfoManager con las cobranzas cargadas en la app
// que todavía no llegaron a IM ("en tránsito"). Reemplaza el cruce manual
// mensual carpeta-del-vendedor vs sistema.
// ═══════════════════════════════════════════════════════════════════════════

interface Props {
    onClose: () => void;
    /** Cierra este panel y abre la vista Recibos (para imputar los en tránsito). */
    onOpenRecibos?: () => void;
}

interface ComprobanteConc {
    tipo: string;
    numero: string;
    fecha: string;
    importe: number;
    pagado: number;
    saldo: number;
    dias: number | null;
}

interface ReciboTransitoConc {
    id: string;
    monto: number;
    fecha: string | null;
    status: string;
}

interface AnticipoConc {
    id: string;
    monto: number;
    fecha: string | null;
}

interface ClienteConc {
    cod_cliente: number;
    nombre: string;
    saldo_im: number;
    n_comprobantes: number;
    aging_dias: number | null;
    en_transito: number;
    saldo_ajustado: number;
    comprobantes: ComprobanteConc[];
    recibos_transito: ReciboTransitoConc[];
    /** Anticipos 'aprobado': NO restan — el backoffice los carga a mano en IM. */
    anticipos_aprobados: AnticipoConc[];
    /** Recibos caducados ([CADUCADO]): no restan, hay que depurarlos. */
    caducados: number;
}

interface VendedorConc {
    cod_vendedor: number;
    nombre: string;
    total_saldo_im: number;
    total_en_transito: number;
    total_ajustado: number;
    total_anticipos: number;
    clientes: ClienteConc[];
}

interface InternaConc {
    cod_cliente: number;
    nombre: string;
    saldo_im: number;
    n_comprobantes: number;
    en_transito: number;
    total_anticipos: number;
    caducados: number;
}

interface Totales {
    saldo_im: number;
    en_transito: number;
    ajustado: number;
    total_anticipos: number;
    caducados: number;
}

interface ConciliacionResponse {
    ok: boolean;
    cache_age_s: number;
    vendedores: VendedorConc[];
    internas: InternaConc[];
    totales: Totales;
}

// ─── Tipos del Cruce carpeta (espejo del JSON de /api/conciliacion/cruce) ────

interface TransitoAlCorte { monto: number; fecha: string | null; status: string }

interface MatchCruce {
    carpeta: string;
    sistema: string;
    cod_cliente: number;
    saldo_carpeta: number;
    saldo_sistema: number;
    dif: number;
    score: number;
    estado: 'CUADRA' | 'DIFERENCIA';
    tentativo?: boolean;
    transito_al_corte?: TransitoAlCorte[];
}

interface SoloCarpetaCruce {
    cliente: string;
    saldo: number;
    cross_vendedor?: { cod_cliente: number; nombre: string; saldo: number; vendedor: string; score: number };
}

interface SoloSistemaCruce { cod_cliente: number; nombre: string; saldo: number }

interface CruceVendedor {
    pestana: string;
    cod_vendedor: number;
    tentativo: boolean;
    total_carpeta: number;
    total_sistema: number;
    n_cuadra: number;
    n_diferencia: number;
    matches: MatchCruce[];
    solo_carpeta: SoloCarpetaCruce[];
    solo_sistema: SoloSistemaCruce[];
}

interface ResultadoCruce {
    ok: boolean;
    corte: string;
    tolerancia: number;
    corte_exacto: boolean;
    advertencia: string | null;
    vendedores: CruceVendedor[];
    internas: Array<{ cod_cliente: number; nombre: string; saldo: number }>;
    excluidas_por_fecha: Array<{ vendedor: string; fila: number; fecha: string; cliente: string; monto: number }>;
    sin_fecha: Array<{ vendedor: string; fila: number; cliente: string; monto: number; valor_fecha: string }>;
    pestanas_ignoradas: string[];
    totales: { carpeta: number; sistema: number; n_cuadra: number; n_diferencia: number; n_solo_carpeta: number; n_solo_sistema: number };
    download_token: string;
}

const STATUS_TRANSITO_LABEL: Record<string, string> = {
    pendiente_revision: 'Pendiente de revisión',
    error: 'Error al imputar — reprocesar',
};

const TOOLTIP_ANTICIPO = 'No se resta: verificá si ya fue cargado a mano en InfoManager';

function edadCache(s: number): string {
    if (s < 60) return 'recién actualizado';
    const m = Math.round(s / 60);
    return `datos de hace ${m} min`;
}

// Empresa fija en Casa Central (1) por ahora; BRS / San Juan próximamente.
const EMPRESA_CC = 1;

export const ConciliacionApp = ({ onClose, onOpenRecibos }: Props) => {
    // Modo del panel: "vivo" = saldos actuales; "cruce" = carpeta vs sistema.
    const [modo, setModo] = useState<'vivo' | 'cruce'>('vivo');
    const [data, setData] = useState<ConciliacionResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState<string | null>(null);
    const [search, setSearch] = useState('');
    const [openVendors, setOpenVendors] = useState<Set<number>>(new Set());
    const [openClient, setOpenClient] = useState<number | null>(null);
    const [exporting, setExporting] = useState(false);

    const load = async (refresh = false) => {
        setLoading(true);
        setErr(null);
        try {
            const res = await fetch(`/api/conciliacion?cod_empresa=${EMPRESA_CC}${refresh ? '&refresh=1' : ''}`, {
                headers: authHeaders(),
            });
            const j = await res.json().catch(() => ({}));
            if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
            setData(j);
        } catch (e: any) {
            setErr(e?.message ?? 'Error al cargar la conciliación');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { load(); /* al montar */ }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const exportar = async () => {
        setExporting(true);
        setErr(null);
        try {
            const res = await fetch(`/api/conciliacion/export?cod_empresa=${EMPRESA_CC}`, { headers: authHeaders() });
            if (!res.ok) {
                const j = await res.json().catch(() => ({}));
                throw new Error(j.error ?? `HTTP ${res.status}`);
            }
            const blob = await res.blob();
            const cd = res.headers.get('content-disposition') || '';
            const match = cd.match(/filename="([^"]+)"/);
            const fileName = match ? match[1] : `Conciliacion_CtaCte_emp${EMPRESA_CC}.xlsx`;
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (e: any) {
            setErr(e?.message ?? 'Error al exportar');
        } finally {
            setExporting(false);
        }
    };

    // Filtro por nombre/código. Con búsqueda activa los grupos se auto-expanden
    // y los vendedores sin coincidencias se ocultan.
    const q = search.trim().toLowerCase();
    const vendedoresFiltrados = useMemo(() => {
        if (!data) return [];
        if (!q) return data.vendedores;
        return data.vendedores
            .map(v => ({
                ...v,
                clientes: v.clientes.filter(c =>
                    c.nombre.toLowerCase().includes(q) || String(c.cod_cliente).includes(q)),
            }))
            .filter(v => v.clientes.length > 0);
    }, [data, q]);

    const internasFiltradas = useMemo(() => {
        if (!data) return [];
        if (!q) return data.internas;
        return data.internas.filter(i =>
            i.nombre.toLowerCase().includes(q) || String(i.cod_cliente).includes(q));
    }, [data, q]);

    // Totales de cabecera: sin búsqueda son los globales del backend; con
    // búsqueda activa se recalculan sobre los clientes filtrados para que las
    // tarjetas cuenten lo que se está viendo (antes quedaban los globales).
    const totalesVista: Totales | null = useMemo(() => {
        if (!data) return null;
        if (!q) return data.totales;
        const t: Totales = { saldo_im: 0, en_transito: 0, ajustado: 0, total_anticipos: 0, caducados: 0 };
        for (const v of vendedoresFiltrados) {
            for (const c of v.clientes) {
                t.saldo_im += c.saldo_im;
                t.en_transito += c.en_transito;
                t.total_anticipos += c.anticipos_aprobados.reduce((a, an) => a + an.monto, 0);
                t.caducados += c.caducados;
            }
        }
        t.ajustado = t.saldo_im - t.en_transito;
        return t;
    }, [data, q, vendedoresFiltrados]);

    const transitoInterno = useMemo(
        () => internasFiltradas.reduce((a, i) => a + i.en_transito, 0),
        [internasFiltradas],
    );

    const toggleVendor = (cod: number) => {
        setOpenVendors(prev => {
            const next = new Set(prev);
            if (next.has(cod)) next.delete(cod); else next.add(cod);
            return next;
        });
    };

    const agingBadge = (dias: number | null) => {
        if (dias == null) return null;
        const cls = dias > 60 ? 'conc-badge conc-badge--danger'
            : dias > 30 ? 'conc-badge conc-badge--warn'
            : 'conc-badge';
        return <span className={cls} title="Días de la factura viva más vieja">{dias}d</span>;
    };

    return (
        <div className="conc-overlay" role="dialog" aria-modal="true">
            <div className="conc-modal">
                <header className="conc-header">
                    <button className="conc-icon-btn" onClick={onClose} aria-label="Cerrar">
                        <X size={20} />
                    </button>
                    <h2><Scale size={17} /> Conciliación cta cte</h2>
                    <div className="conc-header-actions">
                        <select
                            className="conc-empresa-select"
                            defaultValue={EMPRESA_CC}
                            title="BRS y San Juan: próximamente"
                        >
                            <option value={1}>Casa Central</option>
                            <option value={2} disabled>San Martín (BRS) — próximamente</option>
                            <option value={3} disabled>San Juan — próximamente</option>
                        </select>
                        {modo === 'vivo' && (
                            <button className="conc-icon-btn" onClick={() => load(true)} disabled={loading} title="Actualizar desde InfoManager">
                                {loading ? <Loader2 size={16} className="conc-spin" /> : <RefreshCw size={16} />}
                            </button>
                        )}
                        {modo === 'vivo' && (
                            <button className="conc-btn-primary" onClick={exportar} disabled={exporting || loading || !data}>
                                {exporting ? <Loader2 size={15} className="conc-spin" /> : <Download size={15} />}
                                <span>Excel</span>
                            </button>
                        )}
                    </div>
                </header>

                <div className="conc-body">
                    {/* Switcher: panel en vivo vs cruce contra la carpeta física */}
                    <div className="conc-switch" role="tablist">
                        <button className={`conc-switch-btn ${modo === 'vivo' ? 'is-active' : ''}`} onClick={() => setModo('vivo')}>
                            En vivo
                        </button>
                        <button className={`conc-switch-btn ${modo === 'cruce' ? 'is-active' : ''}`} onClick={() => setModo('cruce')}>
                            <FileSpreadsheet size={13} /> Cruce carpeta
                        </button>
                    </div>

                    {modo === 'cruce' && <CruceCarpetaView />}

                    {modo === 'vivo' && err && <div className="conc-error"><AlertCircle size={16} /> {err}</div>}

                    {modo === 'vivo' && loading && !data && (
                        <div className="conc-loading">
                            <Loader2 size={26} className="conc-spin" />
                            <p>Consultando InfoManager… puede tardar unos segundos.</p>
                        </div>
                    )}

                    {modo === 'vivo' && data && totalesVista && (
                        <>
                            {/* Totales (recalculados sobre lo filtrado si hay búsqueda) */}
                            <div className="conc-totales">
                                <div className="conc-total-card">
                                    <span className="conc-total-label">Saldo según IM</span>
                                    <strong>{formatCurrency(totalesVista.saldo_im)}</strong>
                                </div>
                                <div className="conc-total-card conc-total-card--transit">
                                    <span className="conc-total-label">En tránsito (app)</span>
                                    <strong>{formatCurrency(totalesVista.en_transito)}</strong>
                                </div>
                                <div className="conc-total-card conc-total-card--adj">
                                    <span className="conc-total-label">Saldo ajustado</span>
                                    <strong>{formatCurrency(totalesVista.ajustado)}</strong>
                                </div>
                            </div>
                            <div className="conc-meta-row">
                                <span className="conc-cache-age"><Clock size={12} /> {edadCache(data.cache_age_s)}</span>
                                {q !== '' && <span className="conc-meta-hint">totales de la búsqueda</span>}
                                {totalesVista.total_anticipos > 0 && (
                                    <span className="conc-meta-hint conc-meta-hint--amber" title={TOOLTIP_ANTICIPO}>
                                        <ShieldAlert size={12} /> anticipos sin verificar: {formatCurrency(totalesVista.total_anticipos)}
                                    </span>
                                )}
                                {totalesVista.caducados > 0 && (
                                    <span className="conc-meta-hint" title="Recibos con más de 30 días sin imputar, marcados [CADUCADO] por el cron. No restan del saldo.">
                                        {totalesVista.caducados} recibo{totalesVista.caducados !== 1 ? 's' : ''} caducado{totalesVista.caducados !== 1 ? 's' : ''} sin depurar (no restan)
                                    </span>
                                )}
                            </div>

                            {/* Buscador */}
                            <div className="conc-search">
                                <Search size={16} />
                                <input
                                    type="text"
                                    placeholder="Buscar cliente por nombre o código…"
                                    value={search}
                                    onChange={e => setSearch(e.target.value)}
                                />
                                {search && (
                                    <button className="conc-search-clear" onClick={() => setSearch('')} aria-label="Limpiar búsqueda">
                                        <X size={14} />
                                    </button>
                                )}
                            </div>

                            {/* Grupos por vendedor */}
                            {vendedoresFiltrados.length === 0 && (
                                <p className="conc-empty">Sin resultados{q ? ` para “${search.trim()}”` : ''}.</p>
                            )}
                            {vendedoresFiltrados.map(v => {
                                const abierto = !!q || openVendors.has(v.cod_vendedor);
                                return (
                                    <section key={v.cod_vendedor} className="conc-vendor">
                                        <button className="conc-vendor-head" onClick={() => toggleVendor(v.cod_vendedor)}>
                                            {abierto ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                                            <span className="conc-vendor-name">{v.nombre}</span>
                                            <span className="conc-vendor-count">{v.clientes.length} clientes</span>
                                            <span className="conc-vendor-totals">
                                                <span title="Saldo IM">{formatCurrency(v.total_saldo_im)}</span>
                                                {v.total_en_transito > 0 && (
                                                    <span className="conc-transit" title="En tránsito">−{formatCurrency(v.total_en_transito)}</span>
                                                )}
                                                <strong title="Saldo ajustado">{formatCurrency(v.total_ajustado)}</strong>
                                            </span>
                                        </button>

                                        {abierto && (
                                            <div className="conc-clients">
                                                {v.clientes.map(c => (
                                                    <div key={c.cod_cliente} className="conc-client">
                                                        <button
                                                            className="conc-client-row"
                                                            onClick={() => setOpenClient(openClient === c.cod_cliente ? null : c.cod_cliente)}
                                                        >
                                                            <div className="conc-client-main">
                                                                <span className="conc-client-name">{c.nombre}</span>
                                                                <span className="conc-client-cod">#{c.cod_cliente} · {c.n_comprobantes} comp.</span>
                                                            </div>
                                                            <div className="conc-client-badges">
                                                                {agingBadge(c.aging_dias)}
                                                                {c.en_transito > 0 && (
                                                                    <span className="conc-badge conc-badge--transit" title="Cobranzas cargadas en la app aún no imputadas en IM (restan del saldo)">
                                                                        <Receipt size={11} /> {formatCurrency(c.en_transito)}
                                                                    </span>
                                                                )}
                                                                {c.anticipos_aprobados.length > 0 && (
                                                                    <span className="conc-badge conc-badge--amber" title={TOOLTIP_ANTICIPO}>
                                                                        <ShieldAlert size={11} /> anticipo — verificar en IM
                                                                    </span>
                                                                )}
                                                            </div>
                                                            <div className="conc-client-saldos">
                                                                <span className="conc-saldo-im" title="Saldo según IM">{formatCurrency(c.saldo_im)}</span>
                                                                <strong className={`conc-saldo-adj ${c.saldo_ajustado < 0 ? 'is-neg' : ''}`} title="Saldo ajustado (IM − tránsito)">
                                                                    {formatCurrency(c.saldo_ajustado)}
                                                                </strong>
                                                            </div>
                                                        </button>

                                                        {openClient === c.cod_cliente && (
                                                            <div className="conc-client-detail">
                                                                {c.comprobantes.length > 0 && (
                                                                    <div className="conc-table-wrap">
                                                                        <table className="conc-table">
                                                                            <thead>
                                                                                <tr><th>Tipo</th><th>Número</th><th>Fecha</th><th>Importe</th><th>Pagado</th><th>Saldo</th><th>Días</th></tr>
                                                                            </thead>
                                                                            <tbody>
                                                                                {c.comprobantes.map((f, i) => (
                                                                                    <tr key={i}>
                                                                                        <td>{f.tipo}</td>
                                                                                        <td>{f.numero}</td>
                                                                                        <td>{f.fecha || '—'}</td>
                                                                                        <td className="num">{formatCurrency2(f.importe)}</td>
                                                                                        <td className="num">{formatCurrency2(f.pagado)}</td>
                                                                                        <td className={`num ${f.saldo < 0 ? 'is-neg' : ''}`}>{formatCurrency2(f.saldo)}</td>
                                                                                        <td className="num">{f.dias ?? '—'}</td>
                                                                                    </tr>
                                                                                ))}
                                                                            </tbody>
                                                                        </table>
                                                                    </div>
                                                                )}
                                                                {c.recibos_transito.length > 0 && (
                                                                    <div className="conc-transito-box">
                                                                        <h4><Receipt size={13} /> Cobranzas en tránsito (restan del saldo)</h4>
                                                                        {c.recibos_transito.map(r => (
                                                                            <div key={r.id} className="conc-transito-row">
                                                                                <span>{r.fecha ?? '—'}</span>
                                                                                <strong>{formatCurrency2(r.monto)}</strong>
                                                                                <span className={`conc-transito-status is-${r.status}`}>
                                                                                    {STATUS_TRANSITO_LABEL[r.status] ?? r.status}
                                                                                </span>
                                                                            </div>
                                                                        ))}
                                                                    </div>
                                                                )}
                                                                {c.anticipos_aprobados.length > 0 && (
                                                                    <div className="conc-anticipo-box" title={TOOLTIP_ANTICIPO}>
                                                                        <h4><ShieldAlert size={13} /> Anticipos aprobados — verificar en IM (no restan)</h4>
                                                                        {c.anticipos_aprobados.map(a => (
                                                                            <div key={a.id} className="conc-transito-row">
                                                                                <span>{a.fecha ?? '—'}</span>
                                                                                <strong>{formatCurrency2(a.monto)}</strong>
                                                                                <span className="conc-transito-status">cargado a mano en IM: verificá la cta cte antes de reclamar</span>
                                                                            </div>
                                                                        ))}
                                                                    </div>
                                                                )}
                                                                {c.caducados > 0 && (
                                                                    <p className="conc-caducados-hint">
                                                                        {c.caducados} recibo{c.caducados !== 1 ? 's' : ''} caducado{c.caducados !== 1 ? 's' : ''} (no restan) — depurar en Recibos.
                                                                    </p>
                                                                )}
                                                                {(c.recibos_transito.length > 0 || c.anticipos_aprobados.length > 0 || c.caducados > 0) && onOpenRecibos && (
                                                                    <button className="conc-link-btn" onClick={onOpenRecibos}>
                                                                        <ExternalLink size={13} /> Abrir Recibos
                                                                    </button>
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </section>
                                );
                            })}

                            {/* Internas / Sucursales */}
                            {internasFiltradas.length > 0 && (
                                <section className="conc-internas">
                                    <h3>Internas / Sucursales</h3>
                                    <p className="conc-internas-hint">
                                        Cuentas internas (no son clientes): quedan fuera de los totales de arriba.
                                        {transitoInterno > 0 && <> Tránsito interno: <strong>{formatCurrency(transitoInterno)}</strong>.</>}
                                    </p>
                                    {internasFiltradas.map(i => (
                                        <div key={i.cod_cliente} className="conc-interna-row">
                                            <div className="conc-client-main">
                                                <span className="conc-client-name">{i.nombre}</span>
                                                <span className="conc-client-cod">#{i.cod_cliente} · {i.n_comprobantes} comp.</span>
                                            </div>
                                            <div className="conc-client-badges">
                                                {i.en_transito > 0 && (
                                                    <span className="conc-badge conc-badge--transit" title="Cobranzas en la app sin imputar en IM">
                                                        <Receipt size={11} /> {formatCurrency(i.en_transito)}
                                                    </span>
                                                )}
                                                {i.total_anticipos > 0 && (
                                                    <span className="conc-badge conc-badge--amber" title={TOOLTIP_ANTICIPO}>
                                                        <ShieldAlert size={11} /> anticipo {formatCurrency(i.total_anticipos)}
                                                    </span>
                                                )}
                                                {i.caducados > 0 && (
                                                    <span className="conc-badge" title="Recibos caducados sin depurar (no restan)">
                                                        {i.caducados} caduc.
                                                    </span>
                                                )}
                                            </div>
                                            <strong className={i.saldo_im < 0 ? 'is-neg' : ''}>{formatCurrency(i.saldo_im)}</strong>
                                        </div>
                                    ))}
                                </section>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

// ═══════════════════════════════════════════════════════════════════════════
// CRUCE CARPETA — cruza el .xlsx del Sheet de la carpeta física contra la
// cta cte IM a una fecha de corte (snapshot exacto si existe).
// ═══════════════════════════════════════════════════════════════════════════

/** Último día del mes anterior (default natural: se concilia el mes cerrado). */
function ultimoDiaMesAnterior(): string {
    const t = new Date();
    const d = new Date(t.getFullYear(), t.getMonth(), 0);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function CruceCarpetaView() {
    const [corte, setCorte] = useState<string>(ultimoDiaMesAnterior);
    const [tolerancia, setTolerancia] = useState<string>('20');
    const [file, setFile] = useState<File | null>(null);
    const [snapshots, setSnapshots] = useState<string[]>([]);
    const [resultado, setResultado] = useState<ResultadoCruce | null>(null);
    const [cruzando, setCruzando] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const [openVend, setOpenVend] = useState<Set<number>>(new Set());
    const fileRef = useRef<HTMLInputElement>(null);

    // Fechas con snapshot: marcan qué cortes son EXACTOS (foto guardada ese día).
    useEffect(() => {
        let alive = true;
        fetch(`/api/conciliacion/snapshots?cod_empresa=${EMPRESA_CC}`, { headers: authHeaders() })
            .then(r => r.json())
            .then(j => { if (alive && j.ok && Array.isArray(j.fechas)) setSnapshots(j.fechas); })
            .catch(() => { /* silencioso: el hint queda en "aproximado" */ });
        return () => { alive = false; };
    }, []);

    const tieneSnapshot = snapshots.includes(corte);

    const cruzar = async () => {
        if (!file) { setErr('Elegí el archivo .xlsx del Sheet de la carpeta.'); return; }
        setCruzando(true);
        setErr(null);
        setResultado(null);
        try {
            const fd = new FormData();
            fd.append('file', file);
            fd.append('corte', corte);
            fd.append('tolerancia', tolerancia || '20');
            fd.append('cod_empresa', String(EMPRESA_CC));
            const res = await fetch('/api/conciliacion/cruce', { method: 'POST', headers: authHeaders(), body: fd });
            const j = await res.json().catch(() => ({}));
            if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
            setResultado(j);
            setOpenVend(new Set());
        } catch (e: any) {
            setErr(e?.message ?? 'Error al cruzar');
        } finally {
            setCruzando(false);
        }
    };

    const exportar = async () => {
        if (!resultado?.download_token) return;
        setExporting(true);
        try {
            const res = await fetch(`/api/conciliacion/cruce/export?token=${encodeURIComponent(resultado.download_token)}`, { headers: authHeaders() });
            if (!res.ok) {
                const j = await res.json().catch(() => ({}));
                throw new Error(j.error ?? `HTTP ${res.status}`);
            }
            const blob = await res.blob();
            const cd = res.headers.get('content-disposition') || '';
            const match = cd.match(/filename="([^"]+)"/);
            const fileName = match ? match[1] : `Cruce_Carpeta_${resultado.corte}.xlsx`;
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (e: any) {
            setErr(e?.message ?? 'Error al exportar');
        } finally {
            setExporting(false);
        }
    };

    const toggleVend = (cod: number) => {
        setOpenVend(prev => {
            const next = new Set(prev);
            if (next.has(cod)) next.delete(cod); else next.add(cod);
            return next;
        });
    };

    return (
        <div className="conc-cruce">
            {/* Formulario del cruce */}
            <div className="conc-cruce-form">
                <label className="conc-cruce-field">
                    <span>Fecha de corte</span>
                    <input type="date" value={corte} onChange={e => setCorte(e.target.value)} />
                    {corte && (
                        tieneSnapshot
                            ? <small className="conc-hint-ok"><CheckCircle2 size={12} /> hay snapshot: corte exacto</small>
                            : <small className="conc-hint-warn"><AlertTriangle size={12} /> sin snapshot: cruce aproximado con la foto actual</small>
                    )}
                </label>
                <label className="conc-cruce-field">
                    <span>Tolerancia ($)</span>
                    <input type="number" min="0" step="1" value={tolerancia} onChange={e => setTolerancia(e.target.value)} />
                    <small>diferencias hasta este monto cuentan como "cuadra"</small>
                </label>
                <label className="conc-cruce-field conc-cruce-file">
                    <span>Sheet de la carpeta (.xlsx)</span>
                    <input
                        ref={fileRef}
                        type="file"
                        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                        onChange={e => setFile(e.target.files?.[0] ?? null)}
                    />
                    <small>pestañas por vendedor: JULIO / MARCELO / SEBA / BRIAN / ANDREA</small>
                </label>
                <button className="conc-btn-primary conc-cruzar-btn" onClick={cruzar} disabled={cruzando || !file}>
                    {cruzando ? <Loader2 size={15} className="conc-spin" /> : <Upload size={15} />}
                    <span>{cruzando ? 'Cruzando…' : 'Cruzar'}</span>
                </button>
            </div>

            {err && <div className="conc-error"><AlertCircle size={16} /> {err}</div>}

            {resultado && (
                <>
                    {/* Banner de exactitud del corte */}
                    {resultado.corte_exacto ? (
                        <div className="conc-banner conc-banner--ok">
                            <CheckCircle2 size={15} /> Corte EXACTO al {resultado.corte} (snapshot guardado ese día).
                        </div>
                    ) : (
                        <div className="conc-banner conc-banner--warn">
                            <AlertTriangle size={15} /> {resultado.advertencia ?? 'Corte aproximado.'}
                        </div>
                    )}

                    {/* Tarjetas resumen */}
                    <div className="conc-totales">
                        <div className="conc-total-card">
                            <span className="conc-total-label">Total carpeta</span>
                            <strong>{formatCurrency(resultado.totales.carpeta)}</strong>
                        </div>
                        <div className="conc-total-card">
                            <span className="conc-total-label">Total sistema</span>
                            <strong>{formatCurrency(resultado.totales.sistema)}</strong>
                        </div>
                        <div className="conc-total-card conc-total-card--adj">
                            <span className="conc-total-label">Diferencia</span>
                            <strong>{formatCurrency(resultado.totales.carpeta - resultado.totales.sistema)}</strong>
                        </div>
                    </div>
                    <div className="conc-meta-row">
                        <span className="conc-meta-hint"><CheckCircle2 size={12} /> {resultado.totales.n_cuadra} cuadran</span>
                        <span className="conc-meta-hint conc-meta-hint--amber">{resultado.totales.n_diferencia} con diferencia</span>
                        <span className="conc-meta-hint">{resultado.totales.n_solo_carpeta} solo carpeta · {resultado.totales.n_solo_sistema} solo sistema</span>
                        <button className="conc-link-btn" onClick={exportar} disabled={exporting}>
                            {exporting ? <Loader2 size={13} className="conc-spin" /> : <Download size={13} />} Exportar Excel
                        </button>
                    </div>

                    {/* Excluidas por fecha — bien visible: puede ser typo de fecha */}
                    {resultado.excluidas_por_fecha.length > 0 && (
                        <div className="conc-banner conc-banner--warn">
                            <AlertTriangle size={15} />
                            <div>
                                <strong>{resultado.excluidas_por_fecha.length} fila{resultado.excluidas_por_fecha.length !== 1 ? 's' : ''} excluida{resultado.excluidas_por_fecha.length !== 1 ? 's' : ''} por fecha posterior al corte</strong> — revisar: puede ser typo de fecha.
                                <ul className="conc-banner-list">
                                    {resultado.excluidas_por_fecha.map((e, i) => (
                                        <li key={i}>{e.vendedor} · fila {e.fila}: {e.cliente} — {e.fecha} — {formatCurrency(e.monto)}</li>
                                    ))}
                                </ul>
                            </div>
                        </div>
                    )}
                    {resultado.sin_fecha.length > 0 && (
                        <div className="conc-banner conc-banner--info">
                            <AlertCircle size={15} />
                            <div>
                                {resultado.sin_fecha.length} fila{resultado.sin_fecha.length !== 1 ? 's' : ''} sin fecha parseable (incluidas en el cruce igual):
                                <ul className="conc-banner-list">
                                    {resultado.sin_fecha.map((s, i) => (
                                        <li key={i}>{s.vendedor} · fila {s.fila}: {s.cliente} — "{s.valor_fecha}" — {formatCurrency(s.monto)}</li>
                                    ))}
                                </ul>
                            </div>
                        </div>
                    )}

                    {/* Grupos por vendedor */}
                    {resultado.vendedores.map(v => {
                        const abierto = openVend.has(v.cod_vendedor);
                        const difs = v.matches.filter(m => m.estado === 'DIFERENCIA');
                        return (
                            <section key={v.cod_vendedor} className="conc-vendor">
                                <button className="conc-vendor-head" onClick={() => toggleVend(v.cod_vendedor)}>
                                    {abierto ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                                    <span className="conc-vendor-name">{v.pestana}</span>
                                    <span className="conc-vendor-count">
                                        {v.n_cuadra} ✓ · {v.n_diferencia} dif · {v.solo_carpeta.length}/{v.solo_sistema.length} solo
                                    </span>
                                    <span className="conc-vendor-totals">
                                        <span title="Total carpeta">{formatCurrency(v.total_carpeta)}</span>
                                        <strong title="Total sistema">{formatCurrency(v.total_sistema)}</strong>
                                    </span>
                                </button>

                                {abierto && (
                                    <div className="conc-cruce-detalle">
                                        {v.tentativo && (
                                            <div className="conc-banner conc-banner--warn conc-banner--inset">
                                                <AlertTriangle size={14} /> Cruce TENTATIVO: la carpeta de Andrea usa nombres de pila — verificar cada match a mano.
                                            </div>
                                        )}

                                        {difs.length > 0 && (
                                            <>
                                                <h4 className="conc-cruce-subtitulo">Diferencias ({difs.length})</h4>
                                                <div className="conc-table-wrap">
                                                    <table className="conc-table">
                                                        <thead>
                                                            <tr><th>Carpeta</th><th>Sistema</th><th>Saldo carpeta</th><th>Saldo sistema</th><th>Dif</th><th>Nota</th></tr>
                                                        </thead>
                                                        <tbody>
                                                            {difs.map((m, i) => (
                                                                <tr key={i}>
                                                                    <td>{m.carpeta}</td>
                                                                    <td>{m.sistema} <span className="conc-client-cod">#{m.cod_cliente}</span></td>
                                                                    <td className="num">{formatCurrency2(m.saldo_carpeta)}</td>
                                                                    <td className="num">{formatCurrency2(m.saldo_sistema)}</td>
                                                                    <td className={`num ${m.dif < 0 ? 'is-neg' : ''}`}>{formatCurrency2(m.dif)}</td>
                                                                    <td>
                                                                        {m.transito_al_corte?.length ? (
                                                                            <span className="conc-badge conc-badge--transit" title="Cobranzas cargadas en la app con fecha anterior al corte, aún sin imputar en IM — probablemente explican la diferencia">
                                                                                <Receipt size={11} /> {formatCurrency(m.transito_al_corte.reduce((a, t) => a + t.monto, 0))} en tránsito al corte
                                                                            </span>
                                                                        ) : m.tentativo ? <span className="conc-badge conc-badge--amber">tentativo</span> : null}
                                                                    </td>
                                                                </tr>
                                                            ))}
                                                        </tbody>
                                                    </table>
                                                </div>
                                            </>
                                        )}

                                        {v.solo_carpeta.length > 0 && (
                                            <>
                                                <h4 className="conc-cruce-subtitulo">Solo en carpeta ({v.solo_carpeta.length})</h4>
                                                {v.solo_carpeta.map((sc, i) => (
                                                    <div key={i} className="conc-cruce-solo-row">
                                                        <span className="conc-client-name">{sc.cliente}</span>
                                                        <strong>{formatCurrency2(sc.saldo)}</strong>
                                                        {sc.cross_vendedor && (
                                                            <span className="conc-badge conc-badge--warn" title={`Score ${sc.cross_vendedor.score}`}>
                                                                ¿es {sc.cross_vendedor.nombre} (#{sc.cross_vendedor.cod_cliente}) bajo {sc.cross_vendedor.vendedor}? {formatCurrency(sc.cross_vendedor.saldo)}
                                                            </span>
                                                        )}
                                                    </div>
                                                ))}
                                            </>
                                        )}

                                        {v.solo_sistema.length > 0 && (
                                            <>
                                                <h4 className="conc-cruce-subtitulo">Solo en sistema ({v.solo_sistema.length})</h4>
                                                {v.solo_sistema.map((s, i) => (
                                                    <div key={i} className="conc-cruce-solo-row">
                                                        <span className="conc-client-name">{s.nombre} <span className="conc-client-cod">#{s.cod_cliente}</span></span>
                                                        <strong>{formatCurrency2(s.saldo)}</strong>
                                                    </div>
                                                ))}
                                            </>
                                        )}

                                        {difs.length === 0 && v.solo_carpeta.length === 0 && v.solo_sistema.length === 0 && (
                                            <p className="conc-empty">Todo cuadra para este vendedor.</p>
                                        )}
                                    </div>
                                )}
                            </section>
                        );
                    })}

                    {/* Internas al corte */}
                    {resultado.internas.length > 0 && (
                        <section className="conc-internas">
                            <h3>Internas / Sucursales (saldo al corte)</h3>
                            <p className="conc-internas-hint">Fuera del cruce por vendedor.</p>
                            {resultado.internas.map(i => (
                                <div key={i.cod_cliente} className="conc-interna-row">
                                    <div className="conc-client-main">
                                        <span className="conc-client-name">{i.nombre}</span>
                                        <span className="conc-client-cod">#{i.cod_cliente}</span>
                                    </div>
                                    <strong className={i.saldo < 0 ? 'is-neg' : ''}>{formatCurrency(i.saldo)}</strong>
                                </div>
                            ))}
                        </section>
                    )}
                </>
            )}
        </div>
    );
}
