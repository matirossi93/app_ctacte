import { useOperacionReparto } from './RepartoContext';
import { useDialogoReparto, estiloDialogo } from '../utils/useDialogoReparto';
import { useLecturaVigente } from '../utils/useLecturaVigente';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { X, Loader2, Link2, Trash2, AlertTriangle, RefreshCw, FileMinus } from 'lucide-react';
import { authHeaders } from '../utils/auth';
import './AjustesHojaModal.css';

/**
 * EL NÚMERO FINAL DE LA HOJA: lo despachado, menos las notas de crédito, más las de débito.
 *
 * Mati (08/09/2026): *"una vez que vuelve el repartidor se hacen NC o facturas por dif de
 * mercadería y eso impacta en el num final de la hoja"*, y ese número es la base del pago al
 * chofer — *"a ellos se les paga en función a lo que entregan"*.
 *
 * 🔴 Acá se REGISTRA una nota que ya existe, no se emite ninguna. Los intentos de emitirla por la
 * API en el punto 777 fueron rechazados por la numeración (probado el 08 y el 11/09/2026); por
 * qué los rechaza IM internamente no lo sabemos. La nota se emite en la pantalla de IM como
 * siempre y desde acá se ata a la entrega: el importe, el tipo y el número los lee el server de
 * la nota real, nunca de lo que se tipeó en esta pantalla.
 *
 * 🪤 Vincular no devuelve mercadería ni reingresa stock, y tampoco crea una relación entre
 * comprobantes dentro de InfoManager: deja registrado en ESTA hoja que la nota le corresponde.
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
    /** Completo, con la letra: `NC B`, `ND A`. */
    tipo: string;
    /** `-1` resta, `+1` suma. Lo decide el tipo en InfoManager, no esta pantalla. */
    signo: -1 | 1;
    fecha: string;
    cod_cliente: number;
    importe: number;
    observaciones: string;
    /** La oficina escribe "SEGUN HR 3210" en las observaciones: esas van primero. */
    menciona_esta_hoja: boolean;
}

/** Una nota que afecta el total, venga del panel o del circuito de corrección de factura. */
interface Nota {
    im_ajuste_id: string;
    tipo: string;
    numero: number | null;
    importe: number;
    signo: -1 | 1;
    /**
     * De dónde sale. `correccion` = la emitió el circuito de corrección de factura; `ambas` = está
     * en el journal Y vinculada desde acá. En los dos casos el journal la sostiene, así que soltar
     * el vínculo no cambiaría el total.
     */
    origen: 'panel' | 'correccion' | 'ambas';
    ajuste_id: string | null;
    motivo: string | null;
    im_comprobante_id: string | null;
}

/** La entrega a la que se ata la nota, con la factura que le corresponde HOY. */
interface Entrega {
    im_comprobante_id: string;
    im_numero: number | null;
    cliente_nombre: string | null;
    cod_cliente: number | null;
    total: number | null;
    im_factura_id: string | null;
    im_factura_numero: number | null;
}

interface Totales {
    despachado: number;
    notas_credito: number;
    notas_debito: number;
    final: number;
    pendientes_de_emitir: number;
    /** 🔑 Con la hoja cerrada el server rechaza vincular y desvincular: hay que decirlo, no
        dejar que se descubra con un 409 después de esperar la consulta a InfoManager. */
    hoja: { version: number; id: string; numero: number; fecha: string; estado: string };
}

/**
 * 🔴 CON CENTAVOS, a diferencia del resto del panel.
 *
 * Acá se confirma un importe: redondeando, una nota de $12.500,51 se lee "12.501" y el operador
 * aprueba una cifra que nunca vio. En una lista que sólo se mira, el redondeo no engaña a nadie;
 * en un botón que graba, sí.
 */
const money = (n: number) => '$' + Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function AjustesHojaModal({ hojaId, numero, pedidos, onClose, onCambio }: {
    hojaId: string;
    numero: number;
    pedidos: Pedido[];
    onClose: () => void;
    /** Se llama cuando algo cambió, para que la pantalla de atrás se refresque. */
    onCambio: () => void;
}) {
    const operacion = useOperacionReparto('Vincular notas de entrega');
    const { iniciar: iniciarLectura } = useLecturaVigente(hojaId);
    const { iniciar: iniciarBusqueda, invalidar: invalidarBusqueda } = useLecturaVigente(`candidatas:${hojaId}`);
    const [requiereVerificar, setRequiereVerificar] = useState(false);
    const [totales, setTotales] = useState<Totales | null>(null);
    const [ajustes, setAjustes] = useState<Ajuste[]>([]);
    const [notas, setNotas] = useState<Nota[]>([]);
    const [entregas, setEntregas] = useState<Entrega[]>([]);
    const [candidatas, setCandidatas] = useState<Candidata[] | null>(null);
    const [cargando, setCargando] = useState(true);
    const [buscando, setBuscando] = useState(false);
    const [trabajando, setTrabajando] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [aviso, setAviso] = useState<string | null>(null);
    /** A qué pedido va cada nota, cuando el cliente tiene más de uno en la hoja. */
    const [destino, setDestino] = useState<Record<string, string>>({});

    const cargar = useCallback(async (forzar = false) => {
        const lectura = iniciarLectura(forzar); if (!lectura) return;
        setCargando(true); setError(null);
        try {
            const r = await fetch(`/api/hojas-ruta/${hojaId}/ajustes`, { headers: authHeaders(), signal: lectura.signal });
            const d = await r.json().catch(() => null);
            if (!lectura.vigente()) return;
            if (!r.ok) throw new Error(d?.error ?? 'No se pudieron traer los ajustes');
            setTotales(d); setRequiereVerificar(false); lectura.confirmar();
            setAjustes(d.ajustes ?? []);
            setNotas(d.notas ?? []);
            setEntregas(d.entregas ?? []);
        } catch (e: any) {
            if (!lectura.vigente()) return;
            setError(e?.message ?? 'Error de conexión');
        } finally {
            if (lectura.vigente()) setCargando(false);
        }
    }, [hojaId, iniciarLectura]);

    useEffect(() => { void cargar(); }, [cargar]);

    /**
     * Las notas de crédito del cliente que hay en InfoManager desde la fecha de la hoja.
     * Va contra IM, así que se pide cuando se aprieta el botón y no al abrir.
     */
    async function buscarCandidatas() {
        const lectura = iniciarBusqueda(true); if (!lectura) return;
        setBuscando(true); setError(null); setAviso(null);
        try {
            const r = await fetch(`/api/hojas-ruta/${hojaId}/ajustes/candidatas`, { headers: authHeaders(), signal: lectura.signal });
            const d = await r.json().catch(() => null);
            if (!lectura.vigente()) return;
            if (!r.ok) throw new Error(d?.error ?? 'No se pudieron traer las notas');
            setCandidatas(d.candidatas ?? []);
            if (!(d.candidatas ?? []).length) {
                setAviso('No hay notas sin registrar para los clientes de esta hoja. Emitila en InfoManager y volvé a buscar.');
            }
        } catch (e: any) {
            if (!lectura.vigente()) return;
            setError(e?.message ?? 'Error de conexión');
        } finally {
            if (lectura.vigente()) setBuscando(false);
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
        if (!comprobante) { setError('Elegí a qué entrega corresponde esa nota.'); return; }
        const entrega = entregas.find(e => e.im_comprobante_id === comprobante);
        if (!entrega?.im_factura_id) { setError('Esa entrega todavía no tiene una factura identificada. Conciliala antes de vincular.'); return; }
        if (requiereVerificar || !operacion.comenzar()) return;
        invalidarBusqueda(); setBuscando(false);
        setTrabajando(true); setError(null); setAviso(null);
        try {
            const r = await fetch(`/api/hojas-ruta/${hojaId}/ajustes/vincular`, {
                method: 'POST',
                headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    im_comprobante_id: comprobante, im_ajuste_id: c.im_ajuste_id,
                    version_esperada: totales?.hoja.version,
                    /**
                     * 🔴 Lo que se está viendo en pantalla, para que el server corte si cambió.
                     * NO es la fuente del importe: eso lo lee él de la nota real.
                     */
                    im_factura_id: entrega.im_factura_id,
                    esperado: { tipo: c.tipo, numero: c.numero, importe: c.importe },
                }),
            });
            const d = await r.json().catch(() => null);
            if (!r.ok) {
                // Si cambió algo desde que se mostró, la lista vieja ya no sirve.
                if (d?.recargar) { setCandidatas(null); invalidarBusqueda(); }
                throw new Error(d?.error ?? 'No se pudo vincular');
            }
            if (d?.advertencia) setAviso(d.advertencia);
            setCandidatas(cs => (cs ?? []).filter(x => x.im_ajuste_id !== c.im_ajuste_id));
            await cargar(true);
            onCambio();
        } catch (e: any) {
            setRequiereVerificar(true);
            setError(e?.message ?? 'Error de conexión');
        } finally {
            setTrabajando(false); operacion.terminar();
        }
    }

    async function desvincular(a: { id: string; tipo: string; numero: number | null; importe: number }) {
        if (!confirm(`¿Soltar la ${a.tipo} ${a.numero ?? ''} de ${money(a.importe)}?\n\nLa nota sigue existiendo en InfoManager: acá sólo se saca de esta hoja.`)) return;
        if (requiereVerificar || !operacion.comenzar()) return;
        invalidarBusqueda(); setBuscando(false);
        setTrabajando(true); setError(null);
        try {
            const r = await fetch(`/api/hojas-ruta/ajustes/${a.id}?version_esperada=${totales?.hoja.version}`, { method: 'DELETE', headers: authHeaders() });
            const d = await r.json().catch(() => null);
            if (!r.ok) throw new Error(d?.error ?? 'No se pudo soltar');
            await cargar(true);
            onCambio();
        } catch (e: any) {
            setRequiereVerificar(true);
            setError(e?.message ?? 'Error de conexión');
        } finally {
            setTrabajando(false); operacion.terminar();
        }
    }

    // Con la hoja cerrada todo lo que escribe da 409: se muestra en modo lectura.
    const cerrada = totales?.hoja?.estado === 'cerrada';

    const nombrePedido = (id: string) => {
        const p = pedidos.find(x => x.im_comprobante_id === id);
        return p ? `${p.cliente_nombre ?? 'Cliente'} · PR ${p.im_numero ?? '—'}` : id;
    };

    const cerrar = () => { if (!operacion.enCurso.current) onClose(); };
    const dialogo = useDialogoReparto(cerrar);
    return (
        <dialog ref={dialogo} style={estiloDialogo} aria-label={`Notas de crédito y débito de la hoja ${numero}`} className="aj-fondo" onClick={e => { if (e.target === e.currentTarget) cerrar(); }}>
            <fieldset disabled={trabajando} className="aj-modal" style={{ border: 0, margin: 0, minWidth: 0 }} onClick={e => e.stopPropagation()}>
                <header className="aj-head">
                    <h3><FileMinus size={17} /> Hoja {numero} — notas NC/ND</h3>
                    <button className="aj-cerrar" onClick={cerrar} aria-label="Cerrar notas de la hoja"><X size={18} /></button>
                </header>

                {requiereVerificar && <div className="aj-error" role="alert">Verificá el estado actual antes de otra modificación. <button disabled={cargando} onClick={() => void cargar(true)}>Volver a leer los vínculos</button></div>}
                {cargando && <div className="aj-cargando"><Loader2 size={20} className="girando" /> Cargando…</div>}

                {/* El número final, desglosado: quien lo mira tiene que ver de dónde sale. */}
                {totales && (
                    <div className="aj-totales">
                        <div><span>Despachado</span><b>{money(totales.despachado)}</b></div>
                        <div className="resta"><span>Notas de crédito</span><b>− {money(totales.notas_credito)}</b></div>
                        {totales.notas_debito > 0 && (
                            <div><span>Notas de débito</span><b>+ {money(totales.notas_debito)}</b></div>
                        )}
                        {/* 🪤 No dice "entregado": una nota es un ajuste de la CUENTA, y decir que
                            algo se entregó porque bajó el importe sería afirmar un hecho físico
                            que este número no conoce. */}
                        <div className="final"><span>Total ajustado · base de liquidación</span><b>{money(totales.final)}</b></div>
                    </div>
                )}

                {cerrada && (
                    <div className="aj-aviso">
                        <AlertTriangle size={14} />
                        {/* El texto va en un <span>: suelto, cada palabra es un flex item y el
                            aviso se dibuja en una columna de una palabra de ancho. */}
                        <span>
                            Esta hoja está <b>cerrada</b>: ya entró en la liquidación del chofer. Reabrila
                            desde Hojas de ruta si de verdad hay que ajustarla.
                        </span>
                    </div>
                )}

                {error && <div className="aj-error"><AlertTriangle size={14} /> {error}</div>}
                {aviso && <div className="aj-aviso"><AlertTriangle size={14} /> {aviso}</div>}

                {/* ─── Lo que ya afecta el total ───────────────────────────────── */}
                <section className="aj-seccion">
                    <h4>Notas de esta hoja ({notas.length})</h4>
                    {!notas.length && !cargando && (
                        <p className="aj-vacio">Ninguna todavía. Si el repartidor volvió con mercadería, la nota se emite en InfoManager y después se registra acá.</p>
                    )}
                    {/**
                      * 🔑 Están TODAS las que mueven el número, no sólo las que se ataron desde
                      * esta pantalla: una emitida por el circuito de corrección de factura ya
                      * descuenta igual, y si no se listara el total no cuadraría con lo que se ve.
                      * Ésas no tienen vínculo propio que soltar — borrar acá no las sacaría de
                      * ningún lado.
                      */}
                    {notas.map(n => (
                        <div className="aj-fila" key={n.im_ajuste_id}>
                            <div>
                                <div className="aj-fila-tit">
                                    {n.tipo} {n.numero ?? '—'}
                                    <b className={n.signo > 0 ? 'suma' : 'resta'}>
                                        {n.signo > 0 ? '+' : '−'} {money(n.importe)}
                                    </b>
                                </div>
                                <div className="aj-fila-meta">
                                    {n.im_comprobante_id ? nombrePedido(n.im_comprobante_id) : 'Corrección de factura'}
                                    {n.motivo ? ` · ${n.motivo}` : ''}
                                    {n.origen !== 'panel' && <span className="aj-tag"> desde corrección de factura</span>}
                                </div>
                            </div>
                            {n.ajuste_id ? (
                                <button className="aj-icono" title={cerrada ? 'La hoja está cerrada' : 'Sacar de esta hoja'}
                                    onClick={() => void desvincular({ id: n.ajuste_id!, tipo: n.tipo, numero: n.numero, importe: n.importe })}
                                    disabled={trabajando || requiereVerificar || cerrada}>
                                    <Trash2 size={14} />
                                </button>
                            ) : (
                                /* 🪤 Antes acá había un botón de sacar: la nota seguía descontando
                                   igual por el journal, así que prometía algo que no pasaba. */
                                /* 🪤 Y sin mandar a nadie a "sacarla desde la corrección": ahí
                                   tampoco hay un botón para eso. Lo que se sabe es que el total no
                                   cambiaría. */
                                <span className="aj-fila-meta" title="Forma parte de una corrección de factura; quitar el vínculo no cambiaría el total.">—</span>
                            )}
                        </div>
                    ))}

                    {/* Uno a medias no bajó ninguna cuenta corriente, así que no cuenta todavía. */}
                    {ajustes.filter(a => !a.emitido_at).map(a => (
                        <div className="aj-fila" key={a.id}>
                            <div>
                                <div className="aj-fila-tit">
                                    {a.im_ajuste_tipo ?? (a.tipo === 'nd' ? 'ND' : 'NC')} {a.im_ajuste_numero ?? '—'}
                                    <b>{money(a.importe)}</b>
                                </div>
                                <div className="aj-fila-meta">
                                    {nombrePedido(a.im_comprobante_id)} · {a.motivo}
                                    <b className="warn"> · sin emitir: no cuenta</b>
                                </div>
                            </div>
                            <button className="aj-icono" title={cerrada ? 'La hoja está cerrada' : 'Sacar de esta hoja'}
                                onClick={() => void desvincular({ id: a.id, tipo: a.im_ajuste_tipo ?? a.tipo.toUpperCase(), numero: a.im_ajuste_numero, importe: a.importe })}
                                disabled={trabajando || requiereVerificar || cerrada}>
                                <Trash2 size={14} />
                            </button>
                        </div>
                    ))}
                </section>

                {/* ─── Lo que se puede vincular ────────────────────────────────── */}
                <section className="aj-seccion">
                    <h4>
                        Notas en InfoManager
                        <button className="aj-btn chico" onClick={() => void buscarCandidatas()} disabled={buscando || cerrada}>
                            {buscando ? <Loader2 size={13} className="girando" /> : <RefreshCw size={13} />} Buscar
                        </button>
                    </h4>
                    <p className="aj-ayuda">
                        Busca las notas de crédito y débito de los clientes de esta hoja, desde su fecha en
                        adelante. Las que dicen <b>SEGUN HR {numero}</b> en las observaciones aparecen primero.
                        {/* 🪤 Sin prometer lo que no hace: no devuelve mercadería, no reingresa stock y no
                            relaciona los comprobantes dentro de InfoManager. */}
                        <br /><b>Vincular</b> registra la nota en esta hoja y ajusta su total.
                    </p>

                    {(candidatas ?? []).map(c => {
                        const suyos = pedidosPorCliente.get(Number(c.cod_cliente)) ?? [];
                        return (
                            <div className={`aj-fila candidata${c.menciona_esta_hoja ? ' mencionada' : ''}`} key={c.im_ajuste_id}>
                                <div>
                                    <div className="aj-fila-tit">
                                        {c.tipo} {c.numero ?? '—'}
                                        <b className={c.signo > 0 ? 'suma' : 'resta'}>{c.signo > 0 ? '+' : '−'} {money(c.importe)}</b>
                                        {c.menciona_esta_hoja && <span className="aj-tag">nombra esta hoja</span>}
                                    </div>
                                    <div className="aj-fila-meta">
                                        {c.fecha} · cliente {c.cod_cliente}
                                        {c.observaciones ? ` · ${c.observaciones}` : ''}
                                    </div>
                                    {/* 🔑 A qué factura va a parar: es lo que el server revalida bajo
                                        lock al confirmar, así que tiene que verse antes. */}
                                    {(() => {
                                        const elegido = destino[c.im_ajuste_id] ?? (suyos.length === 1 ? suyos[0].im_comprobante_id : '');
                                        const e = entregas.find(x => x.im_comprobante_id === elegido);
                                        if (!elegido) return null;
                                        return e?.im_factura_id
                                            ? <div className="aj-fila-meta">
                                                {/* 🔑 El cliente va SIEMPRE, aunque tenga una sola entrega y no
                                                    haya nada que elegir: sin el nombre, el número de factura
                                                    solo no alcanza para darse cuenta de que es otra persona. */}
                                                Se registra sobre la factura <b>{e.im_factura_numero ?? e.im_factura_id}</b>
                                                {e.cliente_nombre ? <> de <b>{e.cliente_nombre}</b></> : null}
                                              </div>
                                            : <div className="aj-fila-meta warn">Esa entrega todavía no tiene factura identificada: conciliala antes de vincular.</div>;
                                    })()}
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
                                <button className="aj-btn" onClick={() => void vincular(c)} disabled={trabajando || requiereVerificar || cerrada || !suyos.length}>
                                    <Link2 size={14} /> Vincular
                                </button>
                            </div>
                        );
                    })}
                </section>
            </fieldset>
        </dialog>
    );
}
