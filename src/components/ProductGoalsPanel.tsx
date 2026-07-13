import { useEffect, useMemo, useRef, useState } from 'react';
import { Package, Loader2, AlertCircle, Plus, Trash2, ChevronDown, ChevronUp, Search, X } from 'lucide-react';
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

interface PGArticulo {
    cod_articulo: number;
    descripcion: string;
}

interface PGGrupo {
    id: string;
    cod_vendedor: number;
    nombre: string;
    articulos: PGArticulo[];
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
    const [items, setItems] = useState<PGGrupo[] | null>(null);
    const [avanceError, setAvanceError] = useState<string | null>(null);
    const [err, setErr] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    // Filtros locales del panel admin (achican la vista cuando se mira "Todos").
    const [filtroVendedor, setFiltroVendedor] = useState<number | 'todos'>('todos');
    const [filtroProducto, setFiltroProducto] = useState<string>('todos');
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

    // Base: respeta la selección global de vendedor del header (si el admin ya
    // eligió uno). Los filtros locales achican DENTRO de eso.
    const base = useMemo(
        () => (items ?? []).filter(it => selectedVendor == null || it.cod_vendedor === selectedVendor),
        [items, selectedVendor],
    );

    // El dropdown de vendedor solo tiene sentido si en la base hay ≥2 vendedores.
    // "Efectivo" = si el filtro guardado ya no aplica a la data actual (cambió el
    // vendedor del header), cae a 'todos' EN EL MISMO render — así no se pinta un
    // frame vacío ("Sin objetivos") antes de que un effect corrija.
    const vendedoresEnBase = useMemo(() => [...new Set(base.map(it => it.cod_vendedor))], [base]);
    const filtroVendedorEfectivo = filtroVendedor !== 'todos' && vendedoresEnBase.includes(filtroVendedor) ? filtroVendedor : 'todos';
    const trasVendedor = base.filter(it => filtroVendedorEfectivo === 'todos' || it.cod_vendedor === filtroVendedorEfectivo);

    // El dropdown de producto/familia depende del vendedor ya filtrado.
    const productosEnBase = useMemo(() => [...new Set(trasVendedor.map(it => it.nombre))].sort(), [trasVendedor]);
    const filtroProductoEfectivo = productosEnBase.includes(filtroProducto) ? filtroProducto : 'todos';
    const visibles = trasVendedor.filter(it => filtroProductoEfectivo === 'todos' || it.nombre === filtroProductoEfectivo);

    // Vendedor sin familias: no ensuciar la vista de Objetivos. El admin siempre
    // ve el panel (necesita el alta).
    if (!isAdmin && base.length === 0 && !err) return null;

    const mostrarFiltros = isAdmin && (vendedoresEnBase.length >= 2 || productosEnBase.length >= 2);

    // Agrupar por vendedor para el render (el vendedor solo ve las suyas).
    const grupos = new Map<number, PGGrupo[]>();
    for (const it of visibles) {
        let g = grupos.get(it.cod_vendedor);
        if (!g) { g = []; grupos.set(it.cod_vendedor, g); }
        g.push(it);
    }

    return (
        <div className="pg">
            <div className="pg-head">
                <h2><Package size={17} /> Objetivos por producto {loading && <Loader2 size={14} className="pg-spin" />}</h2>
                <p>Familias de productos con objetivo del mes en unidades{isAdmin ? ' (y comisión especial opcional)' : ''}.</p>
            </div>

            {err && <div className="pg-error"><AlertCircle size={14} /> {err}</div>}
            {avanceError && <div className="pg-warn">Avance no disponible (InfoManager no respondió) — se muestran solo los targets.</div>}

            {mostrarFiltros && (
                <div className="pg-filtros">
                    {vendedoresEnBase.length >= 2 && (
                        <label className="pg-filtro">
                            <span>Vendedor</span>
                            <select value={String(filtroVendedorEfectivo)} onChange={e => setFiltroVendedor(e.target.value === 'todos' ? 'todos' : Number(e.target.value))}>
                                <option value="todos">Todos</option>
                                {vendedoresEnBase.map(cod => <option key={cod} value={cod}>{vendorName(cod)}</option>)}
                            </select>
                        </label>
                    )}
                    {productosEnBase.length >= 2 && (
                        <label className="pg-filtro">
                            <span>Producto</span>
                            <select value={filtroProductoEfectivo} onChange={e => setFiltroProducto(e.target.value)}>
                                <option value="todos">Todos</option>
                                {productosEnBase.map(n => <option key={n} value={n}>{n}</option>)}
                            </select>
                        </label>
                    )}
                </div>
            )}

            {visibles.length === 0 && !err && (
                <p className="pg-empty">Sin objetivos por producto este mes.</p>
            )}

            {[...grupos.entries()].map(([cod, its]) => (
                <div key={cod} className="pg-grupo">
                    {isAdmin && <div className="pg-grupo-nombre">{vendorName(cod)}</div>}
                    {its.map(it => {
                        const pct = Math.min(1, Math.max(0, it.pct_cumplimiento ?? 0));
                        const cumplido = (it.pct_cumplimiento ?? 0) >= 1;
                        return (
                            <div key={it.id} className={`pg-item ${cumplido ? 'is-done' : ''}`}>
                                <div className="pg-item-top">
                                    <span className="pg-item-desc">{it.nombre}</span>
                                    {it.comision_pct != null && (
                                        <span className="pg-item-pct" title="Comisión especial de esta familia este mes">
                                            comisión {fmtPct(it.comision_pct)}
                                        </span>
                                    )}
                                    <span className={`pg-item-avance ${cumplido ? 'pg-done' : ''}`}>
                                        {cumplido ? '✓ Cumplido' : `${Math.round(pct * 100)}%`}
                                    </span>
                                    {isAdmin && (
                                        <DeleteGoalButton id={it.id} onDeleted={load} />
                                    )}
                                </div>
                                {it.articulos.length > 1 && (
                                    <div className="pg-item-arts">
                                        {it.articulos.map(a => (
                                            <span key={a.cod_articulo} className="pg-art-chip" title={`${a.cod_articulo} · ${a.descripcion}`}>{a.descripcion}</span>
                                        ))}
                                    </div>
                                )}
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

function DeleteGoalButton({ id, onDeleted }: { id: string; onDeleted: () => void }) {
    const [busy, setBusy] = useState(false);
    const del = async () => {
        setBusy(true);
        try {
            const res = await fetch(`/api/product-goals?id=${encodeURIComponent(id)}`, { method: 'DELETE', headers: authHeaders() });
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
    const [nombre, setNombre] = useState('');
    const [codVend, setCodVend] = useState<number>(VENDEDORES[0].cod);
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<ArticuloResult[]>([]);
    const [articulos, setArticulos] = useState<ArticuloResult[]>([]);
    const [target, setTarget] = useState('');
    const [pctStr, setPctStr] = useState('');
    const [saving, setSaving] = useState(false);
    const [formErr, setFormErr] = useState<string | null>(null);
    const debounceRef = useRef<number | null>(null);

    // Buscador de artículos con debounce contra /api/product-goals/articulos.
    useEffect(() => {
        if (query.trim().length < 2) { setResults([]); return; }
        if (debounceRef.current) window.clearTimeout(debounceRef.current);
        debounceRef.current = window.setTimeout(async () => {
            try {
                const res = await fetch(`/api/product-goals/articulos?q=${encodeURIComponent(query.trim())}`, { headers: authHeaders() });
                const j = await res.json();
                setResults(res.ok && j.ok ? j.items : []);
            } catch { setResults([]); }
        }, 350);
        return () => { if (debounceRef.current) window.clearTimeout(debounceRef.current); };
    }, [query]);

    const addArticulo = (r: ArticuloResult) => {
        setArticulos(prev => prev.some(a => a.cod_articulo === r.cod_articulo) ? prev : [...prev, r]);
        setQuery(''); setResults([]);
    };
    const removeArticulo = (cod: number) => setArticulos(prev => prev.filter(a => a.cod_articulo !== cod));

    const save = async () => {
        if (articulos.length === 0) { setFormErr('Agregá al menos un artículo desde el buscador.'); return; }
        if (articulos.length > 1 && nombre.trim() === '') { setFormErr('Ponele un nombre a la familia (ej: "Barras Monkey").'); return; }
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
                    cod_vendedor: codVend, nombre: nombre.trim() || undefined,
                    target_unidades: t, comision_pct: pct,
                    cod_articulos: articulos.map(a => a.cod_articulo),
                }),
            });
            const j = await res.json();
            if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
            setNombre(''); setQuery(''); setArticulos([]); setTarget(''); setPctStr('');
            onSaved();
        } catch (e: any) {
            setFormErr(e.message);
        } finally { setSaving(false); }
    };

    const esFamilia = articulos.length > 1;

    return (
        <div className="pg-add">
            <button className="pg-add-toggle" onClick={() => setOpen(o => !o)} aria-expanded={open}>
                <span><Plus size={14} /> Agregar objetivo por producto</span>
                {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
            {open && (
                <div className="pg-add-body">
                    <label className="pg-field">
                        <span>Artículos {esFamilia && <em className="pg-field-hint">(varias variedades suman a la misma meta)</em>}</span>
                        <div className="pg-search">
                            <Search size={13} />
                            <input
                                type="text" placeholder="Buscar código o nombre (ej: MONKEY) y agregar"
                                value={query}
                                onChange={e => setQuery(e.target.value)}
                            />
                        </div>
                        {results.length > 0 && (
                            <div className="pg-results">
                                {results.map(r => {
                                    const yaEsta = articulos.some(a => a.cod_articulo === r.cod_articulo);
                                    return (
                                        <button key={r.cod_articulo} className="pg-result" onClick={() => addArticulo(r)} disabled={yaEsta}>
                                            <b>{r.cod_articulo}</b> {r.descripcion}
                                            <span className="pg-result-pct">{yaEsta ? 'ya agregado' : `${fmtPct(r.pct_normal)} normal`}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </label>

                    {articulos.length > 0 && (
                        <div className="pg-chips">
                            {articulos.map(a => (
                                <span key={a.cod_articulo} className="pg-chip">
                                    <b>{a.cod_articulo}</b> {a.descripcion}
                                    <button className="pg-chip-x" onClick={() => removeArticulo(a.cod_articulo)} title="Quitar"><X size={12} /></button>
                                </span>
                            ))}
                        </div>
                    )}

                    <label className="pg-field">
                        <span>Nombre de la familia {esFamilia ? '' : '(opcional)'}</span>
                        <input
                            type="text"
                            placeholder={esFamilia ? 'ej: Barras Monkey' : 'se toma del artículo si lo dejás vacío'}
                            value={nombre} onChange={e => setNombre(e.target.value)}
                        />
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
                        Agregá una o varias variedades: las unidades de todas suman al mismo objetivo (ej: 20 cajas de Barras Monkey
                        vendiendo cualquiera de sus sabores). La comisión especial, si la ponés, pisa el % normal de TODOS los
                        artículos de la familia para ese vendedor este mes (aparece como "Comisión especial" en Comisiones).
                    </p>
                </div>
            )}
        </div>
    );
}
