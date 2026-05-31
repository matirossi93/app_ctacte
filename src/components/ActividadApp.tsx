import { useEffect, useMemo, useState } from 'react';
import { X, Plus, Loader2, AlertCircle, MessageSquare, Phone, DollarSign, Calendar, Truck, FileText, Check, Trash2 } from 'lucide-react';
import { authHeaders, getUser } from '../utils/auth';
import './ActividadApp.css';

interface Props {
    onClose: () => void;
    clients?: Array<{ cod: string; name: string; localidad?: string }>;
}

interface ActivityItem {
    id: string;
    cod_vendedor: number;
    cod_cliente: number | null;
    tipo: 'nota' | 'llamada' | 'wa' | 'promesa' | 'pago' | 'visita';
    contenido: string | null;
    monto: number | null;
    fecha_promesa: string | null;
    created_by: string;
    created_at: string;
    created_by_email: string | null;
    created_by_nombre: string | null;
}

const TIPOS: Array<{ value: ActivityItem['tipo']; label: string; emoji: string; color: string }> = [
    { value: 'nota', label: 'Nota', emoji: '📝', color: 'ochre' },
    { value: 'llamada', label: 'Llamada', emoji: '📞', color: 'green' },
    { value: 'wa', label: 'WhatsApp', emoji: '💬', color: 'wa' },
    { value: 'promesa', label: 'Promesa/Recordatorio', emoji: '📅', color: 'rust' },
    { value: 'pago', label: 'Pago', emoji: '💰', color: 'forest' },
    { value: 'visita', label: 'Visita', emoji: '🚚', color: 'ochre' },
];

export const ActividadApp = ({ onClose, clients = [] }: Props) => {
    const user = getUser();
    const isAdmin = user?.rol === 'admin' || user?.rol === 'gerente';
    const [items, setItems] = useState<ActivityItem[]>([]);
    const [filter, setFilter] = useState<'todos' | ActivityItem['tipo']>('todos');
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState<string | null>(null);
    const [showNew, setShowNew] = useState(false);

    const load = async () => {
        setLoading(true); setErr(null);
        try {
            const q = filter === 'todos' ? '' : `?tipo=${filter}`;
            const res = await fetch(`/api/activity${q}`, { headers: authHeaders() });
            const j = await res.json();
            if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
            setItems(j.items || []);
        } catch (e: any) { setErr(e.message); }
        finally { setLoading(false); }
    };
    useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filter]);

    // Agrupar por día
    const byDay = useMemo(() => {
        const map = new Map<string, ActivityItem[]>();
        items.forEach(it => {
            const d = new Date(it.created_at);
            const key = d.toISOString().slice(0, 10);
            if (!map.has(key)) map.set(key, []);
            map.get(key)!.push(it);
        });
        return Array.from(map.entries()).sort((a, b) => b[0].localeCompare(a[0]));
    }, [items]);

    const deleteItem = async (id: string) => {
        if (!confirm('¿Borrar esta actividad?')) return;
        const res = await fetch(`/api/activity/${id}`, { method: 'DELETE', headers: authHeaders() });
        if (res.ok) load();
        else alert('Error al borrar');
    };

    return (
        <div className="act-overlay" role="dialog" aria-modal="true">
            <div className="act-modal">
                <header className="act-header">
                    <button className="act-icon-btn" onClick={onClose} aria-label="Cerrar"><X size={20} /></button>
                    <h2>{isAdmin ? 'Actividad del equipo' : 'Mi actividad'}</h2>
                    <button className="btn-primary" onClick={() => setShowNew(true)}>
                        <Plus size={16} /> Nueva
                    </button>
                </header>

                <div className="act-chips">
                    <button className={`act-chip ${filter === 'todos' ? 'is-active' : ''}`} onClick={() => setFilter('todos')}>Todos</button>
                    {TIPOS.map(t => (
                        <button key={t.value} className={`act-chip ${filter === t.value ? 'is-active' : ''}`} onClick={() => setFilter(t.value)}>
                            <span>{t.emoji}</span> {t.label}
                        </button>
                    ))}
                </div>

                <div className="act-body">
                    {loading && <div className="act-loading"><Loader2 className="spin" /> Cargando…</div>}
                    {err && <div className="act-error"><AlertCircle /> {err}</div>}

                    {!loading && !err && items.length === 0 && (
                        <div className="act-empty">
                            <MessageSquare size={32} />
                            <p>No hay actividad registrada todavía{filter !== 'todos' ? ` (filtro: ${filter})` : ''}.</p>
                            <button className="btn-primary" onClick={() => setShowNew(true)}>
                                <Plus size={14} /> Crear la primera
                            </button>
                        </div>
                    )}

                    {byDay.map(([day, list]) => (
                        <div key={day} className="act-day">
                            <div className="act-day-head">
                                <span className="when">{formatDay(day)}</span>
                                <span className="bar" />
                            </div>
                            {list.map(it => (
                                <ActivityCard key={it.id} item={it} clients={clients} onDelete={user ? (id) => deleteItem(id) : undefined} myEmail={user?.email ?? ''} />
                            ))}
                        </div>
                    ))}
                </div>

                {showNew && (
                    <NewActivity
                        clients={clients}
                        isAdmin={!!isAdmin}
                        onClose={() => setShowNew(false)}
                        onCreated={() => { setShowNew(false); load(); }}
                    />
                )}
            </div>
        </div>
    );
};

// ─── Card ─────────────────────────────────────────────────────────────────
function ActivityCard({ item, clients, onDelete, myEmail }: { item: ActivityItem; clients: Array<{ cod: string; name: string }>; onDelete?: (id: string) => void; myEmail: string }) {
    const meta = TIPOS.find(t => t.value === item.tipo)!;
    const client = item.cod_cliente ? clients.find(c => c.cod === String(item.cod_cliente)) : null;
    const canDelete = onDelete && item.created_by_email === myEmail;
    const Icon = iconFor(item.tipo);
    return (
        <div className="act-item">
            <div className={`act-icon act-icon--${meta.color}`}>
                <Icon size={17} />
            </div>
            <div className="act-item-body">
                <div className="act-row1">
                    <span className="act-kind">{meta.label}</span>
                    <span className="act-time">{formatTime(item.created_at)}</span>
                </div>
                <div className="act-client">
                    {client ? client.name : (item.cod_cliente ? `Cliente #${item.cod_cliente}` : 'General')}
                </div>
                {item.monto != null && (
                    <div className={`act-amount ${item.tipo === 'promesa' ? 'promise' : ''}`}>
                        {item.tipo === 'pago' ? '+ ' : ''}{formatMoney(item.monto)}
                        {item.fecha_promesa && <span> · vence {item.fecha_promesa}</span>}
                    </div>
                )}
                {item.contenido && <div className="act-text">{item.contenido}</div>}
                {item.created_by_email && (
                    <div className="act-meta">
                        por {item.created_by_nombre ?? item.created_by_email}
                    </div>
                )}
            </div>
            {canDelete && (
                <button className="act-del-btn" onClick={() => onDelete!(item.id)} title="Borrar">
                    <Trash2 size={14} />
                </button>
            )}
        </div>
    );
}

// ─── New activity modal ───────────────────────────────────────────────────
function NewActivity({ clients, isAdmin, onClose, onCreated }:
    { clients: Array<{ cod: string; name: string; localidad?: string }>; isAdmin: boolean; onClose: () => void; onCreated: () => void }) {
    const [tipo, setTipo] = useState<ActivityItem['tipo']>('nota');
    const [codCliente, setCodCliente] = useState('');
    const [clientSearch, setClientSearch] = useState('');
    const [contenido, setContenido] = useState('');
    const [monto, setMonto] = useState('');
    const [fechaPromesa, setFechaPromesa] = useState('');
    const [codVendedor, setCodVendedor] = useState('');
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    const filteredClients = useMemo(() => {
        if (!clientSearch.trim()) return clients.slice(0, 20);
        const q = clientSearch.toLowerCase();
        return clients.filter(c => c.name.toLowerCase().includes(q) || c.cod.includes(q)).slice(0, 20);
    }, [clients, clientSearch]);

    const submit = async () => {
        setSaving(true); setErr(null);
        try {
            const body: any = {
                tipo,
                cod_cliente: codCliente || null,
                contenido: contenido || null,
                monto: monto ? Number(monto) : null,
                fecha_promesa: fechaPromesa || null,
            };
            if (isAdmin && codVendedor) body.cod_vendedor = Number(codVendedor);
            const res = await fetch('/api/activity', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify(body)
            });
            const j = await res.json();
            if (!res.ok || !j.ok) throw new Error(j.error);
            onCreated();
        } catch (e: any) { setErr(e.message); }
        finally { setSaving(false); }
    };

    return (
        <div className="act-new-overlay" onClick={onClose}>
            <div className="act-new" onClick={e => e.stopPropagation()}>
                <header>
                    <h3>Nueva actividad</h3>
                    <button className="act-icon-btn" onClick={onClose}><X size={18} /></button>
                </header>

                <div className="act-new-tipos">
                    {TIPOS.map(t => (
                        <button key={t.value}
                            className={`act-new-tipo ${tipo === t.value ? 'is-active' : ''}`}
                            onClick={() => setTipo(t.value)}>
                            <span className="emoji">{t.emoji}</span>
                            <span>{t.label}</span>
                        </button>
                    ))}
                </div>

                <label className="act-field">
                    <span>Cliente (opcional)</span>
                    <input type="text" value={clientSearch} onChange={e => setClientSearch(e.target.value)} placeholder="Buscá nombre o código…" />
                    {clientSearch && (
                        <div className="act-client-list">
                            {filteredClients.map(c => (
                                <button key={c.cod} type="button"
                                    className={`act-client-option ${codCliente === c.cod ? 'is-active' : ''}`}
                                    onClick={() => { setCodCliente(c.cod); setClientSearch(c.name); }}>
                                    <strong>{c.name}</strong>
                                    <span>Cod {c.cod}{c.localidad ? ` · ${c.localidad}` : ''}</span>
                                </button>
                            ))}
                        </div>
                    )}
                    {codCliente && !clientSearch && <div className="act-client-sel">Cliente {codCliente} ✓</div>}
                </label>

                <label className="act-field">
                    <span>Contenido</span>
                    <textarea rows={3} value={contenido} onChange={e => setContenido(e.target.value)}
                        placeholder={tipo === 'nota' ? 'Ej: Llamé, paga el viernes' : tipo === 'promesa' ? 'Ej: Visitar el viernes, ofrecer Mix Energético' : 'Detalle'} />
                </label>

                {(tipo === 'promesa' || tipo === 'pago') && (
                    <div className="act-row2">
                        <label className="act-field">
                            <span>Monto {tipo === 'promesa' && <em className="act-field-opt">opcional</em>}</span>
                            <input type="number" step="0.01" value={monto} onChange={e => setMonto(e.target.value)} placeholder={tipo === 'promesa' ? 'Vacío si es solo recordatorio' : '0'} />
                        </label>
                        {tipo === 'promesa' && (
                            <label className="act-field">
                                <span>Fecha</span>
                                <input type="date" value={fechaPromesa} onChange={e => setFechaPromesa(e.target.value)} />
                            </label>
                        )}
                    </div>
                )}

                {isAdmin && (
                    <label className="act-field">
                        <span>A nombre de (cod vendedor)</span>
                        <input type="number" value={codVendedor} onChange={e => setCodVendedor(e.target.value)} placeholder="12 Brian · 3 Marcelo · 4 Julio · 2 Sebastián" />
                    </label>
                )}

                {err && <div className="act-err-msg"><AlertCircle size={14} /> {err}</div>}

                <div className="act-new-actions">
                    <button className="btn-secondary" onClick={onClose} disabled={saving}>Cancelar</button>
                    <button className="btn-primary" onClick={submit} disabled={saving || (isAdmin && !codVendedor)}>
                        {saving ? <><Loader2 size={14} className="spin" /> Guardando…</> : <><Check size={14} /> Guardar</>}
                    </button>
                </div>
            </div>
        </div>
    );
}

function iconFor(tipo: ActivityItem['tipo']) {
    switch (tipo) {
        case 'nota': return FileText;
        case 'llamada': return Phone;
        case 'wa': return MessageSquare;
        case 'promesa': return Calendar;
        case 'pago': return DollarSign;
        case 'visita': return Truck;
    }
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
    if (d.toDateString() === today.toDateString()) {
        return d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short' });
}

function formatMoney(n: number | null | undefined): string {
    if (n == null) return '—';
    return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n);
}
