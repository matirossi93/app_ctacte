import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    AlertTriangle, Truck, Plus, Loader2, X, Wand2, MapPin, Package,
    ChevronRight, RefreshCw, Trash2,
} from 'lucide-react';
import { authHeaders } from '../utils/auth';
import './HojasRutaView.css';

/**
 * Armado de hojas de ruta. Reemplaza el panel de InfoManager.
 *
 * 🔑 LA DECISIÓN ES DE LA OFICINA, no del algoritmo (Mati, 07/09/2026: *"el criterio de cómo
 * asignar los camiones tiene que seguir siendo una decisión nuestra... por ahí quizás sí una
 * sugerencia"*). Por eso la sugerencia es un botón que PROPONE y se puede ignorar, y todo se
 * puede mover a mano después.
 */

interface Pendiente {
    im_comprobante_id: string;
    im_numero: number | null;
    cod_cliente: number;
    cliente_nombre: string;
    cod_zona: number | null;
    zona: string;
    zona_origen: 'im' | 'nombre' | 'ninguno';
    total: number;
    bultos: number;
    kg: number;
    renglones_sin_peso: number;
    de_la_app: boolean;
    avisos: string[];
    /** Para qué lado está el error de lista. Es lo que decide si urge mirarlo. */
    gravedad: { pierde_margen: number; cobra_de_mas: number };
    hoja_id: string | null;
}

interface HojaPedido {
    im_comprobante_id: string;
    im_numero: number | null;
    cliente_nombre: string | null;
    saldo_anterior: number | null;
    bultos: number | null;
    kg: number | null;
}

interface Hoja {
    id: string; numero: number; turno: string | null; transporte: string | null;
    camion: string | null; camion_id: string | null; capacidad_kg: number | null;
    cod_zona: number | null; estado: string;
    pedidos: HojaPedido[];
    totales: { pedidos: number; bultos: number; kg: number };
    carga: { porcentaje: number | null; excedido: boolean; sobra_kg: number | null };
}

interface Camion { id: string; nombre: string; capacidad_kg: number }

const hoyISO = () => {
    const d = new Date(Date.now() - 3 * 60 * 60 * 1000);   // Argentina es UTC-3 fija
    return d.toISOString().slice(0, 10);
};
const money = (n: number) => '$' + Math.round(n).toLocaleString('es-AR');
const kilos = (n: number) => n.toLocaleString('es-AR', { maximumFractionDigits: 0 }) + ' kg';

export function HojasRutaView() {
    const [fecha, setFecha] = useState(hoyISO());
    const [pendientes, setPendientes] = useState<Pendiente[]>([]);
    const [hojas, setHojas] = useState<Hoja[]>([]);
    const [camiones, setCamiones] = useState<Camion[]>([]);
    const [cargando, setCargando] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [sel, setSel] = useState<Set<string>>(new Set());
    const [trabajando, setTrabajando] = useState(false);
    const [aviso, setAviso] = useState<string | null>(null);

    const cargar = useCallback(async () => {
        setCargando(true); setError(null);
        try {
            const [p, h, c] = await Promise.all([
                fetch(`/api/hojas-ruta/pendientes?fecha=${fecha}`, { headers: authHeaders() }),
                fetch(`/api/hojas-ruta?fecha=${fecha}`, { headers: authHeaders() }),
                fetch('/api/hojas-ruta/camiones', { headers: authHeaders() }),
            ]);
            const dp = await p.json().catch(() => null);
            if (!p.ok) throw new Error(dp?.error ?? 'No se pudieron traer los pedidos');
            const dh = await h.json().catch(() => null);
            const dc = await c.json().catch(() => null);
            setPendientes(dp.pendientes ?? []);
            setHojas(dh?.hojas ?? []);
            setCamiones(dc?.camiones ?? []);
            setSel(new Set());
        } catch (e: any) {
            setError(e?.message ?? 'Error de conexión');
        } finally {
            setCargando(false);
        }
    }, [fecha]);

    useEffect(() => { void cargar(); }, [cargar]);

    /** Agrupados por zona: es como se arma la hoja y como los mira la oficina. */
    const porZona = useMemo(() => {
        const g = new Map<string, { zona: string; cod_zona: number | null; filas: Pendiente[]; kg: number }>();
        for (const p of pendientes) {
            const k = String(p.cod_zona ?? 'sin');
            if (!g.has(k)) g.set(k, { zona: p.zona, cod_zona: p.cod_zona, filas: [], kg: 0 });
            const x = g.get(k)!;
            x.filas.push(p); x.kg += p.kg;
        }
        return [...g.values()].sort((a, b) => {
            if (a.cod_zona == null) return 1;      // los sin zona al final: hay que mirarlos
            if (b.cod_zona == null) return -1;
            return b.kg - a.kg;                     // y las zonas más pesadas primero
        });
    }, [pendientes]);

    const seleccionados = useMemo(() => pendientes.filter(p => sel.has(p.im_comprobante_id)), [pendientes, sel]);
    const kgSel = seleccionados.reduce((s, p) => s + p.kg, 0);
    // 🔑 Separados a propósito: "36 para revisar" sobre 59 no dice nada y se deja de mirar.
    // Uno es plata que la empresa pierde, el otro es un cliente al que le cobran de más.
    const pierdeMargen = pendientes.filter(p => p.gravedad?.pierde_margen > 0).length;
    const cobraDeMas = pendientes.filter(p => p.gravedad?.cobra_de_mas > 0).length;

    function toggle(id: string) {
        setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
    }
    function toggleZona(filas: Pendiente[]) {
        const ids = filas.map(f => f.im_comprobante_id);
        const todos = ids.every(i => sel.has(i));
        setSel(s => {
            const n = new Set(s);
            for (const i of ids) todos ? n.delete(i) : n.add(i);
            return n;
        });
    }

    async function nuevaHoja(codZona: number | null = null) {
        setTrabajando(true); setAviso(null);
        try {
            const r = await fetch('/api/hojas-ruta', {
                method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ fecha, cod_zona: codZona }),
            });
            const d = await r.json().catch(() => null);
            if (!r.ok) { setAviso(d?.error ?? 'No se pudo crear la hoja'); return; }
            await cargar();
        } finally { setTrabajando(false); }
    }

    async function asignar(hojaId: string, mover = false) {
        if (!seleccionados.length) return;
        setTrabajando(true); setAviso(null);
        try {
            const r = await fetch(`/api/hojas-ruta/${hojaId}/pedidos`, {
                method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ pedidos: seleccionados, mover }),
            });
            const d = await r.json().catch(() => null);
            if (!r.ok) { setAviso(d?.error ?? 'No se pudieron asignar'); return; }
            if (d?.sin_saldo > 0) {
                setAviso(`Se agregaron ${d.agregados}, pero de ${d.sin_saldo} no se pudo traer el saldo del cliente: van en blanco en la hoja impresa.`);
            }
            await cargar();
        } finally { setTrabajando(false); }
    }

    async function quitar(comprobanteId: string) {
        setTrabajando(true);
        try {
            await fetch(`/api/hojas-ruta/pedidos/${comprobanteId}`, { method: 'DELETE', headers: authHeaders() });
            await cargar();
        } finally { setTrabajando(false); }
    }

    async function cambiarCamion(hojaId: string, camionId: string) {
        setTrabajando(true);
        try {
            await fetch(`/api/hojas-ruta/${hojaId}`, {
                method: 'PUT', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ camion_id: camionId || null }),
            });
            await cargar();
        } finally { setTrabajando(false); }
    }

    async function borrarHoja(hojaId: string, numero: number) {
        if (!confirm(`¿Borrar la hoja ${numero}? Los pedidos vuelven a la lista de pendientes.`)) return;
        setTrabajando(true);
        try {
            await fetch(`/api/hojas-ruta/${hojaId}`, { method: 'DELETE', headers: authHeaders() });
            await cargar();
        } finally { setTrabajando(false); }
    }

    return (
        <div className="hr-root">
            <div className="hr-top">
                <label className="hr-fecha">
                    Fecha
                    <input type="date" value={fecha} onChange={e => setFecha(e.target.value)} />
                </label>
                <button className="hr-btn ghost" onClick={() => void cargar()} disabled={cargando}>
                    <RefreshCw size={15} className={cargando ? 'spin' : ''} /> Actualizar
                </button>
                <div className="hr-resumen">
                    <span><b>{pendientes.length}</b> sin asignar</span>
                    <span><b>{kilos(pendientes.reduce((s, p) => s + p.kg, 0))}</b></span>
                    {pierdeMargen > 0 && (
                        <span className="hr-chip-aviso grave" title="El vendedor usó una lista más barata de la que corresponde por la cantidad: la empresa pierde margen">
                            <AlertTriangle size={13} /> {pierdeMargen} por debajo de lista
                        </span>
                    )}
                    {cobraDeMas > 0 && (
                        <span className="hr-chip-aviso" title="Al cliente le están cobrando más caro de lo que le corresponde por la cantidad">
                            {cobraDeMas} le cobran de más
                        </span>
                    )}
                </div>
            </div>

            {aviso && <div className="hr-aviso"><AlertTriangle size={15} /><span>{aviso}</span><button onClick={() => setAviso(null)}><X size={14} /></button></div>}
            {error && <div className="hr-aviso error"><AlertTriangle size={15} /><span>{error}</span></div>}

            <div className="hr-cols">
                {/* ─── Pendientes, agrupados por zona ─────────────────────────── */}
                <section className="hr-col">
                    <h2 className="hr-col-title"><MapPin size={16} /> Pedidos sin asignar</h2>

                    {cargando && <div className="hr-cargando"><Loader2 className="spin" size={20} /> Trayendo los pedidos…</div>}
                    {!cargando && !pendientes.length && (
                        <div className="hr-vacio"><Package size={26} /><span>No quedan pedidos sin asignar.</span></div>
                    )}

                    {porZona.map(g => (
                        <div className="hr-zona" key={String(g.cod_zona ?? 'sin')}>
                            <button className="hr-zona-head" onClick={() => toggleZona(g.filas)}>
                                <span className={`hr-zona-nombre${g.cod_zona == null ? ' sin' : ''}`}>{g.zona}</span>
                                <span className="hr-zona-meta">{g.filas.length} ped · {kilos(g.kg)}</span>
                            </button>
                            {g.filas.map(p => (
                                <label className={`hr-ped${sel.has(p.im_comprobante_id) ? ' sel' : ''}`} key={p.im_comprobante_id}>
                                    <input type="checkbox" checked={sel.has(p.im_comprobante_id)} onChange={() => toggle(p.im_comprobante_id)} />
                                    <div className="hr-ped-info">
                                        <div className="hr-ped-cli">
                                            {p.cliente_nombre}
                                            {p.gravedad?.pierde_margen > 0 && (
                                                <span className="hr-badge grave" title={p.avisos.join(' · ')}>
                                                    <AlertTriangle size={11} /> por debajo de lista
                                                </span>
                                            )}
                                            {p.gravedad?.pierde_margen === 0 && p.avisos.length > 0 && (
                                                <span className="hr-badge aviso" title={p.avisos.join(' · ')}>revisar</span>
                                            )}
                                            {p.zona_origen === 'nombre' && <span className="hr-badge tenue" title="La zona se dedujo del nombre del cliente, no está cargada en InfoManager">zona estimada</span>}
                                        </div>
                                        <div className="hr-ped-meta">
                                            PR {p.im_numero ?? '—'} · {money(p.total)} · {p.bultos} bultos
                                            {p.renglones_sin_peso > 0 && (
                                                <span className="hr-sinpeso" title="Estos renglones no tienen peso cargado en el catálogo: los kilos de este pedido son un mínimo, puede pesar más">
                                                    · {p.renglones_sin_peso} sin peso
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                    <div className="hr-ped-kg">{kilos(p.kg)}</div>
                                </label>
                            ))}
                        </div>
                    ))}
                </section>

                {/* ─── Hojas del día ──────────────────────────────────────────── */}
                <section className="hr-col">
                    <h2 className="hr-col-title">
                        <Truck size={16} /> Hojas de ruta
                        <button className="hr-btn chico" onClick={() => void nuevaHoja()} disabled={trabajando}>
                            <Plus size={14} /> Nueva
                        </button>
                    </h2>

                    {!hojas.length && !cargando && (
                        <div className="hr-vacio"><Truck size={26} /><span>Todavía no hay hojas para este día.</span></div>
                    )}

                    {hojas.map(h => (
                        <div className={`hr-hoja${h.carga.excedido ? ' excedida' : ''}`} key={h.id}>
                            <div className="hr-hoja-head">
                                <span className="hr-hoja-num">Hoja {h.numero}</span>
                                <select value={h.camion_id ?? ''} onChange={e => void cambiarCamion(h.id, e.target.value)} disabled={trabajando}>
                                    <option value="">Sin camión</option>
                                    {camiones.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                                </select>
                                <button className="hr-icono" title="Borrar la hoja" onClick={() => void borrarHoja(h.id, h.numero)} disabled={trabajando}>
                                    <Trash2 size={14} />
                                </button>
                            </div>

                            {/* La barra es el dato que evita que se arme una hoja que no entra en el camión. */}
                            <div className="hr-carga">
                                <div className="hr-barra">
                                    <div className="hr-barra-fill" style={{ width: `${Math.min(h.carga.porcentaje ?? 0, 100)}%` }} />
                                </div>
                                <span className="hr-carga-txt">
                                    {kilos(h.totales.kg)}
                                    {h.capacidad_kg ? ` de ${kilos(Number(h.capacidad_kg))} · ${h.carga.porcentaje}%` : ' · sin camión asignado'}
                                </span>
                            </div>
                            {h.carga.excedido && (
                                <div className="hr-excede"><AlertTriangle size={13} /> Se pasa {kilos(Math.abs(h.carga.sobra_kg ?? 0))} de la capacidad</div>
                            )}

                            {h.pedidos.map(p => (
                                <div className="hr-hoja-ped" key={p.im_comprobante_id}>
                                    <div>
                                        <div className="hr-ped-cli">{p.cliente_nombre ?? `Cliente`}</div>
                                        <div className="hr-ped-meta">
                                            PR {p.im_numero ?? '—'} · {kilos(Number(p.kg ?? 0))}
                                            {p.saldo_anterior != null
                                                ? <> · saldo <b>{money(Number(p.saldo_anterior))}</b></>
                                                : <span className="hr-sinpeso" title="No se pudo traer el saldo: va en blanco en la hoja impresa"> · sin saldo</span>}
                                        </div>
                                    </div>
                                    <button className="hr-icono" title="Sacar de la hoja" onClick={() => void quitar(p.im_comprobante_id)} disabled={trabajando}>
                                        <X size={14} />
                                    </button>
                                </div>
                            ))}

                            {!!seleccionados.length && (
                                <button className="hr-btn asignar" onClick={() => void asignar(h.id)} disabled={trabajando}>
                                    <ChevronRight size={15} /> Mandar {seleccionados.length} acá ({kilos(kgSel)})
                                </button>
                            )}
                        </div>
                    ))}
                </section>
            </div>

            {/* Barra de selección: siempre a la vista mientras haya algo elegido. */}
            {!!seleccionados.length && (
                <div className="hr-barra-sel">
                    <span><b>{seleccionados.length}</b> pedidos · {kilos(kgSel)}</span>
                    <button className="hr-btn ghost" onClick={() => setSel(new Set())}>Deseleccionar</button>
                    <button className="hr-btn" onClick={() => void nuevaHoja(seleccionados[0]?.cod_zona ?? null)} disabled={trabajando}>
                        <Wand2 size={15} /> Nueva hoja con estos
                    </button>
                </div>
            )}
        </div>
    );
}
