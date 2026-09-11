import { useReparto, useOperacionReparto } from './RepartoContext';
import { useLecturaVigente } from '../utils/useLecturaVigente';
import { useEffect, useMemo, useState } from 'react';
import { Save, Trash2, Plus, Search, AlertTriangle, Loader2, X } from 'lucide-react';
import { authHeaders } from '../utils/auth';
import './EditorPresupuesto.css';
import { useControlListas } from '../utils/useControlListas';
import { DetalleCalculoListas } from './DetalleCalculoListas';
import { aplicarPrecioDeLista } from '../utils/precioDeLista';

/**
 * EDITAR EL PRESUPUESTO SIN IR A INFOMANAGER.
 *
 * Mati (09/09/2026): *"Jorgelina muchas veces tiene que editar los presupuestos... si no tiene
 * que estar cambiando de ventana a InfoManager y volver, es un chino"*. Y lo que lo hace
 * posible: *"por más que se anule y se haga un nuevo presupuesto, no importa"*.
 *
 * 🔑 Hay dos formas de guardar, y la pantalla lo dice ANTES de tocar nada:
 *  · Si sólo cambian cantidades, se corrige el mismo presupuesto y **el número no cambia**.
 *  · Si cambia la lista, el descuento o el surtido, InfoManager no lo permite sobre el mismo
 *    comprobante: se crea uno nuevo y se anula el viejo. **El número cambia**, y eso hay que
 *    saberlo antes de apretar el botón.
 */

export interface ItemEditable {
    uid?: string;
    /** El id del renglón en IM. Los que se agregan acá todavía no tienen. */
    id?: number;
    /**
     * Siempre un artículo del catálogo. El **costo de distribución** también: es el 13819, y lo
     * único que se le escribe es el precio (Mati, 09/09/2026).
     */
    cod_articulo: number;
    descripcion: string;
    cantidad: number;
    cod_lista_precios: number | null;
    descuento_porc?: number | null;
    precio?: number | null;
    equivalencia_um?: number | null;
    unidad_de_medida?: string | null;
    stock?: number | null;
}

interface ArticuloBuscado {
    cod_articulo: number;
    descripcion: string;
    unidad_de_medida: string | null;
    equivalencia_um: number | null;
    precio_venta: number | null;
}

/**
 * 🔑 El costo de distribución es un ARTÍCULO del catálogo, no un renglón suelto.
 *
 * La API de InfoManager no acepta renglones sin código: `cod_articulo` es obligatorio y con `0`
 * o vacío rechaza el presupuesto entero — por eso "no hacía nada" al guardar. El 13819 existe
 * justamente para esto y no tiene precio de lista: se escribe a mano.
 */
const COD_COSTO_DISTRIBUCION = 13819;

/** Las cuatro listas mayoristas, con el nombre que usa la oficina. */
const LISTAS: Array<[number, string]> = [[12, 'Lista 1'], [13, 'Lista 2'], [14, 'Lista 3'], [15, 'Lista 4']];

const money = (n: number) => '$' + Math.round(n).toLocaleString('es-AR');
/** El renglón como lo compara el server para decidir si alcanza con un PUT. */
const firma = (rs: ItemEditable[]) =>
    rs.map(r => `${r.cod_articulo}:${Number(r.cod_lista_precios)}:${Number(r.descuento_porc) || 0}:${Number(r.precio) || 0}`).join('|');

export function EditorPresupuesto({ comprobanteId, numero, huellaOriginal, itemsOriginales, observacionesOriginales, fechaOriginal, onGuardado, onCancelar, onBorrador }: {
    comprobanteId: string;
    huellaOriginal: string | null;
    numero: number | null;
    itemsOriginales: ItemEditable[];
    /** Lo que escribió el vendedor en InfoManager. Es lo que la oficina lee antes de facturar. */
    observacionesOriginales: string | null;
    /** La fecha del comprobante: es la que decide en qué día de reparto entra el pedido. */
    fechaOriginal: string | null;
    /** Se llama con el comprobante resultante: puede ser otro si hubo que recrearlo. */
    onGuardado: (r: { modo: string; im_numero: number | null; aviso?: string | null }) => void;
    onCancelar: () => void;
    onBorrador: (sucio: boolean) => void;
}) {
    const reparto = useReparto();
    const operacion = useOperacionReparto('Guardar presupuesto');
    const claveBorrador = `editor:${comprobanteId}`;
    const previo = reparto.borradores.get(claveBorrador);
    const [items, setItems] = useState<ItemEditable[]>(() => (previo?.items ?? itemsOriginales).map((i: ItemEditable) => ({ ...i, uid: i.uid ?? crypto.randomUUID() })));
    const [observaciones, setObservaciones] = useState<string>(previo?.observaciones ?? observacionesOriginales ?? '');
    const [fecha, setFecha] = useState<string>(previo?.fecha ?? fechaOriginal ?? '');
    const [busqueda, setBusqueda] = useState('');
    const [resultados, setResultados] = useState<ArticuloBuscado[] | null>(null);
    const [buscando, setBuscando] = useState(false);
    const [guardando, setGuardando] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [intentoPrecio, setIntentoPrecio] = useState(0);
    const [erroresPrecio, setErroresPrecio] = useState<Record<string, string>>({});
    const porCotizar = items.filter(i => i.cod_articulo !== COD_COSTO_DISTRIBUCION && i.precio == null);
    const claveCotizacion = JSON.stringify(porCotizar.map(i => ({ uid: i.uid!, cod_articulo: i.cod_articulo, cod_lista: i.cod_lista_precios })));
    useEffect(() => {
        const pendientes = JSON.parse(claveCotizacion) as Array<{ uid: string; cod_articulo: number; cod_lista: number }>;
        if (!pendientes.length) return;
        const ctrl = new AbortController();
        setErroresPrecio({});
        void (async () => {
            for (const p of pendientes) {
                if (ctrl.signal.aborted) return;
                try {
                    const r = await fetch(`/api/pedidos/precio?cod_articulo=${p.cod_articulo}&cod_lista=${p.cod_lista}`, { headers: authHeaders(), signal: ctrl.signal });
                    const d = await r.json();
                    if (ctrl.signal.aborted) return;
                    const cambio = r.ok ? aplicarPrecioDeLista({ precio: 0 }, d, p.cod_lista) : null;
                    if (!cambio) throw new Error('No se pudo consultar el precio.');
                    if (cambio.sinPrecio) throw new Error('Sin precio en esta lista. Elegí otra lista.');
                    setItems(xs => xs.map(i => i.uid === p.uid && i.cod_lista_precios === p.cod_lista && i.precio == null ? { ...i, precio: cambio.precio } : i));
                } catch (e: any) {
                    if (!ctrl.signal.aborted) setErroresPrecio(xs => ({ ...xs, [p.uid]: e?.message ?? 'No se pudo consultar el precio.' }));
                }
            }
        })();
        return () => ctrl.abort();
    }, [claveCotizacion, intentoPrecio]);
    const control = useControlListas(items.map(i => ({ cod_articulo: i.cod_articulo, cantidad: Number(i.cantidad), cod_lista: Number(i.cod_lista_precios), descuento_porc: Number(i.descuento_porc ?? 0) })), comprobanteId);
    const avisosLista = control?.datos?.avisos.flatMap(a => [a.severidad === 'margen' ? a.mensaje : null, a.mensaje_descuento].filter((x): x is string => !!x)) ?? [];

    /**
     * 🔑 Si cambia el surtido, la lista o un descuento, el presupuesto se rehace y CAMBIA DE
     * NÚMERO. Se avisa antes, no después: la oficina anota ese número.
     */
    const seRecrea = firma(items) !== firma(itemsOriginales);
    const cambiaObs = observaciones.trim() !== (observacionesOriginales ?? '').trim();
    const cambiaFecha = !!fecha && fecha !== (fechaOriginal ?? '');
    const hayCambios = seRecrea || cambiaObs || cambiaFecha
        || items.some((it, i) => Number(it.cantidad) !== Number(itemsOriginales[i]?.cantidad))
        || items.some((it, i) => Number(it.precio) !== Number(itemsOriginales[i]?.precio));

    useEffect(() => {
        if (hayCambios) reparto.borradores.set(claveBorrador, { items, observaciones, fecha });
        else reparto.borradores.delete(claveBorrador);
        onBorrador(hayCambios);
    }, [items, observaciones, fecha, hayCambios, claveBorrador, reparto.borradores, onBorrador]);
    const { iniciar: iniciarBusqueda, invalidar: invalidarBusqueda } = useLecturaVigente(busqueda.trim());
    const total = useMemo(() => items.reduce((s, i) =>
        s + (Number(i.precio ?? 0) * Number(i.cantidad) * (1 - (Number(i.descuento_porc) || 0) / 100)), 0), [items]);

    function cambiar(idx: number, campo: keyof ItemEditable, valor: any) {
        if (operacion.enCurso.current) return;
        setItems(xs => xs.map((x, i) => i === idx ? { ...x, [campo]: valor,
            ...(campo === 'cod_lista_precios' && x.cod_lista_precios !== valor && x.cod_articulo !== COD_COSTO_DISTRIBUCION ? { precio: null } : {}),
        } : x));
    }

    async function buscar() {
        if (operacion.enCurso.current) return;
        const lectura = iniciarBusqueda(true); if (!lectura) return;
        const q = busqueda.trim();
        if (q.length < 2) { setResultados([]); return; }
        setBuscando(true); setError(null);
        try {
            const r = await fetch(`/api/articulos/buscar?q=${encodeURIComponent(q)}`, { headers: authHeaders(), signal: lectura.signal });
            const d = await r.json().catch(() => null);
            if (!lectura.vigente()) return;
            if (!r.ok) throw new Error(d?.error ?? 'No se pudo buscar');
            setResultados(d.articulos ?? []);
        } catch (e: any) {
            if (lectura.vigente()) setError(e?.message ?? 'Error de conexión');
        } finally {
            if (lectura.vigente()) setBuscando(false);
        }
    }

    function agregar(a: ArticuloBuscado) {
        setItems(xs => [...xs, {
            uid: crypto.randomUUID(),
            cod_articulo: a.cod_articulo,
            descripcion: a.descripcion,
            cantidad: 1,
            // La lista del último renglón: casi siempre el pedido entero va en la misma.
            cod_lista_precios: xs[xs.length - 1]?.cod_lista_precios ?? 12,
            descuento_porc: 0,
            precio: null,
            equivalencia_um: a.equivalencia_um,
            unidad_de_medida: a.unidad_de_medida,
        }]);
        setBusqueda(''); setResultados(null);
    }

    async function guardar() {
        if (operacion.enCurso.current) return;
        if (!items.length) { setError('Tiene que quedar al menos un producto.'); return; }
        if (items.some(i => !(Number(i.cantidad) > 0))) { setError('Hay un renglón con cantidad cero o vacía. Sacalo con el tacho o poné una cantidad.'); return; }
        // 🪤 Sin precio InfoManager graba el renglón en $0 — no lo busca en la lista.
        const sinPrecio = items.find(i => !(Number(i.precio) > 0));
        if (sinPrecio) { setError(`"${sinPrecio.descripcion}" no tiene precio. Ponelo antes de guardar: InfoManager lo grabaría en $0.`); return; }
        if (seRecrea && !confirm(
            `Este cambio no se puede hacer sobre el mismo presupuesto: InfoManager sólo deja corregir cantidades.\n\n` +
            `Se va a crear un presupuesto NUEVO con estos datos y se va a anular el ${numero ?? ''}.\n\n` +
            `El número cambia. ¿Seguimos?`)) return;

        if (!operacion.comenzar()) return;
        invalidarBusqueda(); setBuscando(false); setGuardando(true); setError(null);
        try {
            const r = await fetch(`/api/presupuestos/${comprobanteId}/editar`, {
                method: 'PUT',
                headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    huella: huellaOriginal,
                    observaciones,
                    fecha,
                    items: items.map(i => ({
                        cod_articulo: i.cod_articulo,
                        cantidad: Number(i.cantidad),
                        cod_lista_precios: Number(i.cod_lista_precios),
                        descuento_porc: Number(i.descuento_porc) || 0,
                        // 🔑 BRUTO, el de lista: IM le aplica el descuento encima. Mandarle el ya
                        // rebajado lo descuenta dos veces (rompió la factura 50401 el 09/09/2026).
                        precio: Number(i.precio),
                    })),
                }),
            });
            const d = await r.json().catch(() => null);
            if (!r.ok) throw new Error(d?.error ?? 'InfoManager no aceptó el cambio');
            reparto.borradores.delete(claveBorrador);
            onBorrador(false);
            onGuardado({ modo: d.modo, im_numero: d.im_numero ?? null, aviso: d.aviso ?? null });
        } catch (e: any) {
            setError(`${e?.message ?? 'Error de conexión'}. Fijate en InfoManager antes de reintentar.`);
        } finally {
            setGuardando(false); operacion.terminar();
        }
    }

    return (
        <fieldset className="ed-root" disabled={guardando} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            {error && <div className="ed-aviso error"><AlertTriangle size={14} /> <span>{error}</span></div>}

            {/* 🔑 El aviso más importante de la pantalla: si el número va a cambiar, se dice antes. */}
            {seRecrea && (
                <div className="ed-aviso">
                    <AlertTriangle size={14} />
                    <span>
                        Al guardar se <b>crea un presupuesto nuevo y se anula el {numero ?? 'actual'}</b>. El número cambia.
                    </span>
                </div>
            )}

            {control?.datos && <DetalleCalculoListas control={control.datos} />}
            {control?.error && <div className="ed-aviso"><AlertTriangle size={14} /><span>{control.error}</span></div>}
            {!!avisosLista.length && <div className="ed-aviso error"><AlertTriangle size={14} /><div>{avisosLista.map((a, i) => <div key={i}>{a}</div>)}</div></div>}

            <div style={{ overflowX: 'auto', maxWidth: '100%' }}><table className="ed-tabla">
                <thead>
                    <tr>
                        <th>Producto</th>
                        <th className="n">Cantidad</th>
                        <th>Lista</th>
                        <th className="n">Desc. %</th>
                        <th className="n">Importe</th>
                        <th />
                    </tr>
                </thead>
                <tbody>
                    {items.map((it, idx) => (
                        <tr key={it.uid} className={it.id == null ? 'ed-nuevo' : ''}>
                            <td>
                                {it.descripcion}
                                {it.equivalencia_um != null && it.equivalencia_um !== 1 && (
                                    <span className="ed-um"> · {it.equivalencia_um} kg c/u</span>
                                )}
                                {it.id == null && <span className="ed-tag">nuevo</span>}
                                {/* Rojo cuando no alcanza el stock. Puede ser negativo: hay diferencias de inventario. */}
                                {it.stock != null && it.stock < Number(it.cantidad) && (
                                    <span className="ed-falta"> · hay {it.stock}</span>
                                )}
                            </td>
                            <td className="n">
                                <input aria-label={`Cantidad de ${it.descripcion}`} className="ed-cant" type="text" inputMode="decimal" value={String(it.cantidad)}
                                       onChange={e => cambiar(idx, 'cantidad', e.target.value.replace(',', '.'))} />
                            </td>
                            <td>
                                <select aria-label={`Lista de ${it.descripcion}`} value={Number(it.cod_lista_precios) || 12}
                                        onChange={e => cambiar(idx, 'cod_lista_precios', Number(e.target.value))}>
                                    {LISTAS.map(([cod, nom]) => <option key={cod} value={cod}>{nom}</option>)}
                                </select>
                            </td>
                            <td className="n">
                                <input aria-label={`Descuento de ${it.descripcion}`} className="ed-desc" type="text" inputMode="decimal"
                                       value={String(it.descuento_porc ?? 0)}
                                       onChange={e => cambiar(idx, 'descuento_porc', e.target.value.replace(',', '.'))} />
                            </td>
                            <td className="n">
                                {/* El costo de distribución no tiene precio de lista: se escribe.
                                    El resto muestra el importe ya calculado. */}
                                {it.cod_articulo === COD_COSTO_DISTRIBUCION ? (
                                    <input aria-label={`Precio de ${it.descripcion}`} className="ed-precio" type="text" inputMode="decimal"
                                           placeholder="Precio"
                                           value={it.precio != null ? String(it.precio) : ''}
                                           onChange={e => cambiar(idx, 'precio', e.target.value.replace(',', '.'))} />
                                ) : it.precio != null
                                    ? money(Number(it.precio) * Number(it.cantidad) * (1 - (Number(it.descuento_porc) || 0) / 100))
                                    : <span className="ed-precio-pendiente">{erroresPrecio[it.uid!] ?? 'Consultando precio…'}
                                        {erroresPrecio[it.uid!] && <button type="button" className="ed-btn ghost chico" onClick={() => setIntentoPrecio(n => n + 1)}>Reintentar</button>}
                                      </span>}
                            </td>
                            <td className="n">
                                {/* Sacar de verdad: el renglón desaparece. No queda en cantidad 0. */}
                                <button className="ed-icono" title="Sacar este producto"
                                        onClick={() => setItems(xs => xs.filter((_, i) => i !== idx))}>
                                    <Trash2 size={14} />
                                </button>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table></div>

            {/* ─── Agregar un producto ────────────────────────────────────────── */}
            <div className="ed-agregar">
                <div className="ed-buscar">
                    <Search size={14} />
                    <input type="text" value={busqueda} placeholder="Agregar un producto: escribí parte del nombre o el código"
                           onChange={e => { invalidarBusqueda(); setResultados(null); setBuscando(false); setBusqueda(e.target.value); }}
                           onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void buscar(); } }} />
                    <button className="ed-btn ghost chico" onClick={() => void buscar()} disabled={buscando || busqueda.trim().length < 2}>
                        {buscando ? <Loader2 size={13} className="ed-girando" /> : <Search size={13} />} Buscar
                    </button>
                    {resultados && (
                        <button className="ed-icono" title="Cerrar los resultados" onClick={() => { invalidarBusqueda(); setBuscando(false); setResultados(null); setBusqueda(''); }}>
                            <X size={14} />
                        </button>
                    )}
                </div>
                {/* 🔑 El costo de distribución es el artículo 13819 y su precio se escribe a mano:
                    no sale de ninguna lista (Mati, 09/09/2026). */}
                <button className="ed-btn ghost chico ed-libre-btn"
                        disabled={items.some(i => i.cod_articulo === COD_COSTO_DISTRIBUCION)}
                        onClick={() => setItems(xs => [...xs, {
                            uid: crypto.randomUUID(),
                            cod_articulo: COD_COSTO_DISTRIBUCION, descripcion: 'COSTO DE DISTRIBUCION', cantidad: 1,
                            cod_lista_precios: xs[xs.length - 1]?.cod_lista_precios ?? 12,
                            descuento_porc: 0, precio: null,
                        }])}>
                    <Plus size={13} /> Agregar costo de distribución
                </button>
                {resultados && (
                    <div className="ed-resultados">
                        {!resultados.length && <div className="ed-sinres">No encontré nada con eso.</div>}
                        {resultados.map(a => (
                            <button key={a.cod_articulo} className="ed-res" onClick={() => agregar(a)}>
                                <Plus size={13} />
                                <span>{a.descripcion}</span>
                                <small>#{a.cod_articulo}{a.precio_venta != null ? ` · ${money(a.precio_venta)}` : ''}</small>
                            </button>
                        ))}
                    </div>
                )}
            </div>

            <div className="ed-cabecera">
                {/* 🔑 La fecha decide en qué día de reparto entra el pedido. Mati (09/09/2026):
                    *"poder editar la fecha apenas llegan al panel, así lo redireccionamos a otra
                    fecha"*. */}
                <label className="ed-fecha">
                    <span>Fecha del pedido {cambiaFecha && <b className="ed-movida">se mueve de día</b>}</span>
                    <input type="date" value={fecha} onChange={e => setFecha(e.target.value)} />
                </label>

                {/* Lo que la oficina lee justo antes de facturar: "facturar a nombre de la SRL",
                    "entregar el jueves temprano". */}
                <label className="ed-obs">
                    <span>Observaciones del presupuesto</span>
                    <textarea value={observaciones} rows={2} maxLength={500}
                              placeholder="Lo que tiene que ver quien factura y quien entrega"
                              onChange={e => setObservaciones(e.target.value)} />
                </label>
            </div>

            <div className="ed-pie">
                <span className="ed-total">Total estimado <b>{porCotizar.length ? 'Pendiente de precio' : money(total)}</b></span>
                {hayCambios && <button className="ed-btn ghost chico" onClick={() => {
                    if (operacion.enCurso.current || !confirm('¿Descartar los cambios sin guardar de este presupuesto?')) return;
                    reparto.borradores.delete(claveBorrador); onBorrador(false); onCancelar();
                }}>Descartar cambios</button>}
                <button className="ed-btn ghost chico" onClick={() => { if (!operacion.enCurso.current) onCancelar(); }} disabled={guardando}>Cerrar</button>
                <button className="ed-btn chico" onClick={() => void guardar()} disabled={guardando || !hayCambios || !!porCotizar.length}>
                    {guardando ? <Loader2 size={14} className="ed-girando" /> : <Save size={14} />}
                    {seRecrea ? ' Guardar (rehace el presupuesto)' : ' Guardar cantidades'}
                </button>
            </div>
        </fieldset>
    );
}
