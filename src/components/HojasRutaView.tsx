import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    AlertTriangle, Truck, Plus, Loader2, X, Wand2, MapPin, Package,
    ChevronRight, RefreshCw, Trash2, Printer,
} from 'lucide-react';
import { authHeaders } from '../utils/auth';
import { ImprimirHoja } from './ImprimirHoja';
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
    fecha: string | null;
    /** Vigente de un día anterior: se quedó sin salir y hay que mirarlo. */
    de_otro_dia: boolean;
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
    /** Qué pedido tiene los avisos desplegados. En tablet no hay hover: hay que poder tocarlo. */
    const [detalle, setDetalle] = useState<string | null>(null);
    /** Días hacia atrás que se están mirando. 0 = sólo el día elegido, que es lo rápido. */
    const [dias, setDias] = useState(0);
    /** Cuántos pedidos vigentes quedaron de días anteriores. null = todavía no se sabe. */
    const [arrastre, setArrastre] = useState<number | null>(null);
    /** Qué hoja se está imprimiendo. */
    const [imprimiendo, setImprimiendo] = useState<string | null>(null);

    const cargar = useCallback(async () => {
        setCargando(true); setError(null);
        try {
            const [p, h, c] = await Promise.all([
                fetch(`/api/hojas-ruta/pendientes?fecha=${fecha}&dias=${dias}`, { headers: authHeaders() }),
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
    }, [fecha, dias]);

    useEffect(() => { void cargar(); }, [cargar]);

    /**
     * Cuántos pedidos vigentes quedaron de días anteriores.
     *
     * Va en una llamada APARTE y después de dibujar el día: contarlos cuesta ~6 s contra IM y
     * no puede demorar la apertura de la pantalla. El 07/09/2026 había 417 — pedidos viejos
     * que nunca se facturaron y que, mostrados todos juntos, hacían la lista inusable.
     */
    useEffect(() => {
        let vivo = true;
        setArrastre(null);
        fetch(`/api/hojas-ruta/arrastre?fecha=${fecha}`, { headers: authHeaders() })
            .then(r => r.ok ? r.json() : null)
            .then(d => { if (vivo && d?.ok) setArrastre(d.cantidad ?? 0); })
            .catch(() => { /* el aviso es opcional: si no se puede contar, no se muestra */ });
        return () => { vivo = false; };
    }, [fecha]);

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

    /**
     * Crea una hoja. Con `conSeleccion`, le mete los pedidos elegidos en el mismo paso.
     *
     * 🪤 Antes el botón "Nueva hoja con estos" sólo creaba la hoja VACÍA, y como `cargar()`
     * limpia la selección, había que volver a marcar los pedidos uno por uno. El botón decía
     * una cosa y hacía otra.
     */
    async function nuevaHoja(codZona: number | null = null, conSeleccion = false) {
        setTrabajando(true); setAviso(null);
        const paraMeter = conSeleccion ? seleccionados : [];
        try {
            const r = await fetch('/api/hojas-ruta', {
                method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ fecha, cod_zona: codZona }),
            });
            const d = await r.json().catch(() => null);
            if (!r.ok) { setAviso(d?.error ?? 'No se pudo crear la hoja'); return; }
            if (paraMeter.length && d?.hoja?.id) {
                const ok = await mandarAHoja(d.hoja.id, paraMeter);
                if (!ok) return;   // el error ya se mostró; la hoja queda creada y vacía
            }
            await cargar();
        } finally { setTrabajando(false); }
    }

    /**
     * El POST de asignar, separado para que lo usen el botón de la hoja y el de "nueva hoja
     * con estos". Devuelve si salió bien.
     */
    async function mandarAHoja(hojaId: string, pedidos: Pendiente[], mover = false): Promise<boolean> {
        const r = await fetch(`/api/hojas-ruta/${hojaId}/pedidos`, {
            method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ pedidos, mover }),
        });
        const d = await r.json().catch(() => null);
        if (!r.ok) {
            // 🔑 El backend avisa cuándo se puede forzar. Sin esto, un pedido que ya está en
            // otra hoja obliga a ir a buscarlo y sacarlo a mano — y mover pedidos entre hojas
            // es la operación MÁS COMÚN cuando una zona se pasa de kilos.
            if (d?.mover_disponible && confirm(`${d.error}\n\n¿Los paso igual a esta hoja?`)) {
                return await mandarAHoja(hojaId, pedidos, true);
            }
            setAviso(d?.error ?? 'No se pudieron asignar');
            return false;
        }
        const partes: string[] = [];
        if (d?.sin_saldo > 0) partes.push(`de ${d.sin_saldo} no se pudo traer el saldo del cliente (van en blanco en la hoja impresa)`);
        if (d?.peso_recalculado === false) partes.push('los kilos son los que mostraba la pantalla, no se pudieron recalcular contra InfoManager');
        if (partes.length) setAviso(`Se agregaron ${d.agregados}, pero ${partes.join('; ')}.`);
        return true;
    }

    async function asignar(hojaId: string) {
        if (!seleccionados.length) return;
        setTrabajando(true); setAviso(null);
        try {
            await mandarAHoja(hojaId, seleccionados);
            await cargar();
        } finally { setTrabajando(false); }
    }

    /**
     * 🪤 Estas tres se comían el error: hacían `await fetch(...)` sin mirar la respuesta y
     * recargaban igual. Si el server rechazaba, la pantalla se refrescaba como si hubiera
     * funcionado y el usuario se quedaba pensando que el pedido salió de la hoja.
     */
    async function pedir(url: string, init: RequestInit, siFalla: string): Promise<boolean> {
        const r = await fetch(url, { ...init, headers: { ...authHeaders(), ...(init.headers ?? {}) } });
        if (!r.ok) {
            const d = await r.json().catch(() => null);
            setAviso(d?.error ?? siFalla);
            return false;
        }
        return true;
    }

    async function quitar(comprobanteId: string) {
        setTrabajando(true); setAviso(null);
        try {
            await pedir(`/api/hojas-ruta/pedidos/${comprobanteId}`, { method: 'DELETE' }, 'No se pudo sacar el pedido de la hoja');
            await cargar();
        } finally { setTrabajando(false); }
    }

    async function editarHoja(hojaId: string, cambios: Record<string, unknown>, siFalla: string) {
        setTrabajando(true); setAviso(null);
        try {
            await pedir(`/api/hojas-ruta/${hojaId}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cambios),
            }, siFalla);
            await cargar();
        } finally { setTrabajando(false); }
    }

    async function borrarHoja(hojaId: string, numero: number) {
        if (!confirm(`¿Borrar la hoja ${numero}? Los pedidos vuelven a la lista de pendientes.`)) return;
        setTrabajando(true); setAviso(null);
        try {
            await pedir(`/api/hojas-ruta/${hojaId}`, { method: 'DELETE' }, 'No se pudo borrar la hoja');
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

            {dias === 0 && !!arrastre && (
                <div className="hr-aviso">
                    <AlertTriangle size={15} />
                    <span>Hay <b>{arrastre}</b> pedidos de días anteriores que siguen sin salir.</span>
                    <button className="hr-btn chico" onClick={() => setDias(15)} disabled={cargando}>Traerlos</button>
                </div>
            )}
            {dias > 0 && (
                <div className="hr-aviso">
                    <span>Mostrando también los pedidos de los últimos {dias} días.</span>
                    <button className="hr-btn chico" onClick={() => setDias(0)} disabled={cargando}>Ver sólo el día</button>
                </div>
            )}
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
                                            <span>{p.cliente_nombre}</span>
                                            {p.de_otro_dia && (
                                                <span className="hr-badge tenue" title="Es de otro día y sigue sin salir">
                                                    {String(p.fecha ?? '').slice(8, 10)}/{String(p.fecha ?? '').slice(5, 7)}
                                                </span>
                                            )}
                                            {p.avisos.length > 0 && (
                                                <button
                                                    type="button"
                                                    className={`hr-badge ${p.gravedad?.pierde_margen > 0 ? 'grave' : 'aviso'}`}
                                                    onClick={e => { e.preventDefault(); e.stopPropagation(); setDetalle(d => d === p.im_comprobante_id ? null : p.im_comprobante_id); }}
                                                >
                                                    <AlertTriangle size={11} />
                                                    {p.gravedad?.pierde_margen > 0 ? 'por debajo de lista' : 'revisar'}
                                                </button>
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
                            {g.filas.filter(p => detalle === p.im_comprobante_id).map(p => (
                                <div className="hr-detalle" key={p.im_comprobante_id + '-det'}>
                                    {p.avisos.map((a, i) => <div key={i}>· {a}</div>)}
                                </div>
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
                                <select value={h.camion_id ?? ''} onChange={e => void editarHoja(h.id, { camion_id: e.target.value || null }, 'No se pudo cambiar el camión')} disabled={trabajando}>
                                    <option value="">Sin camión</option>
                                    {camiones.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                                </select>
                                <button className="hr-icono" title="Imprimir la hoja y el listado de fraccionado" onClick={() => setImprimiendo(h.id)} disabled={!h.pedidos.length}>
                                    <Printer size={14} />
                                </button>
                                <button className="hr-icono" title="Borrar la hoja" onClick={() => void borrarHoja(h.id, h.numero)} disabled={trabajando}>
                                    <Trash2 size={14} />
                                </button>
                            </div>

                            {/* Turno y transporte van impresos en la cabecera de la hoja de ruta
                                ("Turno: Mañana · Transporte: Niño"), así que se cargan acá. */}
                            <div className="hr-hoja-datos">
                                <select value={h.turno ?? ''} onChange={e => void editarHoja(h.id, { turno: e.target.value || null }, 'No se pudo cambiar el turno')} disabled={trabajando}>
                                    <option value="">Turno…</option>
                                    <option value="Mañana">Mañana</option>
                                    <option value="Tarde">Tarde</option>
                                </select>
                                <input
                                    type="text" placeholder="Transporte" defaultValue={h.transporte ?? ''}
                                    onBlur={e => { if (e.target.value !== (h.transporte ?? '')) void editarHoja(h.id, { transporte: e.target.value || null }, 'No se pudo cambiar el transporte'); }}
                                    disabled={trabajando}
                                />
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

            {imprimiendo && <ImprimirHoja hojaId={imprimiendo} onClose={() => setImprimiendo(null)} />}

            {/* Barra de selección: siempre a la vista mientras haya algo elegido. */}
            {!!seleccionados.length && (
                <div className="hr-barra-sel">
                    <span><b>{seleccionados.length}</b> pedidos · {kilos(kgSel)}</span>
                    <button className="hr-btn ghost" onClick={() => setSel(new Set())}>Deseleccionar</button>
                    <button className="hr-btn" onClick={() => void nuevaHoja(seleccionados[0]?.cod_zona ?? null, true)} disabled={trabajando}>
                        <Wand2 size={15} /> Nueva hoja con estos
                    </button>
                </div>
            )}
        </div>
    );
}
