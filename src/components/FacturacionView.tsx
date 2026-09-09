import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    AlertTriangle, Loader2, RefreshCw, Receipt, CheckCircle2, X, FileWarning, Printer,
} from 'lucide-react';
import { authHeaders } from '../utils/auth';
import { imprimirComprobante } from '../utils/imprimirComprobante';
import { useRecargarAlVolver } from '../utils/recargarAlVolver';
import { FacturarModal } from './FacturarModal';
import './FacturacionView.css';

/**
 * ETAPA 2: facturar lo aprobado.
 *
 * Mati (08/09/2026): *"una vez que los presupuestos ya están ok, recién ahí entra la parte de
 * facturación y de ahí, con la factura y el remito hecho, se arma la hoja de ruta"*.
 *
 * 🔑 Acá sólo aparece lo **aprobado** en la etapa 1. Lo que todavía no se revisó se cuenta
 * aparte, para que se vea por qué no está en la lista y no parezca que se perdió.
 */

interface Fila {
    im_comprobante_id: string;
    im_numero: number | null;
    fecha: string | null;
    cod_cliente: number;
    cliente_nombre: string;
    zona: string;
    total: number;
    bultos: number;
    kg: number;
    im_factura_numero: number | null;
    im_factura_tipo: string | null;
    im_remito_numero: number | null;
    /** Los ids de InfoManager: es lo que hace falta para imprimir cada comprobante. */
    im_factura_id: string | null;
    im_remito_id: string | null;
    facturado_at: string | null;
    /** La factura salió y el remito no: el reintento hace SÓLO el remito. */
    falta_remito: boolean;
}

const money = (n: number) => '$' + Math.round(n).toLocaleString('es-AR');
const dia = (f: string | null) => (f ? `${f.slice(8, 10)}/${f.slice(5, 7)}` : '—');

export function FacturacionView({ desde, hasta }: { desde: string; hasta: string }) {
    const [pendientes, setPendientes] = useState<Fila[]>([]);
    const [facturados, setFacturados] = useState<Fila[]>([]);
    const [totales, setTotales] = useState<any>(null);
    const [sinAprobar, setSinAprobar] = useState(0);
    const [cargando, setCargando] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [sel, setSel] = useState<Set<string>>(new Set());
    /** Los ids que se están facturando: mientras esté abierto, el modal manda. */
    const [facturando, setFacturando] = useState<string[] | null>(null);

    const cargar = useCallback(async (refrescar = false) => {
        setCargando(true); setError(null);
        try {
            const r = await fetch(
                `/api/facturacion?desde=${desde}&hasta=${hasta}${refrescar ? '&refrescar=1' : ''}`,
                { headers: authHeaders() });
            const d = await r.json().catch(() => null);
            if (!r.ok) throw new Error(d?.error ?? 'No se pudo traer lo que hay para facturar');
            setPendientes(d.pendientes ?? []);
            setFacturados(d.facturados ?? []);
            setTotales(d.totales ?? null);
            setSinAprobar(d.sin_aprobar ?? 0);
            setSel(new Set());
        } catch (e: any) {
            setError(e?.message ?? 'Error de conexión');
        } finally {
            setCargando(false);
        }
    }, [desde, hasta]);

    useEffect(() => { void cargar(); }, [cargar]);


    // 🔴 La más sensible de las tres: emitir sobre datos viejos factura lo que ya no es.

    useRecargarAlVolver(() => { void cargar(true); });

    const elegidos = useMemo(() => pendientes.filter(p => sel.has(p.im_comprobante_id)), [pendientes, sel]);
    const importeElegido = elegidos.reduce((s, p) => s + Number(p.total ?? 0), 0);
    const todosElegidos = !!pendientes.length && elegidos.length === pendientes.length;

    function toggle(id: string) {
        setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
    }

    return (
        <div className="fc-root">
            <div className="fc-top">
                <button className="fc-btn ghost" onClick={() => void cargar(true)} disabled={cargando}>
                    <RefreshCw size={15} className={cargando ? 'spin' : ''} /> Actualizar
                </button>
                <div className="fc-resumen">
                    <span><b>{totales?.pendientes ?? 0}</b> para facturar</span>
                    <span><b>{money(totales?.importe_pendiente ?? 0)}</b></span>
                    {(totales?.facturados ?? 0) > 0 && <span><b>{totales.facturados}</b> ya facturados</span>}
                    {(totales?.falta_remito ?? 0) > 0 && (
                        <span className="fc-chip grave" title="La factura se emitió y el remito no: al facturar de nuevo sale sólo el remito">
                            <FileWarning size={13} /> {totales.falta_remito} sin remito
                        </span>
                    )}
                </div>
            </div>

            {/* Lo no aprobado no se puede facturar: se dice, para que no parezca que se perdió. */}
            {sinAprobar > 0 && (
                <div className="fc-aviso">
                    <AlertTriangle size={15} />
                    <span>Hay <b>{sinAprobar}</b> presupuesto(s) sin aprobar en estos días. Se revisan en <b>Presupuestos</b> y recién ahí se pueden facturar.</span>
                </div>
            )}
            {error && <div className="fc-aviso error"><AlertTriangle size={15} /><span>{error}</span></div>}

            {cargando && <div className="fc-cargando"><Loader2 className="spin" size={20} /> Trayendo lo aprobado…</div>}
            {!cargando && !pendientes.length && (
                <div className="fc-vacio">
                    <CheckCircle2 size={26} />
                    <span>No queda nada aprobado sin facturar en estos días.</span>
                </div>
            )}

            {!!pendientes.length && (
                <table className="fc-tabla">
                    <thead>
                        <tr>
                            <th className="c">
                                <input
                                    type="checkbox" title="Elegir todos"
                                    checked={todosElegidos}
                                    ref={el => { if (el) el.indeterminate = !!elegidos.length && !todosElegidos; }}
                                    onChange={() => setSel(todosElegidos ? new Set() : new Set(pendientes.map(p => p.im_comprobante_id)))}
                                />
                            </th>
                            <th>Cliente</th><th>Pedido</th><th>Fecha</th>
                            <th className="n">Bultos</th><th className="n">Kilos</th><th className="n">Importe</th><th>Estado</th><th />
                        </tr>
                    </thead>
                    <tbody>
                        {pendientes.map(p => (
                            <tr key={p.im_comprobante_id} className={sel.has(p.im_comprobante_id) ? 'sel' : ''}>
                                <td className="c">
                                    <input type="checkbox" checked={sel.has(p.im_comprobante_id)} onChange={() => toggle(p.im_comprobante_id)} />
                                </td>
                                <td>{p.cliente_nombre}</td>
                                <td className="fc-pr">PR {p.im_numero ?? '—'}</td>
                                <td className="fc-pr">{dia(p.fecha)}</td>
                                <td className="n">{p.bultos}</td>
                                <td className="n">{Math.round(p.kg)}</td>
                                <td className="n">{money(p.total)}</td>
                                <td>
                                    {p.falta_remito
                                        ? <span className="fc-badge grave">falta el remito (FA {p.im_factura_numero})</span>
                                        : <span className="fc-badge">aprobado</span>}
                                </td>
                                {/* 🔑 Imprimir desde acá también: el circuito entero tiene que poder
                                    sacar el papel sin volver a Presupuestos (Mati, 09/09/2026). */}
                                <td className="c">
                                    <button className="fc-imprimir" title="Imprimir el presupuesto"
                                            onClick={() => imprimirComprobante(p.im_comprobante_id, 'Presupuesto')
                                                .catch(e => setError(e?.message ?? 'No se pudo imprimir'))}>
                                        <Printer size={14} />
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}

            {/* Lo emitido queda a la vista: en InfoManager el vínculo con el presupuesto no existe. */}
            {!!facturados.length && (
                <details className="fc-facturados">
                    <summary>{facturados.length} ya facturados en estos días</summary>
                    <table className="fc-tabla">
                        <thead><tr><th>Cliente</th><th>Pedido</th><th>Factura</th><th>Remito</th><th className="n">Importe</th><th /></tr></thead>
                        <tbody>
                            {facturados.map(p => (
                                <tr key={p.im_comprobante_id}>
                                    <td>{p.cliente_nombre}</td>
                                    <td className="fc-pr">PR {p.im_numero ?? '—'}</td>
                                    <td><CheckCircle2 size={12} /> {p.im_factura_tipo ?? 'FA'} {p.im_factura_numero ?? '—'}</td>
                                    <td>RE {p.im_remito_numero ?? '—'}</td>
                                    <td className="n">{money(p.total)}</td>
                                    <td className="c fc-imprimir-celda">
                                        <button className="fc-imprimir" title="Imprimir el presupuesto"
                                                onClick={() => imprimirComprobante(p.im_comprobante_id, 'Presupuesto')
                                                    .catch(e => setError(e?.message ?? 'No se pudo imprimir'))}>
                                            <Printer size={14} /> PR
                                        </button>
                                        {p.im_factura_id && (
                                            <button className="fc-imprimir" title={`Imprimir la ${p.im_factura_tipo ?? 'factura'} ${p.im_factura_numero ?? ''}`}
                                                    onClick={() => imprimirComprobante(String(p.im_factura_id), 'Factura')
                                                        .catch(e => setError(e?.message ?? 'No se pudo imprimir'))}>
                                                <Printer size={14} /> FA
                                            </button>
                                        )}
                                        {p.im_remito_id && (
                                            <button className="fc-imprimir" title={`Imprimir el remito ${p.im_remito_numero ?? ''}`}
                                                    onClick={() => imprimirComprobante(String(p.im_remito_id), 'Remito')
                                                        .catch(e => setError(e?.message ?? 'No se pudo imprimir'))}>
                                                <Printer size={14} /> RE
                                            </button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </details>
            )}

            {/* Barra de selección: siempre a la vista mientras haya algo elegido. */}
            {!!elegidos.length && (
                <div className="fc-barra">
                    <span><b>{elegidos.length}</b> elegidos · {money(importeElegido)}</span>
                    <button className="fc-btn ghost" onClick={() => setSel(new Set())}><X size={14} /> Deseleccionar</button>
                    <button className="fc-btn" onClick={() => setFacturando(elegidos.map(p => p.im_comprobante_id))}>
                        <Receipt size={15} /> Facturar {elegidos.length}
                    </button>
                </div>
            )}

            {facturando && (
                <FacturarModal
                    ids={facturando}
                    desde={desde}
                    hasta={hasta}
                    onClose={huboCambios => {
                        setFacturando(null);
                        if (huboCambios) void cargar(true);
                    }}
                />
            )}
        </div>
    );
}
