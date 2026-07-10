import { useEffect, useRef, useState } from 'react';
import { Package, Loader2, AlertCircle, Plus, Trash2, ChevronDown, ChevronUp, Search } from 'lucide-react';
import { authHeaders } from '../utils/auth';
import type { ViewPeriod } from './PeriodSelector';
import './ProductGoalsPanel.css';

// Espejo de COD_VENDEDORES_VISIBLES (comisionesShared.ts).
const VENDEDORES = [
    { cod: 2, nombre: 'Sebastián' },
    { cod: 3, nombre: 'Marcelo' },
    { cod: 4, nombre: 'Julio' },
    { cod: 12, nombre: 'Brian' },
];
const vendorName = (cod: number) => VENDEDORES.find(v => v.cod === cod)?.nombre ?? `Vend ${cod}`;

interface PGItem {
    cod_vendedor: number;
    cod_articulo: number;
    descripcion: string;
    target_unidades: number;
    comision_pct: number | null;
    unidades_vendidas: number;
    neto_vendido: number;
    pct_cumplimiento: number | null;
    restante: number;
}

interface ArticuloResult {
    cod_articulo: number;
    descripcion: string;
    pct_normal: number;
}

interface Props {
    isAdmin: boolean;
    viewPeriod: ViewPeriod;
    selectedVendor: number | null;
}

const fmtUnidades = (n: number) => Number.isInteger(n) ? String(n) : n.toFixed(2);
const fmtPct = (frac: number) => `${Math.round(frac * 1000) / 10}%`;

export function ProductGoalsPanel({ isAdmin, viewPeriod, selectedVendor }: Props) {
    const [items, setItems] = useState<PGItem[] | null>(null);
    const [avanceError, setAvanceError] = useState<string | null>(null);
    const [err, setErr] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const abortRef = useRef<AbortController | null>(null);

    const load = async () => {
        if (abortRef.current) abortRef.current.abort();
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        setLoading(true); setErr(null);
        try {
            const params = new URLSearchParams({ year: String(viewPeriod.year), month: String(viewPeriod.month) });
            const res = await fetch(`/api/product-goals?${params}`, { headers: authHeaders(), signal: ctrl.signal });
            const j = await res.json();
            if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
            setItems(j.items);
            setAvanceError(j.avance_error ?? null);
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

    const visibles = (items ?? []).filter(it => selectedVendor == null || it.cod_vendedor === selectedVendor);

    // Vendedor sin objetivos por producto: no ensuciar la vista de Objetivos.
    // El admin siempre ve el panel (necesita el alta).
    if (!isAdmin && visibles.length === 0 && !err) return null;

    // Agrupar por vendedor para el admin (el vendedor solo ve los suyos).
    const grupos = new Map<number, PGItem[]>();
    for (const it of visibles) {
        let g = grupos.get(it.cod_vendedor);
        if (!g) { g = []; grupos.set(it.cod_vendedor, g); }
        g.push(it);
    }

    return (
        <div className="pg">
            <div className="pg-head">
                <h2><Package size={17} /> Objetivos por producto {loading && <Loader2 size={14} className="pg-spin" />}</h2>
                <p>Productos puntuales con objetivo del mes en unidades{isAdmin ? ' (y comisión especial opcional)' : ''}.</p>
            </div>

            {err && <div className="pg-error"><AlertCircle size={14} /> {err}</div>}
            {avanceError && <div className="pg-warn">Avance no disponible (InfoManager no respondió) — se muestran solo los targets.</div>}

            {visibles.length === 0 && !err && (
                <p className="pg-empty">Sin objetivos por producto este mes.</p>
            )}

            {[...grupos.entries()].map(([cod, its]) => (
                <div key={cod} className="pg-grupo">
                    {isAdmin && grupos.size >= 1 && <div className="pg-grupo-nombre">{vendorName(cod)}</div>}
                    {its.map(it => {
                        const pct = Math.min(1, Math.max(0, it.pct_cumplimiento ?? 0));
                        const cumplido = (it.pct_cumplimiento ?? 0) >= 1;
                        return (
                            <div key={`${it.cod_vendedor}:${it.cod_articulo}`} className={`pg-item ${cumplido ? 'is-done' : ''}`}>
                                <div className="pg-item-top">
                                    <span className="pg-item-desc">{it.descripcion}</span>
                                    {it.comision_pct != null && (
                                        <span className="pg-item-pct" title="Comisión especial de este producto este mes">
                                            comisión {fmtPct(it.comision_pct)}
                                        </span>
                                    )}
                                    <span className={`pg-item-avance ${cumplido ? 'pg-done' : ''}`}>
                                        {cumplido ? '✓ Cumplido' : `${Math.round(pct * 100)}%`}
                                    </span>
                                    {isAdmin && (
                                        <DeleteGoalButton item={it} viewPeriod={viewPeriod} onDeleted={load} />
                                    )}
                                </div>
                                <div className="pg-bar">
                                    <div className={`pg-bar-fill ${cumplido ? 'is-done' : ''}`} style={{ width: `${pct * 100}%` }} />
                                </div>
                                <div className="pg-item-sub">
                                    <b>{fmtUnidades(it.unidades_vendidas)}</b> de {fmtUnidades(it.target_unidades)} unidades
                                    {!cumplido && <> · faltan {fmtUnidades(it.restante)}</>}
                                </div>
                            </div>
                        );
                    })}
                </div>
            ))}

            {isAdmin && <AddGoalForm viewPeriod={viewPeriod} onSaved={load} />}
        </div>
    );
}

function DeleteGoalButton({ item, viewPeriod, onDeleted }: { item: PGItem; viewPeriod: ViewPeriod; onDeleted: () => void }) {
    const [busy, setBusy] = useState(false);
    const del = async () => {
        setBusy(true);
        try {
            const params = new URLSearchParams({
                year: String(viewPeriod.year), month: String(viewPeriod.month),
                cod_vendedor: String(item.cod_vendedor), cod_articulo: String(item.cod_articulo),
            });
            const res = await fetch(`/api/product-goals?${params}`, { method: 'DELETE', headers: authHeaders() });
            const j = await res.json();
            if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
            onDeleted();
        } catch { /* el reload muestra el estado real */ } finally { setBusy(false); }
    };
    return (
        <button className="pg-del" onClick={del} disabled={busy} title="Quitar objetivo">
            {busy ? <Loader2 size={13} className="pg-spin" /> : <Trash2 size={13} />}
        </button>
    );
}

function AddGoalForm({ viewPeriod, onSaved }: { viewPeriod: ViewPeriod; onSaved: () => void }) {
    const [open, setOpen] = useState(false);
    const [codVend, setCodVend] = useState<number>(VENDEDORES[0].cod);
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<ArticuloResult[]>([]);
    const [articulo, setArticulo] = useState<ArticuloResult | null>(null);
    const [target, setTarget] = useState('');
    const [pctStr, setPctStr] = useState('');
    const [saving, setSaving] = useState(false);
    const [formErr, setFormErr] = useState<string | null>(null);
    const debounceRef = useRef<number | null>(null);

    // Buscador de artículos con debounce contra /api/product-goals/articulos.
    useEffect(() => {
        if (articulo || query.trim().length < 2) { setResults([]); return; }
        if (debounceRef.current) window.clearTimeout(debounceRef.current);
        debounceRef.current = window.setTimeout(async () => {
            try {
                const res = await fetch(`/api/product-goals/articulos?q=${encodeURIComponent(query.trim())}`, { headers: authHeaders() });
                const j = await res.json();
                setResults(res.ok && j.ok ? j.items : []);
            } catch { setResults([]); }
        }, 350);
        return () => { if (debounceRef.current) window.clearTimeout(debounceRef.current); };
    }, [query, articulo]);

    const save = async () => {
        if (!articulo) { setFormErr('Elegí un artículo del buscador.'); return; }
        const t = Number(target);
        if (!Number.isFinite(t) || t <= 0) { setFormErr('Ingresá las unidades objetivo (> 0).'); return; }
        // pct se tipea en % humano ("5" = 5%) y viaja como fracción (0.05).
        let pct: number | null = null;
        if (pctStr.trim() !== '') {
            const p = Number(pctStr.replace(',', '.'));
            if (!Number.isFinite(p) || p <= 0 || p > 20) { setFormErr('La comisión especial va en % (ej: 5), máximo 20.'); return; }
            pct = Math.round(p * 100) / 10000;
        }
        setSaving(true); setFormErr(null);
        try {
            const res = await fetch('/api/product-goals', {
                method: 'POST',
                headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    year: viewPeriod.year, month: viewPeriod.month,
                    cod_vendedor: codVend, cod_articulo: articulo.cod_articulo,
                    target_unidades: t, comision_pct: pct,
                }),
            });
            const j = await res.json();
            if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
            setQuery(''); setArticulo(null); setTarget(''); setPctStr('');
            onSaved();
        } catch (e: any) {
            setFormErr(e.message);
        } finally { setSaving(false); }
    };

    return (
        <div className="pg-add">
            <button className="pg-add-toggle" onClick={() => setOpen(o => !o)} aria-expanded={open}>
                <span><Plus size={14} /> Agregar objetivo por producto</span>
                {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
            {open && (
                <div className="pg-add-body">
                    <label className="pg-field">
                        <span>Artículo</span>
                        <div className="pg-search">
                            <Search size={13} />
                            <input
                                type="text" placeholder="Código o nombre (ej: ZIMPI)"
                                value={articulo ? `${articulo.cod_articulo} · ${articulo.descripcion}` : query}
                                onChange={e => { setArticulo(null); setQuery(e.target.value); }}
                            />
                        </div>
                        {!articulo && results.length > 0 && (
                            <div className="pg-results">
                                {results.map(r => (
                                    <button key={r.cod_articulo} className="pg-result" onClick={() => { setArticulo(r); setResults([]); }}>
                                        <b>{r.cod_articulo}</b> {r.descripcion}
                                        <span className="pg-result-pct">{fmtPct(r.pct_normal)} normal</span>
                                    </button>
                                ))}
                            </div>
                        )}
                    </label>
                    <div className="pg-add-row">
                        <label className="pg-field">
                            <span>Vendedor</span>
                            <select value={codVend} onChange={e => setCodVend(Number(e.target.value))}>
                                {VENDEDORES.map(v => <option key={v.cod} value={v.cod}>{v.nombre}</option>)}
                            </select>
                        </label>
                        <label className="pg-field">
                            <span>Unidades objetivo</span>
                            <input type="number" inputMode="numeric" placeholder="20" value={target} onChange={e => setTarget(e.target.value)} />
                        </label>
                        <label className="pg-field">
                            <span>Comisión % (opcional)</span>
                            <input type="text" inputMode="decimal" placeholder="ej: 5" value={pctStr} onChange={e => setPctStr(e.target.value)} />
                        </label>
                        <button className="pg-save" onClick={save} disabled={saving}>
                            {saving ? <Loader2 size={14} className="pg-spin" /> : <Plus size={14} />} Guardar
                        </button>
                    </div>
                    {formErr && <div className="pg-error"><AlertCircle size={14} /> {formErr}</div>}
                    <p className="pg-hint">
                        La comisión especial pisa el % normal de ese artículo para ese vendedor durante este mes
                        (aparece como "Comisión especial" en el panel de Comisiones). Dejala vacía para mantener el % normal.
                    </p>
                </div>
            )}
        </div>
    );
}
