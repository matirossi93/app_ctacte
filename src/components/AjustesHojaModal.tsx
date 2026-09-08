import { useCallback, useEffect, useMemo, useState } from 'react';
import { X, Loader2, Link2, Trash2, AlertTriangle, RefreshCw, FileMinus } from 'lucide-react';
import { authHeaders } from '../utils/auth';
import './AjustesHojaModal.css';

/**
 * EL NÚMERO FINAL DE LA HOJA: lo despachado menos lo que volvió.
 *
 * Mati (08/09/2026): *"una vez que vuelve el repartidor se hacen NC o facturas por dif de
 * mercadería y eso impacta en el num final de la hoja"*, y ese número es la base del pago al
 * chofer — *"a ellos se les paga en función a lo que entregan"*.
 *
 * 🔴 Acá se VINCULA, no se emite. La API de InfoManager rechaza las notas de crédito en el punto
 * de venta 777 (su validación de unicidad del número no mira el tipo de comprobante, así que la
 * serie de NC choca con facturas viejas — probado el 08/09/2026 con 7 payloads y 13 rutas). La
 * nota se emite en la pantalla de IM como siempre y desde acá se ata al pedido: el importe y el
 * número los lee el server de la NC real, nunca de lo que se tipeó en esta pantalla.
 */

interface Pedido {
    im_comprobante_id: string;
    im_numero: number | null;
    cliente_nombre: string | null;
    cod_cliente?: number;
    total?: number | null;
}

interface Ajuste {
    id: string;
    im_comprobante_id: string;
    cliente_nombre: string | null;
    tipo: string;
    motivo: string;
    importe: number;
    im_ajuste_numero: number | null;
    im_ajuste_tipo: string | null;
    emitido_at: string | null;
}

interface Candidata {
    im_ajuste_id: string;
    numero: number | null;
    tipo: string;
    fecha: string;
    cod_cliente: number;
    importe: number;
    observaciones: string;
    /** La oficina escribe "SEGUN HR 3210" en las observaciones: esas van primero. */
    menciona_esta_hoja: boolean;
}

interface Totales {
    despachado: number;
    notas_credito: number;
    notas_debito: number;
    final: number;
    pendientes_de_emitir: number;
}

const money = (n: number) => '$' + Math.round(n).toLocaleString('es-AR');

export function AjustesHojaModal({ hojaId, numero, pedidos, onClose, onCambio }: {
    hojaId: string;
    numero: number;
    pedidos: Pedido[];
    onClose: () => void;
    /** Se llama cuando algo cambió, para que la pantalla de atrás se refresque. */
    onCambio: () => void;
}) {
    const [totales, setTotales] = useState<Totales | null>(null);
    const [ajustes, setAjustes] = useState<Ajuste[]>([]);
    const [candidatas, setCandidatas] = useState<Candidata[] | null>(null);
    const [cargando, setCargando] = useState(true);
    const [buscando, setBuscando] = useState(false);
    const [trabajando, setTrabajando] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [aviso, setAviso] = useState<string | null>(null);
    /** A qué pedido va cada nota, cuando el cliente tiene más de uno en la hoja. */
    const [destino, setDestino] = useState<Record<string, string>>({});

    const cargar = useCallback(async () => {
        setCargando(true); setError(null);
        try {
            const r = await fetch(`/api/hojas-ruta/${hojaId}/ajustes`, { headers: authHeaders() });
            const d = await r.json().catch(() => null);
            if (!r.ok) throw new Error(d?.error ?? 'No se pudieron traer los ajustes');
            setTotales(d);
            setAjustes(d.ajustes ?? []);
        } catch (e: any) {
            setError(e?.message ?? 'Error de conexión');
        } finally {
            setCargando(false);
        }
    }, [hojaId]);

    useEffect(() => { void cargar(); }, [cargar]);

    /**
     * Las notas de crédito del cliente que hay en InfoManager desde la fecha de la hoja.
     * Va contra IM, así que se pide cuando se aprieta el botón y no al abrir.
     */
    async function buscarCandidatas() {
        setBuscando(true); setError(null); setAviso(null);
        try {
            const r = await fetch(`/api/hojas-ruta/${hojaId}/ajustes/candidatas`, { headers: authHeaders() });
            const d = await r.json().catch(() => null);
            if (!r.ok) throw new Error(d?.error ?? 'No se pudieron traer las notas de crédito');
            setCandidatas(d.candidatas ?? []);
            if (!(d.candidatas ?? []).length) {
                setAviso('No hay notas de crédito sin vincular para los clientes de esta hoja. Emitila en InfoManager y volvé a buscar.');
            }
        } catch (e: any) {
            setError(e?.message ?? 'Error de conexión');
        } finally {
            setBuscando(false);
        }
    }

    /** Los pedidos de la hoja, por cliente: una NC sólo se puede atar a un pedido del mismo. */
    const pedidosPorCliente = useMemo(() => {
        const m = new Map<number, Pedido[]>();
        for (const p of pedidos) {
            const k = Number(p.cod_cliente ?? -1);
            if (!m.has(k)) m.set(k, []);
            m.get(k)!.push(p);
        }
        return m;
    }, [pedidos]);

    async function vincular(c: Candidata) {
        const suyos = pedidosPorCliente.get(Number(c.cod_cliente)) ?? [];
        // Con un solo pedido del cliente no hay nada que elegir; con varios, lo elige la oficina.
        const comprobante = destino[c.im_ajuste_id] ?? (suyos.length === 1 ? suyos[0].im_comprobante_id : '');
        if (!comprobante) { setError('Elegí a qué pedido corresponde esa nota de crédito.'); return; }
        setTrabajando(true); setError(null); setAviso(null);
        try {
            const r = await fetch(`/api/hojas-ruta/${hojaId}/ajustes/vincular`, {
                method: 'POST',
                headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ im_comprobante_id: comprobante, im_ajuste_id: c.im_ajuste_id }),
            });
            const d = await r.json().catch(() => null);
            if (!r.ok) throw new Error(d?.error ?? 'No se pudo vincular');
            if (d?.advertencia) setAviso(d.advertencia);
            setCandidatas(cs => (cs ?? []).filter(x => x.im_ajuste_id !== c.im_ajuste_id));
            await cargar();
            onCambio();
        } catch (e: any) {
            setError(e?.message ?? 'Error de conexión');
        } finally {
            setTrabajando(false);
        }
    }

    async function desvincular(a: Ajuste) {
        if (!confirm(`¿Desvincular la ${a.im_ajuste_tipo ?? 'nota'} ${a.im_ajuste_numero ?? ''} de ${money(a.importe)}?\n\nLa nota sigue existiendo en InfoManager: acá sólo se suelta el vínculo con el pedido.`)) return;
        setTrabajando(true); setError(null);
        try {
            const r = await fetch(`/api/hojas-ruta/ajustes/${a.id}`, { method: 'DELETE', headers: authHeaders() });
            const d = await r.json().catch(() => null);
            if (!r.ok) throw new Error(d?.error ?? 'No se pudo desvincular');
            await cargar();
            onCambio();
        } catch (e: any) {
            setError(e?.message ?? 'Error de conexión');
        } finally {
            setTrabajando(false);
        }
    }

    const nombrePedido = (id: string) => {
        const p = pedidos.find(x => x.im_comprobante_id === id);
        return p ? `${p.cliente_nombre ?? 'Cliente'} · PR ${p.im_numero ?? '—'}` : id;
    };

    return (
        <div className="aj-fondo" onClick={onClose}>
            <div className="aj-modal" onClick={e => e.stopPropagation()}>
                <header className="aj-head">
                    <h3><FileMinus size={17} /> Hoja {numero} — diferencias de entrega</h3>
                    <button className="aj-cerrar" onClick={onClose}><X size={18} /></button>
                </header>

                {cargando && <div className="aj-cargando"><Loader2 size={20} className="girando" /> Cargando…</div>}

                {/* El número final, desglosado: quien lo mira tiene que ver de dónde sale. */}
                {totales && (
                    <div className="aj-totales">
                        <div><span>Despachado</span><b>{money(totales.despachado)}</b></div>
                        <div className="resta"><span>Notas de crédito</span><b>− {money(totales.notas_credito)}</b></div>
                        {totales.notas_debito > 0 && (
                            <div><span>Notas de débito</span><b>+ {money(totales.notas_debito)}</b></div>
                        )}
                        <div className="final"><span>Entregado (se liquida)</span><b>{money(totales.final)}</b></div>
                    </div>
                )}

                {error && <div className="aj-error"><AlertTriangle size={14} /> {error}</div>}
                {aviso && <div className="aj-aviso"><AlertTriangle size={14} /> {aviso}</div>}

                {/* ─── Lo ya vinculado ─────────────────────────────────────────── */}
                <section className="aj-seccion">
                    <h4>Notas vinculadas ({ajustes.length})</h4>
                    {!ajustes.length && !cargando && (
                        <p className="aj-vacio">Todavía no hay ninguna. Si el repartidor volvió con mercadería, la nota de crédito se emite en InfoManager y después se vincula acá.</p>
                    )}
                    {ajustes.map(a => (
                        <div className="aj-fila" key={a.id}>
                            <div>
                                <div className="aj-fila-tit">
                                    {a.im_ajuste_tipo ?? (a.tipo === 'nd' ? 'ND' : 'NC')} {a.im_ajuste_numero ?? '—'}
                                    <b className={a.tipo === 'nd' ? 'suma' : 'resta'}>
                                        {a.tipo === 'nd' ? '+' : '−'} {money(a.importe)}
                                    </b>
                                </div>
                                <div className="aj-fila-meta">
                                    {nombrePedido(a.im_comprobante_id)} · {a.motivo}
                                </div>
                            </div>
                            <button className="aj-icono" title="Desvincular del pedido" onClick={() => void desvincular(a)} disabled={trabajando}>
                                <Trash2 size={14} />
                            </button>
                        </div>
                    ))}
                </section>

                {/* ─── Lo que se puede vincular ────────────────────────────────── */}
                <section className="aj-seccion">
                    <h4>
                        Notas de crédito en InfoManager
                        <button className="aj-btn chico" onClick={() => void buscarCandidatas()} disabled={buscando}>
                            {buscando ? <Loader2 size={13} className="girando" /> : <RefreshCw size={13} />} Buscar
                        </button>
                    </h4>
                    <p className="aj-ayuda">
                        Busca las notas de crédito de los clientes de esta hoja, desde su fecha en adelante.
                        Las que dicen <b>SEGUN HR {numero}</b> en las observaciones aparecen primero.
                    </p>

                    {(candidatas ?? []).map(c => {
                        const suyos = pedidosPorCliente.get(Number(c.cod_cliente)) ?? [];
                        return (
                            <div className={`aj-fila candidata${c.menciona_esta_hoja ? ' mencionada' : ''}`} key={c.im_ajuste_id}>
                                <div>
                                    <div className="aj-fila-tit">
                                        {c.tipo} {c.numero ?? '—'} <b>{money(c.importe)}</b>
                                        {c.menciona_esta_hoja && <span className="aj-tag">nombra esta hoja</span>}
                                    </div>
                                    <div className="aj-fila-meta">
                                        {c.fecha} · cliente {c.cod_cliente}
                                        {c.observaciones ? ` · ${c.observaciones}` : ''}
                                    </div>
                                    {/* Con un solo pedido del cliente no se pregunta nada. */}
                                    {suyos.length > 1 && (
                                        <select
                                            value={destino[c.im_ajuste_id] ?? ''}
                                            onChange={e => setDestino(d => ({ ...d, [c.im_ajuste_id]: e.target.value }))}
                                        >
                                            <option value="">¿A qué pedido?</option>
                                            {suyos.map(p => (
                                                <option key={p.im_comprobante_id} value={p.im_comprobante_id}>
                                                    PR {p.im_numero ?? '—'} · {money(Number(p.total ?? 0))}
                                                </option>
                                            ))}
                                        </select>
                                    )}
                                    {!suyos.length && (
                                        <div className="aj-fila-meta warn">Ese cliente no tiene pedidos en esta hoja.</div>
                                    )}
                                </div>
                                <button className="aj-btn" onClick={() => void vincular(c)} disabled={trabajando || !suyos.length}>
                                    <Link2 size={14} /> Vincular
                                </button>
                            </div>
                        );
                    })}
                </section>
            </div>
        </div>
    );
}
