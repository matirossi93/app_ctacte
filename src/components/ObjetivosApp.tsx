import { useEffect, useState } from 'react';
import { X, Target, Calendar, Check, Edit3, Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import { authHeaders, getUser } from '../utils/auth';
import './ObjetivosApp.css';

interface Props { onClose: () => void }

interface GoalItem {
    cod_vendedor: number;
    nombre: string;
    vendedor_key: string | null;
    email: string | null;
    year: number;
    month: number;
    target_neto: number | null;
    avance: number;
    num_comprobantes: number;
    pct_cumplimiento: number | null;
    proyeccion: number;
    necesario_por_dia: number | null;
    dias_habiles_total: number;
    dias_habiles_transcurridos: number;
    dias_restantes: number;
    goal_set_by_email: string | null;
    goal_updated_at: string | null;
}

interface GoalsResponse {
    ok: boolean;
    year: number;
    month: number;
    dias_habiles_total: number;
    dias_habiles_auto: number;
    dias_habiles_source: 'manual' | 'auto';
    dias_habiles_transcurridos: number;
    dias_restantes: number;
    items: GoalItem[];
    totales: { target: number; avance: number; pct: number | null; proyeccion: number; vendedores_con_target: number; vendedores_total: number } | null;
}

export const ObjetivosApp = ({ onClose }: Props) => {
    const user = getUser();
    const isAdmin = user?.rol === 'admin' || user?.rol === 'gerente';
    const today = new Date();
    const [year] = useState(today.getUTCFullYear());
    const [month] = useState(today.getUTCMonth() + 1);
    const [data, setData] = useState<GoalsResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState<string | null>(null);
    const [editingCod, setEditingCod] = useState<number | null>(null);
    const [editValue, setEditValue] = useState('');
    const [saving, setSaving] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [editingDias, setEditingDias] = useState(false);
    const [diasEdit, setDiasEdit] = useState('');

    const load = async () => {
        setLoading(true); setErr(null);
        try {
            const res = await fetch(`/api/goals?year=${year}&month=${month}`, { headers: authHeaders() });
            const j = await res.json();
            if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
            setData(j);
        } catch (e: any) { setErr(e.message); }
        finally { setLoading(false); }
    };
    useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [year, month]);

    const startEdit = (item: GoalItem) => {
        setEditingCod(item.cod_vendedor);
        setEditValue(item.target_neto?.toString() ?? '');
    };

    const saveTarget = async (codVendedor: number) => {
        setSaving(true);
        try {
            const res = await fetch('/api/goals', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({ cod_vendedor: codVendedor, year, month, target_neto: Number(editValue) || 0 })
            });
            const j = await res.json();
            if (!res.ok || !j.ok) throw new Error(j.error);
            setEditingCod(null);
            await load();
        } catch (e: any) { alert(`Error: ${e.message}`); }
        finally { setSaving(false); }
    };

    const syncNow = async () => {
        setSyncing(true);
        try {
            const res = await fetch('/api/goals/sync-now', { method: 'POST', headers: authHeaders() });
            const j = await res.json();
            if (j.ok) await load();
            else alert(`Sync error: ${j.error}`);
        } finally { setSyncing(false); }
    };

    const saveDiasHabiles = async () => {
        const n = Number(diasEdit);
        if (!n || n < 1 || n > 31) { alert('Días inválidos (1-31)'); return; }
        try {
            const res = await fetch('/api/month-config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({ year, month, dias_habiles: n })
            });
            const j = await res.json();
            if (!res.ok || !j.ok) throw new Error(j.error);
            setEditingDias(false);
            await load();
        } catch (e: any) { alert(`Error: ${e.message}`); }
    };

    const monthNames = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    const monthLabel = `${monthNames[month - 1]} ${year}`;

    // Vendedor (solo 1 item): vista hero
    const ownItem = !isAdmin && data?.items?.[0];

    return (
        <div className="obj-overlay" role="dialog" aria-modal="true">
            <div className="obj-modal">
                <header className="obj-header">
                    <button className="obj-icon-btn" onClick={onClose} aria-label="Cerrar"><X size={20} /></button>
                    <h2>
                        {isAdmin ? 'Objetivos del equipo' : 'Mis objetivos'}
                        <span className="obj-month">· {monthLabel}</span>
                    </h2>
                    <div className="obj-header-actions">
                        <button className="obj-icon-btn" onClick={syncNow} disabled={syncing} title="Sync ventas InfoManager">
                            {syncing ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
                        </button>
                    </div>
                </header>

                <div className="obj-body">
                    {loading && <div className="obj-loading"><Loader2 className="spin" /> Cargando…</div>}
                    {err && <div className="obj-error"><AlertCircle size={16} /> {err}</div>}

                    {!loading && !err && data && (
                        <>
                            {/* Días hábiles pill */}
                            <div className="obj-days-bar">
                                <span className="obj-days-label">Días hábiles del mes:</span>
                                {editingDias ? (
                                    <>
                                        <input type="number" min="1" max="31" className="obj-days-input"
                                            value={diasEdit}
                                            onChange={e => setDiasEdit(e.target.value)}
                                            onKeyDown={e => { if (e.key === 'Enter') saveDiasHabiles(); if (e.key === 'Escape') setEditingDias(false); }}
                                            autoFocus />
                                        <button className="obj-btn-icon" onClick={saveDiasHabiles} title="Guardar"><Check size={12} /></button>
                                        <button className="obj-btn-icon" onClick={() => setEditingDias(false)} title="Cancelar"><X size={12} /></button>
                                    </>
                                ) : (
                                    <>
                                        <span className={`obj-days-value ${data.dias_habiles_source === 'manual' ? 'is-manual' : ''}`}>
                                            {data.dias_habiles_total} días
                                            {data.dias_habiles_source === 'auto' && <span className="obj-days-auto">(auto, sin feriados)</span>}
                                            {data.dias_habiles_source === 'manual' && <span className="obj-days-manual">fijado manual</span>}
                                        </span>
                                        {isAdmin && (
                                            <button className="obj-edit-btn" onClick={() => { setDiasEdit(String(data.dias_habiles_total)); setEditingDias(true); }} title="Editar días hábiles">
                                                <Edit3 size={12} />
                                            </button>
                                        )}
                                    </>
                                )}
                            </div>

                            {/* Vendedor: vista hero con ring */}
                            {ownItem && <HeroGoal item={ownItem} />}

                            {/* Admin: tarjetas por vendedor + totales */}
                            {isAdmin && data.totales && (
                                <TotalesEquipo totales={data.totales} dias={{ total: data.dias_habiles_total, transcurridos: data.dias_habiles_transcurridos, restantes: data.dias_restantes }} />
                            )}

                            {isAdmin && (
                                <div className="obj-list">
                                    <h3 className="obj-sec-title">Vendedores</h3>
                                    {data.items.map(it => (
                                        <VendorCard key={it.cod_vendedor}
                                            item={it}
                                            editing={editingCod === it.cod_vendedor}
                                            editValue={editValue}
                                            onStartEdit={() => startEdit(it)}
                                            onChangeValue={setEditValue}
                                            onSave={() => saveTarget(it.cod_vendedor)}
                                            onCancelEdit={() => setEditingCod(null)}
                                            saving={saving}
                                        />
                                    ))}
                                </div>
                            )}

                            {!isAdmin && !ownItem && (
                                <div className="obj-empty">
                                    <Target size={32} />
                                    <p>No se encontró un objetivo para tu usuario.</p>
                                    <p style={{ fontSize: 12, color: '#6e7670' }}>
                                        Pedile a Matías o Manolo que asigne tu <code>cod_vendedor</code> y setee tu target.
                                    </p>
                                </div>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

// ─── Hero del vendedor ──────────────────────────────────────────────────────
function HeroGoal({ item }: { item: GoalItem }) {
    const pct = item.pct_cumplimiento ?? 0;
    const pctPct = Math.min(200, pct * 100);
    const circumference = 2 * Math.PI * 54;
    const offset = circumference * (1 - Math.min(1, pct));

    return (
        <div className="obj-hero">
            <div className="obj-hero-head">
                <div>
                    <div className="obj-hero-eyebrow">OBJETIVO DEL MES</div>
                    <h3>{item.nombre}</h3>
                </div>
                <div className="obj-hero-badge">{item.dias_restantes}d restantes</div>
            </div>

            <div className="obj-hero-main">
                <div className="obj-ring">
                    <svg viewBox="0 0 120 120">
                        <circle className="obj-ring-track" cx="60" cy="60" r="54" />
                        <circle className="obj-ring-fill" cx="60" cy="60" r="54"
                            style={{ strokeDasharray: circumference, strokeDashoffset: offset }} />
                    </svg>
                    <div className="obj-ring-center">
                        <div className="obj-ring-pct">{Math.round(pctPct)}<span>%</span></div>
                        <div className="obj-ring-sub">cumplimiento</div>
                    </div>
                </div>
                <div className="obj-hero-figs">
                    <div className="obj-fig">
                        <span className="k">Target</span>
                        <span className="v">{formatMoney(item.target_neto)}</span>
                    </div>
                    <div className="obj-fig">
                        <span className="k">Avance</span>
                        <span className="v gold">{formatMoney(item.avance)}</span>
                    </div>
                    <div className="obj-fig">
                        <span className="k">Proyección</span>
                        <span className="v">{formatMoney(item.proyeccion)}</span>
                    </div>
                </div>
            </div>

            <div className="obj-hero-daily">
                <div className="obj-daily-box">
                    <div className="k">Necesario por día</div>
                    <strong>{formatMoney(item.necesario_por_dia)}</strong>
                </div>
                <div className="obj-daily-note">
                    {item.dias_habiles_transcurridos} de {item.dias_habiles_total} días hábiles.
                    {item.num_comprobantes > 0 && ` ${item.num_comprobantes} comprobantes este mes.`}
                </div>
            </div>

            {item.target_neto == null && (
                <div className="obj-warn">
                    <AlertCircle size={14} /> Aún no tenés target seteado para este mes.
                </div>
            )}
        </div>
    );
}

// ─── Totales equipo (admin) ─────────────────────────────────────────────────
function TotalesEquipo({ totales, dias }: { totales: NonNullable<GoalsResponse['totales']>; dias: { total: number; transcurridos: number; restantes: number } }) {
    const pct = totales.pct ?? 0;
    const pctPct = Math.min(200, pct * 100);
    return (
        <div className="obj-totales">
            <div className="obj-totales-grid">
                <div className="obj-total-card primary">
                    <div className="k">Target equipo</div>
                    <div className="v">{formatMoney(totales.target)}</div>
                    <div className="sub">{totales.vendedores_con_target} de {totales.vendedores_total} con target</div>
                </div>
                <div className="obj-total-card">
                    <div className="k">Avance</div>
                    <div className="v">{formatMoney(totales.avance)}</div>
                    <div className="sub" style={{ color: pct >= 0.9 ? '#06652F' : pct >= 0.5 ? '#B58829' : '#A83E2B' }}>
                        {Math.round(pctPct)}% cumplimiento
                    </div>
                </div>
                <div className="obj-total-card">
                    <div className="k">Proyección</div>
                    <div className="v">{formatMoney(totales.proyeccion)}</div>
                    <div className="sub">{dias.restantes}d restantes de {dias.total}</div>
                </div>
            </div>
        </div>
    );
}

// ─── Card vendedor (admin) ──────────────────────────────────────────────────
function VendorCard({ item, editing, editValue, onStartEdit, onChangeValue, onSave, onCancelEdit, saving }:
    { item: GoalItem; editing: boolean; editValue: string; onStartEdit: () => void; onChangeValue: (v: string) => void; onSave: () => void; onCancelEdit: () => void; saving: boolean }) {
    const pct = item.pct_cumplimiento ?? 0;
    const pctPct = Math.min(150, pct * 100);
    const pctWidth = Math.min(100, pct * 100);
    const colorClass = !item.target_neto ? 'nogoal' : pct >= 0.9 ? 'ok' : pct >= 0.5 ? 'mid' : 'low';

    return (
        <div className={`obj-vcard obj-vcard--${colorClass}`}>
            <div className="obj-vcard-head">
                <div>
                    <h4>{item.nombre}</h4>
                    <span>cod {item.cod_vendedor}{item.email ? ` · ${item.email}` : ''}</span>
                </div>
                <div className="obj-vcard-pct">
                    {item.target_neto ? <>{Math.round(pctPct)}<small>%</small></> : <span className="obj-vcard-notarget">sin target</span>}
                </div>
            </div>

            <div className="obj-vcard-figs">
                <div>
                    <span className="k">Target</span>
                    {editing ? (
                        <div className="obj-edit-row">
                            <input type="number" step="1" min="0" autoFocus
                                value={editValue}
                                onChange={e => onChangeValue(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') onSave(); if (e.key === 'Escape') onCancelEdit(); }}
                            />
                            <button className="obj-btn-icon" onClick={onSave} disabled={saving} title="Guardar (Enter)">
                                {saving ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
                            </button>
                            <button className="obj-btn-icon" onClick={onCancelEdit} disabled={saving} title="Cancelar (Esc)">
                                <X size={14} />
                            </button>
                        </div>
                    ) : (
                        <span className="v">
                            {formatMoney(item.target_neto)}
                            <button className="obj-edit-btn" onClick={onStartEdit} title="Editar target"><Edit3 size={12} /></button>
                        </span>
                    )}
                </div>
                <div>
                    <span className="k">Avance</span>
                    <span className="v gold">{formatMoney(item.avance)}</span>
                </div>
                <div>
                    <span className="k">Proyección</span>
                    <span className="v">{formatMoney(item.proyeccion)}</span>
                </div>
                <div>
                    <span className="k">Necesario/día</span>
                    <span className="v">{formatMoney(item.necesario_por_dia)}</span>
                </div>
            </div>

            <div className="obj-vcard-bar">
                <div className="obj-vcard-bar-fill" style={{ width: `${pctWidth}%` }} />
            </div>

            {item.goal_updated_at && (
                <div className="obj-vcard-meta">
                    <Calendar size={10} /> Seteado {new Date(item.goal_updated_at).toLocaleDateString('es-AR')} por {item.goal_set_by_email ?? '—'}
                </div>
            )}
        </div>
    );
}

function formatMoney(n: number | null | undefined): string {
    if (n == null) return '—';
    return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n);
}
