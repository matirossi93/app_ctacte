import { useEffect, useState } from 'react';

/** Hoy en Argentina (UTC-3 fija), que es con lo que trabaja la oficina. */
const hoyISO = () => new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
import { createPortal } from 'react-dom';
import { X, AlertTriangle, Loader2, Receipt, CheckCircle2, ShieldAlert } from 'lucide-react';
import { authHeaders } from '../utils/auth';
import './FacturarModal.css';

/**
 * ETAPA 2: emitir en InfoManager la factura y el remito de los presupuestos elegidos, que es lo
 * que hoy Jorgelina hace a mano comprobante por comprobante.
 *
 * 🔴 ES LO ÚNICO IRREVERSIBLE DE TODO EL PANEL. Una factura consume numeración fiscal y entra
 * en la cuenta corriente del cliente; el remito descuenta stock. Por eso la pantalla:
 *
 *  1. **Muestra primero qué va a salir**, comprobante por comprobante y con qué letra, sin
 *     emitir nada (`GET /api/facturacion/previa`). El botón recién aparece después de eso.
 *  2. **Dice qué NO se puede facturar y por qué** (cliente sin condición de IVA, presupuesto
 *     anulado en IM) en vez de descubrirlo a mitad de camino.
 *  3. **Avisa qué pasa si IM no contesta**: se frena la hoja entera, porque no se sabe si esa
 *     factura salió y reintentar sería facturarle dos veces al mismo cliente.
 *  4. **No se puede cerrar mientras emite.**
 */

type EstadoPedido = 'listo' | 'falta_remito' | 'facturado' | 'no_se_puede';

interface PedidoPrevio {
    im_comprobante_id: string;
    im_numero: number | null;
    cod_cliente: number;
    cliente_nombre: string | null;
    total: number;
    letra: 'A' | 'B' | null;
    estado: EstadoPedido;
    motivo: string | null;
    im_factura_numero: number | null;
    im_remito_numero: number | null;
    renglones: number;
}

interface Previa {
    pedidos: PedidoPrevio[];
    a_emitir: {
        facturas: number; remitos: number; clientes: number; total: number;
        letras: { A: number; B: number };
    };
    no_se_puede: number;
    ya_facturados: number;
    punto_de_venta: number;
}

interface Resultado {
    ok: boolean;
    facturados: number;
    hechos: Array<{ cliente: string | null; factura: number | null; remito: number | null; tipo: string }>;
    fallados: string[];
    cortado: string | null;
    quedan_sin_facturar: number;
}

const money = (n: number) =>
    '$' + new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

export function FacturarModal(
    { ids, desde, hasta, onClose }:
    { ids: string[]; desde: string; hasta: string; onClose: (huboCambios: boolean) => void },
) {
    const query = `ids=${ids.join(',')}&desde=${desde}&hasta=${hasta}`;
    const [previa, setPrevia] = useState<Previa | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [emitiendo, setEmitiendo] = useState(false);
    const [resultado, setResultado] = useState<Resultado | null>(null);
    /**
     * 🔴 Ya se apretó Emitir alguna vez en esta pantalla.
     *
     * El server emite de a un comprobante y una tanda de 5-10 pedidos se pasa de los ~30 s que
     * aguanta el proxy: el navegador recibe el corte MIENTRAS el server sigue emitiendo. Si el
     * botón quedara habilitado, el segundo clic manda los mismos pedidos y salen las facturas
     * dos veces. Después de intentar una vez, la única salida es cerrar y ver qué quedó.
     */
    const [intentado, setIntentado] = useState(false);
    /**
     * 🔑 Con qué fecha se emiten los comprobantes. Mati (09/09/2026): *"necesitamos poder cambiar
     * la fecha cuando se va a facturar"*: la oficina factura pedidos de días anteriores y la
     * factura tiene que llevar esa fecha, no la de hoy.
     */
    const [fechaEmision, setFechaEmision] = useState(hoyISO);

    useEffect(() => {
        fetch(`/api/facturacion/previa?${query}`, { headers: authHeaders() })
            .then(async r => {
                const d = await r.json().catch(() => null);
                if (!r.ok) throw new Error(d?.error ?? 'No se pudo revisar qué se puede facturar');
                setPrevia(d);
            })
            .catch(e => setError(e?.message ?? 'Error de conexión'));
    }, [query]);

    // Mientras se está emitiendo, cerrar la pestaña deja comprobantes emitidos a medias y sin
    // que nadie vea dónde quedó. El navegador pregunta antes de irse.
    useEffect(() => {
        if (!emitiendo) return;
        const frenar = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
        window.addEventListener('beforeunload', frenar);
        return () => window.removeEventListener('beforeunload', frenar);
    }, [emitiendo]);

    async function emitir() {
        if (emitiendo || intentado) return;          // un doble clic no emite dos veces
        setEmitiendo(true); setIntentado(true); setError(null);
        try {
            const r = await fetch('/api/facturacion', {
                method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids, desde, hasta, fecha_emision: fechaEmision }),
            });
            const d = await r.json().catch(() => null);
            if (!r.ok) throw new Error(d?.error ?? 'No se pudo facturar');
            setResultado(d);
        } catch (e: any) {
            // 🪤 Si se cortó la conexión con NUESTRO server, tampoco se sabe qué llegó a emitir:
            // el mensaje no puede decir "no se emitió nada".
            setError(`${e?.message ?? 'Error de conexión'}. **No se sabe qué llegó a emitirse**: puede que el servidor haya seguido emitiendo. Cerrá esta ventana, actualizá la lista y fijate qué quedó facturado ANTES de reintentar.`);
        } finally {
            setEmitiendo(false);
        }
    }

    const aEmitir = previa?.a_emitir;
    const puedeEmitir = !!aEmitir && (aEmitir.facturas > 0 || aEmitir.remitos > 0);
    const noSePuede = (previa?.pedidos ?? []).filter(p => p.estado === 'no_se_puede');
    // Si se intentó emitir, al cerrar SIEMPRE se recarga: aunque la respuesta no haya llegado,
    // del otro lado puede haber comprobantes nuevos.
    const cerrar = () => { if (!emitiendo) onClose(intentado || !!resultado); };

    return createPortal(
        <div className="fac-overlay" onClick={e => { if (e.target === e.currentTarget) cerrar(); }}>
            <div className="fac-modal">
                <div className="fac-head">
                    <Receipt size={17} />
                    <h2>Facturar {ids.length} {ids.length === 1 ? 'pedido' : 'pedidos'}</h2>
                    <button className="fac-cerrar" onClick={cerrar} disabled={emitiendo} title={emitiendo ? 'Esperá a que termine de emitir' : 'Cerrar'}>
                        <X size={18} />
                    </button>
                </div>

                {!previa && !error && (
                    <div className="fac-cargando"><Loader2 className="spin" size={20} /> Revisando en InfoManager qué se puede emitir…</div>
                )}
                {error && <div className="fac-alerta error"><AlertTriangle size={16} /><span>{error}</span></div>}

                {/* ─── Antes de emitir: exactamente qué va a salir ─────────────── */}
                {previa && !resultado && (
                    <>
                        <div className="fac-alerta grave">
                            <ShieldAlert size={18} />
                            <span>
                                Esto emite comprobantes <b>reales</b> en InfoManager: consume numeración fiscal,
                                entra en la cuenta corriente del cliente y el remito descuenta stock.
                                <b> No se puede deshacer desde acá</b> (se anula en IM).
                            </span>
                        </div>

                        <div className="fac-resumen">
                            <div><span className="fac-num">{aEmitir!.facturas}</span> facturas
                                {aEmitir!.facturas > 0 && <small> ({aEmitir!.letras.B} B · {aEmitir!.letras.A} A) · punto {previa.punto_de_venta}</small>}
                            </div>
                            <div><span className="fac-num">{aEmitir!.remitos}</span> remitos</div>
                            <div><span className="fac-num">{money(aEmitir!.total)}</span> a facturar</div>
                        </div>

                        {/* 🔑 La fecha del comprobante. La oficina factura pedidos de días
                            anteriores y la factura tiene que llevar ESA fecha (Mati, 09/09/2026). */}
                        <label className="fac-fecha">
                            Fecha de los comprobantes
                            <input type="date" value={fechaEmision} disabled={emitiendo}
                                   onChange={e => setFechaEmision(e.target.value)} />
                            {fechaEmision !== hoyISO() && (
                                <span className="fac-fecha-aviso">no es hoy</span>
                            )}
                        </label>

                        <table className="fac-tabla">
                            <thead>
                                <tr><th>Cliente</th><th>Pedido</th><th className="n">Importe</th><th>Qué sale</th></tr>
                            </thead>
                            <tbody>
                                {previa.pedidos.map(p => (
                                    <tr key={p.im_comprobante_id} className={`fac-fila ${p.estado}`}>
                                        <td>{p.cliente_nombre ?? `Cliente ${p.cod_cliente}`}</td>
                                        <td className="fac-pr">PR {p.im_numero ?? '—'}</td>
                                        <td className="n">{money(p.total)}</td>
                                        <td>
                                            {p.estado === 'listo' && <span className="fac-sale">Factura {p.letra} + remito</span>}
                                            {p.estado === 'falta_remito' && (
                                                <span className="fac-sale parcial">
                                                    Sólo el remito — la factura {p.im_factura_numero} ya se emitió
                                                </span>
                                            )}
                                            {p.estado === 'facturado' && (
                                                <span className="fac-hecho">
                                                    <CheckCircle2 size={13} /> FA {p.im_factura_numero ?? '—'} · RE {p.im_remito_numero ?? '—'}
                                                </span>
                                            )}
                                            {p.estado === 'no_se_puede' && <span className="fac-no">No se factura</span>}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>

                        {!!noSePuede.length && (
                            <div className="fac-alerta">
                                <AlertTriangle size={16} />
                                <div>
                                    <b>{noSePuede.length} pedido(s) NO se van a facturar</b> y quedan en la hoja:
                                    <ul>{noSePuede.map(p => <li key={p.im_comprobante_id}>{p.motivo}</li>)}</ul>
                                </div>
                            </div>
                        )}

                        <p className="fac-nota">
                            Se emite <b>de a un pedido por vez</b>. Si InfoManager deja de contestar, se frena
                            ahí mismo y el resto no se emite: no se sabe si esa factura salió y reintentar podría
                            facturarle dos veces al mismo cliente. Al terminar vas a ver qué se emitió y dónde se cortó.
                        </p>

                        <div className="fac-acciones">
                            <button className="fac-btn ghost" onClick={cerrar} disabled={emitiendo}>
                                {intentado ? 'Cerrar y revisar' : 'Cancelar'}
                            </button>
                            <button className="fac-btn emitir" onClick={() => void emitir()} disabled={!puedeEmitir || emitiendo || intentado}>
                                {emitiendo
                                    ? <><Loader2 className="spin" size={15} /> Emitiendo… no cierres esta pantalla</>
                                    : <><Receipt size={15} /> Emitir {[
                                        aEmitir!.facturas ? `${aEmitir!.facturas} factura${aEmitir!.facturas > 1 ? 's' : ''}` : '',
                                        aEmitir!.remitos ? `${aEmitir!.remitos} remito${aEmitir!.remitos > 1 ? 's' : ''}` : '',
                                    ].filter(Boolean).join(' y ')}</>}
                            </button>
                        </div>
                        {!puedeEmitir && !emitiendo && (
                            <p className="fac-nota">No hay nada para emitir en esta hoja.</p>
                        )}
                    </>
                )}

                {/* ─── Después: qué se emitió, qué falló y dónde se cortó ──────── */}
                {resultado && (
                    <>
                        {resultado.cortado && (
                            <div className="fac-alerta grave">
                                <ShieldAlert size={18} />
                                <span><b>Se frenó la hoja.</b> {resultado.cortado}</span>
                            </div>
                        )}

                        <div className="fac-resumen">
                            <div><span className="fac-num">{resultado.facturados}</span> emitidos</div>
                            <div><span className="fac-num">{resultado.quedan_sin_facturar}</span> quedan sin facturar</div>
                        </div>

                        {!!resultado.hechos.length && (
                            <table className="fac-tabla">
                                <thead><tr><th>Cliente</th><th>Factura</th><th>Remito</th></tr></thead>
                                <tbody>
                                    {resultado.hechos.map((h, i) => (
                                        <tr key={i} className="fac-fila facturado">
                                            <td>{h.cliente ?? '—'}</td>
                                            <td><CheckCircle2 size={13} /> {h.tipo} {h.factura ?? '—'}</td>
                                            <td>RE {h.remito ?? '—'}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}

                        {!!resultado.fallados.length && (
                            <div className="fac-alerta">
                                <AlertTriangle size={16} />
                                <div>
                                    <b>{resultado.fallados.length} no se pudieron facturar:</b>
                                    <ul>{resultado.fallados.map((f, i) => <li key={i}>{f}</li>)}</ul>
                                </div>
                            </div>
                        )}

                        <div className="fac-acciones">
                            <button className="fac-btn emitir" onClick={() => onClose(true)}>Listo</button>
                        </div>
                    </>
                )}
            </div>
        </div>,
        document.body,
    );
}
