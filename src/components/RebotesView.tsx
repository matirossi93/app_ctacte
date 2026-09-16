import { useEffect, useRef, useState } from 'react';
import { PackageX, Loader2, AlertCircle, RefreshCw, DownloadCloud, ChevronRight, TrendingDown, TrendingUp } from 'lucide-react';
import { authHeaders } from '../utils/auth';
import { hoyArgentinaPartes } from '../utils/hoyArgentina';
import {
    agruparPorCliente, corteRelevante, claveCliente, grupoDeMotivo, mesAnterior,
    totalHastaDia, variacionPorc, MOTIVO_META, GRUPO_ORDER,
    type GrupoResponsable, type GrupoCliente, type RebotePlano,
} from '../utils/agruparRebotes';
import type { ViewPeriod } from './PeriodSelector';
import './RebotesView.css';

const MONTH_NAMES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

// La taxonomía de motivos (quién causó el rebote) vive en utils/agruparRebotes:
// la necesitan tanto la vista como la agrupación. Acá quedan solo los textos.
const GRUPO_META: Record<GrupoResponsable, { label: string; corto: string; sub: string }> = {
    vendedor: { label: 'Error del vendedor', corto: 'Vendedor', sub: '3% menos de comisión' },
    cliente: { label: 'Culpa del cliente', corto: 'Cliente', sub: '3% de recargo' },
    empresa: { label: 'Empresa / depósito', corto: 'Depósito', sub: 'sin cargo' },
    otro: { label: 'Sin clasificar', corto: 'Sin clasificar', sub: 'revisar en la planilla' },
};

interface RebotesRow extends RebotePlano {
    cod_articulo: number | null;
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
    recargo: number;
    reincidencia: number;
}

interface RecargosResponse {
    ok: boolean;
    rige: boolean;
    eventos: EventoRecargo[];
    resumen: {
        eventos: number;
        recargo_total: number;
        reincidentes: number;
    };
}

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

/** 3% de comisión que se le descuenta al vendedor por lo que rebotó por su error. */
const PCT_CARGO = 0.03;

export const RebotesView = ({ isAdmin, viewPeriod }: Props) => {
    const [data, setData] = useState<RebotesResponse | null>(null);
    const [recargos, setRecargos] = useState<RecargosResponse | null>(null);
    const [prevRows, setPrevRows] = useState<RebotesRow[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const [filtroGrupo, setFiltroGrupo] = useState<GrupoResponsable | null>(null);
    const [filtroVendedor, setFiltroVendedor] = useState<number | null>(null);
    const [verTodos, setVerTodos] = useState(false);
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
            // Mes anterior, solo para el "vs.": un total suelto no dice si el mes
            // viene bien o mal. Best-effort — si falla, se muestra sin comparación.
            try {
                const prev = mesAnterior(viewPeriod.year, viewPeriod.month);
                const res3 = await fetch(`/api/rebotes?year=${prev.year}&month=${prev.month}`, {
                    headers: authHeaders(), signal: ctrl.signal,
                });
                const j3 = await res3.json();
                setPrevRows(res3.ok && j3.ok ? j3.rows : null);
            } catch { setPrevRows(null); }
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

    // Cambiar de filtro o de mes vuelve a esconder la cola larga: si no, una
    // lista de 60 clientes reaparece sola cuando cambiás de vendedor.
    useEffect(() => { setVerTodos(false); }, [filtroGrupo, filtroVendedor, viewPeriod.year, viewPeriod.month]);

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

    // base = mes completo con corte de fecha y vendedor aplicados. Sobre esto
    // se calculan el total del resumen y los tiles; el tile activo filtra la
    // lista de clientes de abajo.
    const base = rows.filter(r =>
        (filtroVendedor == null || (r.cod_vendedor ?? -1) === filtroVendedor)
        && (asOfIso == null || r.fecha == null || r.fecha <= asOfIso),
    );
    const visibles = filtroGrupo == null ? base : base.filter(r => grupoDeMotivo(r.motivo) === filtroGrupo);

    const totalBase = Math.round(base.reduce((a, r) => a + (Number(r.total) || 0), 0) * 100) / 100;
    const totalVisible = Math.round(visibles.reduce((a, r) => a + (Number(r.total) || 0), 0) * 100) / 100;

    const porGrupo = new Map<GrupoResponsable, { filas: number; total: number }>();
    for (const r of base) {
        const g = grupoDeMotivo(r.motivo);
        const s = porGrupo.get(g) ?? { filas: 0, total: 0 };
        s.filas += 1; s.total += Number(r.total) || 0;
        porGrupo.set(g, s);
    }

    // ── Comparación con el mes pasado, mismo tramo ──
    // Si el mes es el actual, el mes anterior se corta al día de hoy: comparar
    // 16 días contra 31 diría "bajó a la mitad" cuando no bajó nada.
    const hoy = hoyArgentinaPartes();
    const esMesEnCurso = viewPeriod.year === hoy.year && viewPeriod.month === hoy.month;
    const diaCorte = viewPeriod.asOfDay ?? (esMesEnCurso ? hoy.day : null);
    const prev = mesAnterior(viewPeriod.year, viewPeriod.month);
    const totalPrev = prevRows == null ? null : totalHastaDia(
        prevRows.filter(r => filtroVendedor == null || (r.cod_vendedor ?? -1) === filtroVendedor),
        prev.year, prev.month, diaCorte,
    );
    const variacion = totalPrev == null ? null : variacionPorc(totalBase, totalPrev);

    // ── Agrupación por cliente ──
    // El recargo del 3% sale de los eventos que calcula el backend (no se
    // recalcula acá) y se pega al cliente por la misma clave que usa allá.
    const recargoPorCliente = new Map<string, number>();
    for (const e of recargos?.eventos ?? []) {
        if (asOfIso != null && e.fecha && e.fecha > asOfIso) continue;
        if (filtroVendedor != null && (e.cod_vendedor ?? -1) !== filtroVendedor) continue;
        const k = claveCliente(e.cod_cliente, e.cliente_raw);
        recargoPorCliente.set(k, Math.round(((recargoPorCliente.get(k) ?? 0) + e.recargo) * 100) / 100);
    }

    const grupos = agruparPorCliente(visibles, recargoPorCliente);
    const corte = corteRelevante(grupos);
    const enPantalla = verTodos ? grupos : corte.visibles;
    // Clientes del mes, sin el filtro del tile: el número grande de arriba es
    // el total del mes, así que su "de N clientes" también tiene que serlo.
    const clientesBase = new Set(base.map(r => claveCliente(r.cod_cliente, r.cliente_raw))).size;

    // El recargo pertenece al cliente por lo que rebotó POR SU CULPA: mostrarlo
    // mientras se está filtrando por "empresa" confundiría más de lo que aporta.
    const mostrarRecargo = (recargos?.rige ?? false) && (filtroGrupo == null || filtroGrupo === 'cliente');
    const descuentoVendedor = (recargos?.rige ?? false)
        ? Math.round((porGrupo.get('vendedor')?.total ?? 0) * PCT_CARGO * 100) / 100
        : 0;

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

            <p className="rb-explain">
                Mercadería que salió a reparto y <b>volvió sin entregarse</b>. Se carga día a día en la
                planilla de faltantes y acá se actualiza sola cada media hora.
            </p>

            {err && <div className="rb-error"><AlertCircle size={16} /> {err}</div>}

            {loading && !data && <div className="rb-loading"><Loader2 size={22} className="rb-spin" /> Cargando…</div>}

            {data && rows.length === 0 && !err && (
                <div className="rb-empty">
                    Sin rebotes cargados en {monthLabel}. Cuando se carguen en la planilla de faltantes, aparecen acá solos.
                </div>
            )}

            {data && rows.length > 0 && (
                <>
                    {/* ── 1. Cuánto rebotó, contra el mes pasado, y de quién fue la culpa ── */}
                    <div className="rb-card">
                        <div className="rb-hero">
                            <div className="rb-hero-line">
                                <span className="rb-hero-num">{fmtMoney(totalBase)}</span>
                                {variacion != null && (
                                    <span className={`rb-delta ${variacion <= 0 ? 'is-baja' : 'is-sube'}`}>
                                        {variacion <= 0 ? <TrendingDown size={13} /> : <TrendingUp size={13} />}
                                        {variacion > 0 ? '+' : ''}{variacion}%
                                    </span>
                                )}
                            </div>
                            <span className="rb-hero-label">
                                rebotado · {base.length} renglones de {clientesBase} cliente{clientesBase === 1 ? '' : 's'}
                                {asOfIso ? ` · al día ${viewPeriod.asOfDay}` : ''}
                            </span>
                            {variacion != null && totalPrev != null && (
                                <span className="rb-hero-vs">
                                    {MONTH_NAMES[prev.month - 1]}{diaCorte != null ? ` al día ${diaCorte}` : ''} había {fmtMoney(totalPrev)}
                                </span>
                            )}
                        </div>
                        <div className="rb-tiles">
                            {GRUPO_ORDER.map(g => {
                                const s = porGrupo.get(g);
                                if (!s) return null;
                                const meta = GRUPO_META[g];
                                const plata = g === 'vendedor' && descuentoVendedor > 0
                                    ? `−${fmtMoney(descuentoVendedor)} de comisión`
                                    : g === 'cliente' && (recargos?.resumen.recargo_total ?? 0) > 0
                                        ? `+${fmtMoney(recargos!.resumen.recargo_total)} de recargo`
                                        : meta.sub;
                                return (
                                    <button
                                        key={g}
                                        className={`rb-tile rb-tile--${g} ${filtroGrupo === g ? 'is-active' : ''}`}
                                        onClick={() => setFiltroGrupo(filtroGrupo === g ? null : g)}
                                        title="Tocá para ver solo estos rebotes"
                                    >
                                        <span className="rb-tile-label">{meta.label}</span>
                                        <span className="rb-tile-num">{fmtMoney(s.total)}</span>
                                        <span className="rb-tile-sub">{s.filas} renglones · {plata}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>

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

                    {/* ── 2. El 3% al cliente: la regla, sin repetir la lista ──
                        Cada cliente lleva su recargo en su propia fila, abajo. */}
                    {recargos?.rige && recargos.resumen.recargo_total > 0 && (
                        <div className="rb-nota">
                            <b>+{fmtMoney(recargos.resumen.recargo_total)}</b> en recargos del 3% ({recargos.resumen.eventos} rebote
                            {recargos.resumen.eventos === 1 ? '' : 's'} por culpa del cliente
                            {recargos.resumen.reincidentes > 0 ? `, ${recargos.resumen.reincidentes} repetido${recargos.resumen.reincidentes === 1 ? '' : 's'}` : ''}).
                            {' '}Por ahora es <b>solo un aviso</b>:{' '}
                            {isAdmin
                                ? 'cuando arranque el cobro se factura a mano en InfoManager.'
                                : 'mostrale el número a cada cliente para que entre todos bajemos los rebotes.'}
                        </div>
                    )}

                    {/* ── 3. Un renglón por cliente, del que más costó al que menos ── */}
                    <div className="rb-card">
                        <div className="rb-card-head">
                            <h3>Quién rebotó</h3>
                            <p>
                                {filtroGrupo == null
                                    ? <>Un cliente por línea, del que más plata devolvió al que menos. Tocá para ver qué volvió.</>
                                    : <>Solo <b>{GRUPO_META[filtroGrupo].label.toLowerCase()}</b>: {visibles.length} renglones · {fmtMoney(totalVisible)} — tocá el recuadro de arriba para ver todo.</>}
                            </p>
                        </div>

                        {isAdmin && vendedores.size > 1 && (
                            <div className="rb-chips">
                                <span className="rb-chips-label">Vendedor:</span>
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

                        {enPantalla.length === 0 ? (
                            <div className="rb-empty rb-empty--inline">Nada que mostrar con estos filtros.</div>
                        ) : (
                            <div className="rb-groups">
                                {enPantalla.map(g => (
                                    <GrupoRow
                                        key={g.clave}
                                        g={g}
                                        isAdmin={isAdmin}
                                        mostrarRecargo={mostrarRecargo}
                                        mostrarVendedor={vendedores.size > 1 && filtroVendedor == null}
                                    />
                                ))}
                            </div>
                        )}

                        {corte.ocultos.length > 0 && (
                            <button className="rb-more" onClick={() => setVerTodos(v => !v)}>
                                {verTodos
                                    ? 'Mostrar solo los que explican el 80%'
                                    : `Ver los otros ${corte.ocultos.length} clientes · ${fmtMoney(corte.totalOculto)}`}
                            </button>
                        )}
                    </div>
                </>
            )}

            {data?.resumen.ultima_sync && (
                <div className="rb-foot">
                    Última sincronización con el sheet: {new Date(data.resumen.ultima_sync).toLocaleString('es-AR', { timeZone: 'America/Argentina/Tucuman' })}
                </div>
            )}
        </div>
    );
};

/** Un cliente colapsado: cuánto, cuántas veces y de quién fue. Se abre al tocarlo. */
const GrupoRow = ({ g, isAdmin, mostrarRecargo, mostrarVendedor }: {
    g: GrupoCliente;
    isAdmin: boolean;
    mostrarRecargo: boolean;
    mostrarVendedor: boolean;
}) => {
    const veces = g.dias.length;
    return (
        <details className="rb-g">
            <summary className="rb-g-head">
                <ChevronRight size={14} className="rb-g-chev" />
                <div className="rb-g-main">
                    <div className="rb-g-line">
                        <span className="rb-g-cliente">
                            {g.cliente}
                            {isAdmin && g.cod_cliente == null && <span className="rb-dot" title="Sin match con maestro IM">●</span>}
                        </span>
                        <span className="rb-g-total">{fmtMoney(g.total)}</span>
                    </div>
                    <div className="rb-g-line rb-g-meta">
                        <span className="rb-g-tags">
                            {veces > 1 && <span className="rb-veces" title="Días distintos con rebote en el mes">{veces} rebotes</span>}
                            {/* Solo el responsable que explica más plata: dos o tres badges
                                comen la línea entera y tapan la fecha. El resto, al desplegar. */}
                            <span className={`rb-badge rb-badge--${g.responsables[0]}`} title={GRUPO_META[g.responsables[0]].label}>
                                {GRUPO_META[g.responsables[0]].corto}
                            </span>
                            {g.responsables.length > 1 && (
                                <span className="rb-mas" title={`También: ${g.responsables.slice(1).map(r => GRUPO_META[r].label).join(', ')}`}>
                                    +{g.responsables.length - 1}
                                </span>
                            )}
                            <span className="rb-g-fecha">
                                {g.renglones.length} reng. · {fmtFecha(g.ultimaFecha)}
                                {mostrarVendedor && g.vendedores.length > 0 && (
                                    <> · <span className="rb-g-vend">{g.vendedores.join('/').toLowerCase()}</span></>
                                )}
                            </span>
                        </span>
                        {mostrarRecargo && g.recargo > 0 && (
                            <span className="rb-g-recargo">+{fmtMoney(g.recargo)}</span>
                        )}
                    </div>
                </div>
            </summary>
            <div className="rb-g-rows">
                {g.renglones.map(r => {
                    const meta = MOTIVO_META[r.motivo] ?? { label: r.motivo_raw ?? r.motivo, grupo: 'otro' as const };
                    return (
                        <div key={r.fila} className="rb-r">
                            <span className="rb-r-fecha">{fmtFecha(r.fecha)}</span>
                            <span className="rb-r-art" title={r.articulo ?? ''}>
                                {r.articulo}
                                {r.cantidad != null && <em> ×{r.cantidad}</em>}
                            </span>
                            <span className={`rb-badge rb-badge--${meta.grupo}`}>{meta.label}</span>
                            <span className="rb-r-total">{r.total != null ? fmtMoney(r.total) : '—'}</span>
                        </div>
                    );
                })}
            </div>
        </details>
    );
};
