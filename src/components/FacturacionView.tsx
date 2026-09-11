import { seleccionVisible, alternarVisibles } from '../utils/lecturaVigente';
import { useLecturaVigente } from '../utils/useLecturaVigente';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AlertTriangle, Loader2, RefreshCw, Receipt, CheckCircle2, X, FileWarning, Printer, Pencil, Search, CalendarDays,
    DollarSign, Scale,
} from 'lucide-react';
import { authHeaders } from '../utils/auth';
import { coincide } from '../utils/buscar';
import { imprimirComprobante } from '../utils/imprimirComprobante';
import { useRecargarAlVolver } from '../utils/recargarAlVolver';
import { FacturarModal } from './FacturarModal';
import { CorregirFacturaModal } from './CorregirFacturaModal';
import { MoverFechaModal } from './MoverFechaModal';
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
    /** Las NC/ND que corrigen esta factura. El vínculo lo guardamos nosotros: IM no lo tiene. */
    notas?: Array<{ tipo: string; numero: number | null; total: number; im_comprobante_id: string; motivo: string | null }>;
    /** ¿La factura y el remito dicen lo mismo? Informativo: no habla de entrega ni de stock. */
    control_fa_re?: { estado: 'coinciden' | 'diferencias' | 'no_verificado'; texto: string; diferencias: Array<{ cod_articulo: number; factura: number; remito: number }>; checked_at: string | null } | null;
    im_factura_tipo: string | null;
    im_remito_numero: number | null;
    /** Los ids de InfoManager: es lo que hace falta para imprimir cada comprobante. */
    im_factura_id: string | null;
    im_remito_id: string | null;
    facturado_at: string | null;
    /**
     * 🔑 Lo que se anuló en InfoManager desde la última vez que se miró. Mati (10/09/2026): un
     * cliente rechazó un pedido, anularon la factura en IM y acá seguía figurando como vigente.
     */
    aviso_anulado?: string | null;
    /** La factura salió y el remito no: el reintento hace SÓLO el remito. */
    falta_remito: boolean;
    estado_emision?: string | null;
}

/**
 * Lo que las notas le cambian al importe de la factura: negativo si se le devolvió plata.
 * El signo lo da el tipo, no el total, que en la tabla siempre es positivo.
 */
const ajusteNotas = (notas?: Array<{ tipo: string; total: number }>) =>
    Math.round((notas ?? []).reduce((s, n) =>
        s + (/^NC/i.test(n.tipo) ? -1 : 1) * Math.abs(Number(n.total ?? 0)), 0) * 100) / 100;

const money = (n: number) => '$' + Math.round(n).toLocaleString('es-AR');
const dia = (f: string | null) => (f ? `${f.slice(8, 10)}/${f.slice(5, 7)}` : '—');
const requiereConciliar = (p: Fila) => ['anulado', 'incierto', 'factura_emitiendo', 'remito_emitiendo'].includes(p.estado_emision ?? '');

export function FacturacionView({ desde, hasta }: { desde: string; hasta: string }) {
    const [pendientes, setPendientes] = useState<Fila[]>([]);
    /** El buscador: filtra las dos listas (pendientes y facturados) sin volver a consultar IM. */
    const [busqueda, setBusqueda] = useState('');
    const [facturados, setFacturados] = useState<Fila[]>([]);
    /**
     * Qué factura se está corrigiendo. Mati (09/09/2026): los repartidores llaman desde la calle
     * porque se cargó mal una lista o un artículo, y corregirlo en IM con notas de crédito es
     * lento. Acá se edita la factura como si se pudiera y salen la NC y la ND solas.
     */
    const [corrigiendo, setCorrigiendo] = useState<string | null>(null);
    /** Mover la fecha de una factura emitida: es uno de los tres campos que IM deja tocar. */
    const [moviendoFecha, setMoviendoFecha] = useState<string | null>(null);
    const [totales, setTotales] = useState<any>(null);
    const [sinAprobar, setSinAprobar] = useState(0);
    const [cargando, setCargando] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [sel, setSel] = useState<Set<string>>(new Set());
    /** Los ids que se están facturando: mientras esté abierto, el modal manda. */
    const [facturando, setFacturando] = useState<{ ids: string[]; desde: string; hasta: string } | null>(null);

    const rangoSeleccion = useRef(`${desde}|${hasta}`);
    const { iniciar: iniciarLectura } = useLecturaVigente(`${desde}|${hasta}`);
    /**
     * 🔑 Comparaciones pedidas a mano, para los pares que el tablero no alcanzó a verificar.
     *
     * 🪤 Se descartan al cambiar el rango y al recargar: un resultado de otro contexto en
     * pantalla es peor que no tener ninguno. Y cada pedido lleva su número de contexto — una
     * respuesta que llega tarde, después de que cambió el rango, no pisa nada.
     */
    const [comparados, setComparados] = useState<Record<string, NonNullable<Fila['control_fa_re']> | 'cargando'>>({});
    /** Qué fila tiene el detalle abierto. Uno por vez: es información de consulta, no un panel fijo. */
    const [detalleControl, setDetalleControl] = useState<string | null>(null);
    const contexto = useRef(0);
    const enVuelo = useRef<AbortController | null>(null);
    /** De qué fila es la consulta en vuelo: hace falta para soltarle el "cargando" al abortarla. */
    const pidiendo = useRef<string | null>(null);

    /** Todo resultado puntual habla de los comprobantes de ESE momento: si algo cambia, se olvida. */
    const olvidarComparados = useCallback(() => {
        contexto.current += 1;
        enVuelo.current?.abort();
        enVuelo.current = null; pidiendo.current = null;
        setComparados({});
        setDetalleControl(null);
    }, []);
    useEffect(() => { olvidarComparados(); }, [desde, hasta, olvidarComparados]);
    // 🪤 Al desmontar: si no, una respuesta que llega después escribe sobre un componente muerto.
    useEffect(() => () => { enVuelo.current?.abort(); }, []);

    async function compararPar(p: Fila) {
        const id = p.im_comprobante_id;
        const mio = contexto.current;
        // 🪤 La identidad de los comprobantes AL PEDIR. Si la fila cambia de factura o de remito
        // mientras se consulta, la respuesta habla de otra cosa.
        const identidad = `${p.im_factura_id ?? ''}|${p.im_remito_id ?? ''}`;
        // 🔴 Al abortar el anterior hay que soltarle el "cargando": si no, ese botón queda
        // bloqueado hasta recargar la pantalla.
        if (enVuelo.current) {
            const previo = pidiendo.current;
            enVuelo.current.abort();
            if (previo) setComparados(c => { const n = { ...c }; delete n[previo]; return n; });
        }
        const ctrl = new AbortController();
        enVuelo.current = ctrl; pidiendo.current = id;
        setComparados(c => ({ ...c, [id]: 'cargando' }));
        setDetalleControl(id);
        const fallo = (texto: string) => ({ estado: 'no_verificado' as const, texto, diferencias: [], checked_at: null });
        const vigente = () => mio === contexto.current && !ctrl.signal.aborted;
        try {
            const r = await fetch(`/api/facturacion/comparar/${id}`, { headers: authHeaders(), signal: ctrl.signal });
            const d = await r.json().catch(() => null);
            if (!vigente()) return;
            // 🪤 La respuesta tiene que hablar de esta fila Y de estos comprobantes. Si no, se dice
            // —dejarlo en "cargando" bloquearía el botón para siempre—.
            const otraFila = r.ok && d?.control && String(d.im_comprobante_id ?? '') !== String(id);
            const fila = pendientes.concat(facturados).find(x => x.im_comprobante_id === id);
            const cambio = fila && `${fila.im_factura_id ?? ''}|${fila.im_remito_id ?? ''}` !== identidad;
            setComparados(c => ({ ...c, [id]: otraFila || cambio
                ? fallo('Los comprobantes cambiaron mientras se consultaba. Probá de nuevo.')
                : r.ok && d?.control ? { ...d.control, checked_at: d.checked_at ?? null }
                : fallo(d?.error ?? 'No se pudo comparar.') }));
        } catch (e: any) {
            if (e?.name === 'AbortError') return;   // lo limpia quien abortó
            if (vigente()) setComparados(c => ({ ...c, [id]: fallo('No se pudo comparar: sin conexión.') }));
        } finally {
            if (pidiendo.current === id) { enVuelo.current = null; pidiendo.current = null; }
        }
    }

    /** Lo que hay que mostrar de una fila: lo pedido a mano manda sobre lo que trajo el tablero. */
    const controlDe = (p: Fila) => {
        const c = comparados[p.im_comprobante_id];
        return c === 'cargando' ? 'cargando' : (c ?? p.control_fa_re ?? null);
    };

    const cargar = useCallback(async (refrescar = false, conservarDuranteLectura = false) => {
        const lectura = iniciarLectura(refrescar); if (!lectura) return;
        // 🪤 Lo comparado a pedido habla de los comprobantes que había: si se recarga, ya no
        // se puede afirmar que siga valiendo.
        contexto.current += 1; setComparados({});
        const mismoRango = rangoSeleccion.current === `${desde}|${hasta}`;
        if (rangoSeleccion.current !== `${desde}|${hasta}`) { setSel(new Set()); rangoSeleccion.current = `${desde}|${hasta}`; }
        if (!conservarDuranteLectura || !mismoRango) { setPendientes([]); setFacturados([]); setTotales(null); }
        avisarRecarga();
        setCargando(true); setError(null);
        try {
            const r = await fetch(
                `/api/facturacion?desde=${desde}&hasta=${hasta}${refrescar ? '&refrescar=1' : ''}`,
                { headers: authHeaders(), signal: lectura.signal });
            const d = await r.json().catch(() => null);
            if (!lectura.vigente()) return;
            if (!r.ok) throw new Error(d?.error ?? 'No se pudo traer lo que hay para facturar');
            setPendientes(d.pendientes ?? []);
            setFacturados(d.facturados ?? []);
            setTotales(d.totales ?? null);
            setSinAprobar(d.sin_aprobar ?? 0);
            setSel(s => new Set([...s].filter(id => (d.pendientes ?? []).some((p: Fila) => p.im_comprobante_id === id))));
            lectura.confirmar();
        } catch (e: any) {
            if (!lectura.vigente()) return;
            setPendientes([]); setFacturados([]); setTotales(null);
            setError(e?.message ?? 'Error de conexión');
        } finally {
            if (lectura.vigente()) setCargando(false);
        }
    }, [desde, hasta, iniciarLectura]);

    useEffect(() => { void cargar(); }, [cargar]);


    // 🔴 La más sensible de las tres: emitir sobre datos viejos factura lo que ya no es.

    const avisarRecarga = useRecargarAlVolver(() => { void cargar(true); });

    /**
     * 🔑 ¿EL REMITO SALE CON IMPORTES O SIN ELLOS?
     *
     * Mati (10/09/2026): *"necesito que el remito tenga la opción de valorizado o no valorizado,
     * porque necesitamos que salga sin importe muchas veces"*.
     *
     * Es un modo pegajoso y no una pregunta por remito: en una tanda se imprimen veinte seguidos
     * y contestar veinte veces lo mismo es peor que elegirlo una vez. Queda guardado entre
     * sesiones, y para que nadie imprima lo que no quería **el botón del remito dice cuál de los
     * dos va a salir** antes de apretarlo.
     */
    const [remitoValorizado, setRemitoValorizado] = useState(
        () => localStorage.getItem('fc_remito_sin_importe') !== '1');
    useEffect(() => {
        localStorage.setItem('fc_remito_sin_importe', remitoValorizado ? '0' : '1');
    }, [remitoValorizado]);

    const elegidos = useMemo(() => pendientes.filter(p => !requiereConciliar(p) && sel.has(p.im_comprobante_id)), [pendientes, sel]);
    const importeElegido = elegidos.reduce((s, p) => s + Number(p.total ?? 0), 0);
    const buscar = (p: Fila) => coincide(busqueda, [
        p.cliente_nombre, p.im_numero, p.cod_cliente, p.im_factura_numero, p.im_remito_numero,
        ...(p.notas ?? []).map(n => `${n.tipo} ${n.numero ?? ''}`)]);
    const visibles = useMemo(() => pendientes.filter(buscar), [pendientes, busqueda]);
    const facturadosVisibles = useMemo(() => facturados.filter(buscar), [facturados, busqueda]);

    const idsSeleccionables = visibles.filter(p => !requiereConciliar(p)).map(p => p.im_comprobante_id);
    const seleccion = seleccionVisible(idsSeleccionables, sel);
    const todosElegidos = seleccion.todos;

    function toggle(id: string) {
        setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
    }

    return (
        <div className="fc-root">
            <div className="fc-top">
                <button className="fc-btn ghost" onClick={() => void cargar(true)} disabled={cargando}>
                    <RefreshCw size={15} className={cargando ? 'spin' : ''} /> Actualizar
                </button>
                <div className="fc-buscador">
                    <Search size={14} />
                    <input aria-label="Buscar comprobantes" value={busqueda} onChange={e => setBusqueda(e.target.value)}
                           placeholder="Buscar cliente, PR, factura o remito…" />
                    {!!busqueda && <button onClick={() => setBusqueda('')} title="Limpiar"><X size={13} /></button>}
                </div>
                <button className={'fc-btn ghost fc-valorizado' + (remitoValorizado ? '' : ' apagado')}
                        onClick={() => setRemitoValorizado(v => !v)}
                        title={remitoValorizado
                            ? 'Los remitos se imprimen CON importes. Tocá para que salgan sin importe.'
                            : 'Los remitos se imprimen SIN importes. Tocá para que salgan valorizados.'}>
                    <DollarSign size={15} /> Remito {remitoValorizado ? 'valorizado' : 'sin importe'}
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

            {seleccion.ocultos > 0 && <div role="status">{seleccion.ocultos} seleccionados quedan fuera de la búsqueda.</div>}
            {/* 🔴 Cambios hechos en InfoManager, no acá: si no se dicen, la pantalla miente. */}
            {(() => {
                const anulados = [...pendientes, ...facturados].filter(p => p.aviso_anulado);
                if (!anulados.length) return null;
                return (
                    <div className="fc-aviso">
                        <AlertTriangle size={15} />
                        <span>
                            <b>Cambió algo en InfoManager:</b>{' '}
                            {anulados.map(p => `${p.cliente_nombre ?? p.cod_cliente} — ${p.aviso_anulado}`).join(' · ')}
                        </span>
                    </div>
                );
            })()}

            {/* Lo no aprobado no se puede facturar: se dice, para que no parezca que se perdió. */}
            {sinAprobar > 0 && (
                <p className="fc-nota"><b>{sinAprobar}</b> sin aprobar · Revisalos en Presupuestos.</p>
            )}
            {error && <div className="fc-aviso error"><AlertTriangle size={15} /><span>{error}</span></div>}

            {cargando && <div className="fc-cargando"><Loader2 className="spin" size={20} /> Trayendo lo aprobado…</div>}
            {!cargando && !error && !pendientes.length && (
                <div className="fc-vacio">
                    <CheckCircle2 size={26} />
                    <span>No queda nada aprobado sin facturar en estos días.</span>
                </div>
            )}

            {!!pendientes.length && (
                <div className="fc-tabla-scroll" role="region" aria-label="Comprobantes" tabIndex={0}><table className="fc-tabla">
                    <thead>
                        <tr>
                            <th className="c">
                                <input
                                    type="checkbox" title="Elegir todos"
                                    checked={todosElegidos}
                                    ref={el => { if (el) el.indeterminate = seleccion.parcial; }}
                                    onChange={() => setSel(s => alternarVisibles(idsSeleccionables, s))}
                                />
                            </th>
                            <th>Cliente</th><th>Pedido</th><th>Fecha</th>
                            <th className="n">Bultos</th><th className="n">Kilos</th><th className="n">Importe</th><th>Estado</th><th />
                        </tr>
                    </thead>
                    <tbody>
                        {visibles.map(p => (
                            <tr key={p.im_comprobante_id} className={sel.has(p.im_comprobante_id) ? 'sel' : ''}>
                                <td className="c">
                                    <input aria-label={`Elegir ${p.cliente_nombre} PR ${p.im_numero ?? p.im_comprobante_id}`} type="checkbox" disabled={requiereConciliar(p)} checked={sel.has(p.im_comprobante_id)} onChange={() => toggle(p.im_comprobante_id)} />
                                </td>
                                <td>{p.cliente_nombre}</td>
                                <td className="fc-pr">PR {p.im_numero ?? '—'}</td>
                                <td className="fc-pr">{dia(p.fecha)}</td>
                                <td className="n">{p.bultos}</td>
                                <td className="n">{Math.round(p.kg)}</td>
                                <td className="n">{money(p.total)}</td>
                                <td>
                                    {requiereConciliar(p)
                                        ? <span className="fc-badge grave">{p.estado_emision === 'anulado' ? 'factura anulada · requiere conciliación' : 'emisión por verificar'}</span>
                                        : p.falta_remito
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
                </table></div>
            )}

            {/* Lo emitido queda a la vista: en InfoManager el vínculo con el presupuesto no existe. */}
            {!!facturadosVisibles.length && (
                <details className="fc-facturados">
                    <summary>{facturadosVisibles.length} ya facturados en estos días</summary>
                    <div className="fc-tabla-scroll" role="region" aria-label="Comprobantes" tabIndex={0}><table className="fc-tabla">
                        <thead><tr><th>Cliente</th><th>Pedido</th><th>Factura</th><th>Remito</th><th className="n">Importe</th><th /></tr></thead>
                        <tbody>
                            {facturadosVisibles.map(p => (
                                <React.Fragment key={p.im_comprobante_id}>
                                <tr>
                                    <td>{p.cliente_nombre}</td>
                                    <td className="fc-pr">PR {p.im_numero ?? '—'}</td>
                                    <td><CheckCircle2 size={12} /> {p.im_factura_tipo ?? 'FA'} {p.im_factura_numero ?? '—'}</td>
                                    <td>RE {p.im_remito_numero ?? '—'}</td>
                                    <td className="n">
                                        {money(p.total + ajusteNotas(p.notas))}
                                        {/* 🔴 Lo que la factura decía antes de las notas: si sólo se
                                            ve el neto, nadie entiende por qué no coincide con la FA. */}
                                        {!!ajusteNotas(p.notas) && (
                                            <div className="fc-antes-notas">FA {money(p.total)}</div>
                                        )}
                                    </td>
                                    <td className="fc-imprimir-celda">
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
                                            <button className={'fc-imprimir' + (remitoValorizado ? '' : ' fc-sin-importe')}
                                                    title={`Imprimir el remito ${p.im_remito_numero ?? ''} ${remitoValorizado ? 'CON importes' : 'SIN importes'}`}
                                                    onClick={() => imprimirComprobante(String(p.im_remito_id), 'Remito', remitoValorizado)
                                                        .catch(e => setError(e?.message ?? 'No se pudo imprimir'))}>
                                                <Printer size={14} /> RE{remitoValorizado ? '' : ' s/$'}
                                            </button>
                                        )}
                                        {/**
                                          * 🔑 Comparar la factura con su remito.
                                          *
                                          * 🪤 El resultado se LEE, no se adivina de un tooltip: en el
                                          * celular no hay hover. El botón abre un detalle con los
                                          * códigos, las dos cantidades y a qué hora se miró.
                                          */}
                                        {p.im_factura_id && p.im_remito_id && (() => {
                                            const c = controlDe(p);
                                            const abierto = detalleControl === p.im_comprobante_id;
                                            const rotulo = c === 'cargando' ? ' Comparando…'
                                                : !c ? ' Comparar'
                                                : c.estado === 'coinciden' ? ' Coinciden'
                                                : c.estado === 'diferencias' ? ' Difieren' : ' Sin dato';
                                            return (
                                                <button className={'fc-imprimir fc-comparar' + (c && c !== 'cargando' ? ` e-${c.estado}` : '')}
                                                        aria-expanded={abierto}
                                                        disabled={c === 'cargando'}
                                                        onClick={() => {
                                                            if (abierto) { setDetalleControl(null); return; }
                                                            // Si el tablero ya lo verificó, sólo se abre; si no, se pide.
                                                            if (c && c !== 'cargando' && c.estado !== 'no_verificado') setDetalleControl(p.im_comprobante_id);
                                                            else void compararPar(p);
                                                        }}>
                                                    {c === 'cargando' ? <Loader2 size={13} className="spin" /> : <Scale size={13} />}
                                                    {rotulo}
                                                </button>
                                            );
                                        })()}
                                        {p.im_factura_id && (
                                            <button className="fc-imprimir fc-corregir"
                                                    title="Corregir con notas de crédito y débito: sacar, agregar o cambiar el precio de un producto"
                                                    onClick={() => { olvidarComparados(); setCorrigiendo(String(p.im_factura_id)); }}>
                                                <Pencil size={14} /> Corregir
                                            </button>
                                        )}
                                        {p.im_factura_id && (
                                            <button className="fc-imprimir fc-fecha"
                                                    title="Cambiar la fecha de la factura y su remito"
                                                    onClick={() => { olvidarComparados(); setMoviendoFecha(String(p.im_factura_id)); }}>
                                                <CalendarDays size={14} /> Fecha
                                            </button>
                                        )}
                                        {/* 🔑 Diferencia CONFIRMADA entre la factura y el remito: se ve
                                            acá. Las coincidencias y lo no verificado quedan en el botón,
                                            para no sumar un cartel por fila. */}
                                        {p.control_fa_re?.estado === 'diferencias' && (
                                            <span className="fc-chip grave fc-difieren" title={p.control_fa_re.texto}>
                                                <Scale size={12} /> FA ≠ RE
                                            </span>
                                        )}
                                        {/* 🔑 Cada nota se ve y se imprime desde acá. Mati (10/09/2026):
                                            *"tiene que aparecer en el panel para poder verla y también
                                            tenemos que poder imprimirla a la NC"*. */}
                                        {(p.notas ?? []).map(n => (
                                            <button key={n.im_comprobante_id}
                                                    className={'fc-imprimir fc-nota ' + (/^NC/i.test(n.tipo) ? 'nc' : 'nd')}
                                                    title={`Imprimir la ${n.tipo} ${n.numero ?? ''} por ${money(n.total)}${n.motivo ? ` — ${n.motivo}` : ''}`}
                                                    onClick={() => imprimirComprobante(n.im_comprobante_id,
                                                        /^NC/i.test(n.tipo) ? 'Nota de crédito' : 'Nota de débito')
                                                        .catch(e => setError(e?.message ?? 'No se pudo imprimir'))}>
                                                <Printer size={14} /> {n.tipo} {n.numero ?? ''}
                                            </button>
                                        ))}
                                    </td>
                                </tr>
                                {/**
                                  * 🔑 EL RESULTADO SE LEE, EN CUALQUIER PANTALLA.
                                  *
                                  * Los códigos, las dos cantidades y a qué hora se miró. Un `title`
                                  * no existe en el celular, que es donde más se consulta.
                                  */}
                                {detalleControl === p.im_comprobante_id && (() => {
                                    const c = controlDe(p);
                                    if (!c || c === 'cargando') return null;
                                    return (
                                        <tr className="fc-control-fila" key={`${p.im_comprobante_id}-control`}>
                                            <td colSpan={6}>
                                                <div className={`fc-control e-${c.estado}`}>
                                                    <div className="fc-control-top">
                                                        <Scale size={13} />
                                                        <span>{c.texto}</span>
                                                        {c.checked_at && (
                                                            <span className="fc-control-hora">
                                                                mirado a las {new Date(c.checked_at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}
                                                            </span>
                                                        )}
                                                        <button className="fc-control-cerrar" onClick={() => setDetalleControl(null)} aria-label="Cerrar"><X size={13} /></button>
                                                    </div>
                                                    {!!c.diferencias.length && (
                                                        <table className="fc-control-tabla">
                                                            <thead><tr><th>Artículo</th><th className="n">Factura</th><th className="n">Remito</th></tr></thead>
                                                            <tbody>
                                                                {c.diferencias.map(d => (
                                                                    <tr key={d.cod_articulo}>
                                                                        <td>{d.cod_articulo}</td>
                                                                        <td className="n">{d.factura}</td>
                                                                        <td className="n">{d.remito}</td>
                                                                    </tr>
                                                                ))}
                                                            </tbody>
                                                        </table>
                                                    )}
                                                    {c.estado === 'no_verificado' && (
                                                        <button className="fc-btn ghost chico" onClick={() => void compararPar(p)}>
                                                            <RefreshCw size={13} /> Comparar contra InfoManager
                                                        </button>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })()}
                            </React.Fragment>))}
                        </tbody>
                    </table></div>
                </details>
            )}

            {/* Barra de selección: siempre a la vista mientras haya algo elegido. */}
            {!!elegidos.length && (
                <div className="fc-barra">
                    <span><b>{elegidos.length}</b> elegidos · {money(importeElegido)}</span>
                    <button className="fc-btn ghost" onClick={() => setSel(new Set())}><X size={14} /> Deseleccionar</button>
                    <button className="fc-btn" onClick={() => setFacturando({ ids: elegidos.map(p => p.im_comprobante_id), desde, hasta })}>
                        <Receipt size={15} /> Facturar {elegidos.length}
                    </button>
                </div>
            )}

            {facturando && (
                <FacturarModal
                    ids={facturando.ids}
                    desde={facturando.desde}
                    hasta={facturando.hasta}
                    onClose={huboCambios => {
                        setFacturando(null);
                        if (huboCambios) void cargar(true);
                    }}
                />
            )}

            {corrigiendo && (
                <CorregirFacturaModal
                    idFactura={corrigiendo}
                    onCerrar={() => { setCorrigiendo(null); void cargar(true, true); }}
                    // Emitir una nota cambia el total del cliente: la pantalla tiene que releerlo.
                    onListo={() => void cargar(true)}
                />
            )}

            {moviendoFecha && (
                <MoverFechaModal
                    idFactura={moviendoFecha}
                    onCerrar={() => setMoviendoFecha(null)}
                    // La fecha cambió: las vistas van por rango y hay que releerlas.
                    onListo={() => { setMoviendoFecha(null); void cargar(true); }}
                />
            )}
        </div>
    );
}
