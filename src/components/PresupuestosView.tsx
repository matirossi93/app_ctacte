import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    AlertTriangle, Check, CircleAlert, Loader2, RefreshCw, ChevronRight, X, Package,
    MessageSquare, Printer,
} from 'lucide-react';
import { authHeaders } from '../utils/auth';
import { EditorPresupuesto } from './EditorPresupuesto';
import { imprimirComprobante } from '../utils/imprimirComprobante';
import { useRecargarAlVolver } from '../utils/recargarAlVolver';
import './PresupuestosView.css';

/**
 * ETAPA 1: el primer filtrado de Jorgelina.
 *
 * Mati (08/09/2026): *"debería haber una sección de presupuestos donde Jorgelina haría el primer
 * filtrado, viendo todas las diferencias en las listas, o stock y demás... y una vez que los
 * presupuestos ya están ok, recién ahí entra la parte de facturación"*.
 *
 * 🔑 Lo que decide si esta pantalla sirve es **cuánto se puede dejar de mirar**: los avisos van
 * separados por gravedad (uno es plata que la empresa pierde, el otro es un cliente al que le
 * cobran de más) y lo revisado queda marcado, así al día siguiente no se revisa dos veces.
 */

interface Revision {
    estado: 'aprobado' | 'observado';
    observacion: string | null;
    revisado_at: string;
}

interface Presupuesto {
    im_comprobante_id: string;
    im_numero: number | null;
    fecha: string | null;
    de_otro_dia: boolean;
    /** Lo que escribió el vendedor en el pedido, tal como está en InfoManager. */
    observaciones: string | null;
    /**
     * 🔴 La factura que este presupuesto YA tiene. `nuestra` = la emitimos desde el panel ·
     * `deducida` = hay una del mismo cliente por el mismo importe. Facturar uno que ya está
     * facturado emite una factura duplicada de verdad: pasó el 09/09/2026 con la 50401.
     */
    factura: { im_factura_id?: string; numero: number | null; tipo: string; fecha: string | null; origen: 'nuestra' | 'deducida' } | null;
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
    gravedad: { pierde_margen: number; cobra_de_mas: number };
    hoja_id: string | null;
    revision: Revision | null;
    /** Renglones que piden más de lo que hay en el depósito. */
    faltantes: Array<{ cod_articulo: number; descripcion: string; pedido: number; disponible: number | null }>;
    /** Cantidades que no cierran con el formato del producto (kilos donde van bultos). */
    avisos_cantidad: string[];
    stock_consultado: boolean;
}

interface ItemDetalle {
    id: number;
    cod_articulo: number;
    descripcion: string;
    unidad_de_medida: string | null;
    equivalencia_um: number | null;
    cantidad: number;
    cod_lista_precios: number | null;
    /** "Lista 2" en vez de 13: el código de IM no le dice nada a nadie en la oficina. */
    lista_nombre: string | null;
    /** BRUTO, el de lista: es el que hay que reenviarle a IM al editar. */
    precio: number | null;
    /** Con el descuento ya aplicado: es lo que se factura. */
    precio_neto: number | null;
    descuento_porc: number;
    importe: number | null;
    /** Cuánto hay en el depósito, en la misma unidad. Negativo = diferencia de inventario. */
    stock: number | null;
}

type Filtro = 'sin_revisar' | 'aprobados' | 'observados' | 'todos';

const money = (n: number) => '$' + Math.round(n).toLocaleString('es-AR');
const kilos = (n: number) => n.toLocaleString('es-AR', { maximumFractionDigits: 0 }) + ' kg';
const dia = (f: string | null) => (f ? `${f.slice(8, 10)}/${f.slice(5, 7)}` : '—');

export function PresupuestosView({ desde, hasta }: { desde: string; hasta: string }) {
    const [filas, setFilas] = useState<Presupuesto[]>([]);
    const [resumen, setResumen] = useState<any>(null);
    const [cargando, setCargando] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [aviso, setAviso] = useState<string | null>(null);
    const [filtro, setFiltro] = useState<Filtro>('sin_revisar');
    const [trabajando, setTrabajando] = useState<string | null>(null);
    /** Qué presupuesto tiene el detalle abierto, y sus renglones. */
    const [abierto, setAbierto] = useState<string | null>(null);
    const [items, setItems] = useState<ItemDetalle[] | null>(null);
    /** Las observaciones del comprobante abierto, para poder editarlas. */
    const [obsAbierto, setObsAbierto] = useState<string | null>(null);
    /** Cantidades tocadas a mano: id de renglón → cantidad nueva. */
    /** A quién se le está escribiendo el motivo de la observación. */
    const [observando, setObservando] = useState<string | null>(null);
    const [motivo, setMotivo] = useState('');

    const cargar = useCallback(async (refrescar = false) => {
        setCargando(true); setError(null);
        try {
            const r = await fetch(
                `/api/presupuestos?desde=${desde}&hasta=${hasta}${refrescar ? '&refrescar=1' : ''}`,
                { headers: authHeaders() });
            const d = await r.json().catch(() => null);
            if (!r.ok) throw new Error(d?.error ?? 'No se pudieron traer los presupuestos');
            setFilas(d.presupuestos ?? []);
            setResumen(d);
        } catch (e: any) {
            setError(e?.message ?? 'Error de conexión');
        } finally {
            setCargando(false);
        }
    }, [desde, hasta]);

    useEffect(() => { void cargar(); }, [cargar]);


    /**

     * 🔑 Al volver de InfoManager, recargar. Jorgelina edita allá y vuelve acá, y la pantalla

     * mostraba lo de antes (Mati, 09/09/2026). Va con `true` para saltear el cache del server:

     * justamente lo que cambió es lo que está guardado.

     */

    useRecargarAlVolver(() => { void cargar(true); });

    const visibles = useMemo(() => filas.filter(p => {
        if (filtro === 'todos') return true;
        if (filtro === 'sin_revisar') return !p.revision;
        if (filtro === 'aprobados') return p.revision?.estado === 'aprobado';
        return p.revision?.estado === 'observado';
    }), [filas, filtro]);

    /** Marca la revisión en la pantalla sin volver a pedir todo a InfoManager (son segundos). */
    function pintarRevision(id: string, revision: Revision | null) {
        setFilas(fs => fs.map(f => f.im_comprobante_id === id ? { ...f, revision } : f));
    }

    async function revisar(p: Presupuesto, estado: 'aprobado' | 'observado', observacion?: string) {
        setTrabajando(p.im_comprobante_id); setAviso(null);
        try {
            const r = await fetch(`/api/presupuestos/${p.im_comprobante_id}/revision`, {
                method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ estado, observacion, im_numero: p.im_numero, cod_cliente: p.cod_cliente }),
            });
            const d = await r.json().catch(() => null);
            if (!r.ok) { setAviso(d?.error ?? 'No se pudo guardar la revisión'); return; }
            pintarRevision(p.im_comprobante_id, { estado, observacion: observacion ?? null, revisado_at: new Date().toISOString() });
            setObservando(null); setMotivo('');
        } catch (e: any) {
            // Sin esto, con el server caído el botón se re-habilitaba y no pasaba nada: parecía
            // que se había guardado.
            setAviso(e?.message ?? 'No se pudo guardar la revisión: sin conexión con el servidor');
        } finally { setTrabajando(null); }
    }

    async function desmarcar(p: Presupuesto) {
        setTrabajando(p.im_comprobante_id);
        try {
            const r = await fetch(`/api/presupuestos/${p.im_comprobante_id}/revision`, {
                method: 'DELETE', headers: authHeaders(),
            });
            if (!r.ok) { setAviso('No se pudo deshacer la revisión'); return; }
            pintarRevision(p.im_comprobante_id, null);
        } catch (e: any) {
            setAviso(e?.message ?? 'No se pudo deshacer la revisión: sin conexión con el servidor');
        } finally { setTrabajando(null); }
    }

    /** Trae los renglones de un presupuesto. Separado de abrir/cerrar para poder RECARGARLO. */
    async function cargarDetalle(id: string) {
        setItems(null);
        try {
            const r = await fetch(`/api/presupuestos/${id}`, { headers: authHeaders() });
            const d = await r.json().catch(() => null);
            if (!r.ok) throw new Error(d?.error ?? 'No se pudo abrir el detalle');
            setItems(d.items ?? []);
            setObsAbierto(d.comprobante?.observaciones ?? '');
        } catch (e: any) {
            // 🪤 Sin esto, un fetch que fallaba dejaba `items` en null y el spinner giraba para
            // siempre, sin un solo mensaje.
            setAviso(e?.message ?? 'Error de conexión al traer el detalle');
            setAbierto(null);
        }
    }

    function abrirDetalle(p: Presupuesto) {
        if (abierto === p.im_comprobante_id) { setAbierto(null); setItems(null); return; }
        setAbierto(p.im_comprobante_id); setAviso(null);
        void cargarDetalle(p.im_comprobante_id);
    }

    /**
     * Guarda las cantidades corregidas.
     *
     * ⚠️ InfoManager sólo deja cambiar cantidades de renglones que YA existen: agregar o sacar
     * un producto obliga a anular y rehacer el comprobante. Se dice en pantalla en vez de
     * ofrecer algo que después falla.
     */

    return (
        <div className="pr-root">
            <div className="pr-top">
                <button className="pr-btn ghost" onClick={() => void cargar(true)} disabled={cargando}>
                    <RefreshCw size={15} className={cargando ? 'spin' : ''} /> Actualizar
                </button>
                <div className="pr-resumen">
                    <span><b>{filas.length}</b> presupuestos</span>
                    <span><b>{money(resumen?.totales?.importe ?? 0)}</b></span>
                    <span><b>{kilos(resumen?.totales?.kg ?? 0)}</b></span>
                    {(resumen?.pierde_margen ?? 0) > 0 && (
                        <span className="pr-chip grave" title="El vendedor usó una lista más barata de la que corresponde: la empresa pierde margen">
                            <AlertTriangle size={13} /> {resumen.pierde_margen} por debajo de lista
                        </span>
                    )}
                    {/* 🔑 Mati (08/09/2026): vender MÁS CARO de lo que corresponde **no es un
                        incumplimiento**, es decisión del vendedor — *"dejáselo solo como
                        comentario"*. Lo único que la empresa mide es que no se venda por debajo
                        del precio que pone. Por eso va en gris: el color fuerte queda para lo
                        que sí hay que corregir. Mismo criterio que la app de vendedores. */}
                    {(resumen?.cobra_de_mas ?? 0) > 0 && (
                        <span className="pr-chip nota" title="El vendedor cobró más caro de lo que habilita la cantidad. No es un error: es su decisión. Se muestra por si conviene revisarlo con el cliente.">
                            {resumen.cobra_de_mas} más caro que la lista
                        </span>
                    )}
                    {(resumen?.con_cantidad_rara ?? 0) > 0 && (
                        <span className="pr-chip grave" title="La cantidad coincide con los kilos del bulto: puede que hayan cargado kilos donde van bultos">
                            <AlertTriangle size={13} /> {resumen.con_cantidad_rara} con cantidad rara
                        </span>
                    )}
                    {(resumen?.ya_facturados ?? 0) > 0 && (
                        <span className="pr-chip facturado" title="Ya tienen su factura emitida: no hay que volver a facturarlos">
                            <Check size={13} /> {resumen.ya_facturados} ya facturados
                        </span>
                    )}
                    {(resumen?.sin_stock ?? 0) > 0 && (
                        <span className="pr-chip" title="Piden más de lo que hay en el depósito">
                            {resumen.sin_stock} sin stock
                        </span>
                    )}
                </div>
            </div>

            {/* El filtro por estado es la pantalla: lo que importa es qué FALTA revisar. */}
            <div className="pr-filtros">
                {([
                    ['sin_revisar', 'Sin revisar', filas.filter(f => !f.revision).length],
                    ['aprobados', 'Aprobados', filas.filter(f => f.revision?.estado === 'aprobado').length],
                    ['observados', 'Observados', filas.filter(f => f.revision?.estado === 'observado').length],
                    ['todos', 'Todos', filas.length],
                ] as Array<[Filtro, string, number]>).map(([k, txt, n]) => (
                    <button key={k} className={filtro === k ? 'on' : ''} onClick={() => setFiltro(k)}>
                        {txt} <b>{n}</b>
                    </button>
                ))}
            </div>

            {aviso && <div className="pr-aviso"><AlertTriangle size={15} /><span>{aviso}</span><button onClick={() => setAviso(null)}><X size={14} /></button></div>}
            {error && <div className="pr-aviso error"><AlertTriangle size={15} /><span>{error}</span></div>}

            {cargando && <div className="pr-cargando"><Loader2 className="spin" size={20} /> Trayendo los presupuestos de InfoManager…</div>}
            {!cargando && !visibles.length && (
                <div className="pr-vacio"><Package size={26} /><span>No hay presupuestos en este filtro.</span></div>
            )}

            {visibles.map(p => {
                const rev = p.revision;
                const abiertoEste = abierto === p.im_comprobante_id;
                return (
                    <div className={`pr-fila${rev ? ' ' + rev.estado : ''}`} key={p.im_comprobante_id}>
                        <div className="pr-fila-head">
                            <button className="pr-abrir" onClick={() => abrirDetalle(p)}>
                                <ChevronRight size={15} className={`pr-chevron${abiertoEste ? ' abierto' : ''}`} />
                                <div className="pr-fila-info">
                                    <div className="pr-cli">
                                        <span>{p.cliente_nombre}</span>
                                        {/* 🔴 Lo primero que hay que ver: si ya tiene factura, no se
                                            vuelve a facturar. */}
                                        {p.factura && (
                                            <span className={`pr-badge ${p.factura.origen === 'nuestra' ? 'facturado' : 'aviso'}`}
                                                  title={p.factura.origen === 'nuestra'
                                                      ? 'Se facturó desde el panel'
                                                      : `Hay una ${p.factura.tipo} del mismo cliente por el mismo importe${p.factura.fecha ? ` (${p.factura.fecha})` : ''}. InfoManager no guarda el vínculo, así que conviene verificarlo antes de facturar.`}>
                                                <Check size={11} /> {p.factura.tipo} {p.factura.numero ?? ''}
                                                {p.factura.origen === 'deducida' && ' ?'}
                                            </span>
                                        )}
                                        {p.gravedad?.pierde_margen > 0 && (
                                            <span className="pr-badge grave"><AlertTriangle size={11} /> por debajo de lista</span>
                                        )}
                                        {/* Más caro que la lista: comentario, no alerta (ver el chip de arriba). */}
                                        {p.gravedad?.pierde_margen === 0 && p.gravedad?.cobra_de_mas > 0 && (
                                            <span className="pr-badge nota" title="Se le cobró más caro de lo que habilita la cantidad. Es decisión del vendedor.">más caro</span>
                                        )}
                                        {/* Y lo que queda sin clasificar sigue siendo "mirá esto": son los
                                            descuentos fuera de tope, que sí son un problema. */}
                                        {p.gravedad?.pierde_margen === 0 && p.gravedad?.cobra_de_mas === 0 && p.avisos.length > 0 && (
                                            <span className="pr-badge aviso">revisar</span>
                                        )}
                                        {p.avisos_cantidad?.length > 0 && (
                                            <span className="pr-badge grave" title={p.avisos_cantidad.join(' · ')}>
                                                <AlertTriangle size={11} /> cantidad
                                            </span>
                                        )}
                                        {p.faltantes?.length > 0 && (
                                            <span className="pr-badge aviso" title={p.faltantes.map(f => `${f.descripcion}: piden ${f.pedido}, hay ${f.disponible}`).join(' · ')}>
                                                sin stock ({p.faltantes.length})
                                            </span>
                                        )}
                                        {rev?.estado === 'aprobado' && <span className="pr-badge ok"><Check size={11} /> aprobado</span>}
                                        {rev?.estado === 'observado' && <span className="pr-badge obs"><CircleAlert size={11} /> observado</span>}
                                        {p.hoja_id && <span className="pr-badge tenue">en una hoja</span>}
                                    </div>
                                    <div className="pr-meta">
                                        PR {p.im_numero ?? '—'} · {dia(p.fecha)} · {money(p.total)} · {p.bultos} bultos · {kilos(p.kg)}
                                        {p.zona && <> · {p.zona}</>}
                                        {p.renglones_sin_peso > 0 && (
                                            <span className="pr-sinpeso" title="Renglones sin peso en el catálogo: los kilos son un mínimo"> · {p.renglones_sin_peso} sin peso</span>
                                        )}
                                    </div>
                                    {/* 🔑 Dos observaciones distintas y no se pueden confundir: ésta es la
                                        del VENDEDOR y viaja en el presupuesto de InfoManager — es la que
                                        Jorgelina lee antes de facturar. La de abajo es la nuestra, la de
                                        la revisión. */}
                                    {p.observaciones && (
                                        <div className="pr-obs-im"><MessageSquare size={12} /> <span>{p.observaciones}</span></div>
                                    )}
                                    {rev?.observacion && <div className="pr-obs">Revisión: “{rev.observacion}”</div>}
                                </div>
                            </button>

                            <div className="pr-acciones">
                                {rev
                                    ? <button className="pr-btn ghost chico" onClick={() => void desmarcar(p)} disabled={trabajando === p.im_comprobante_id}>Deshacer</button>
                                    : <>
                                        <button className="pr-btn ok chico" onClick={() => void revisar(p, 'aprobado')} disabled={trabajando === p.im_comprobante_id}>
                                            <Check size={14} /> Aprobar
                                        </button>
                                        <button className="pr-btn ghost chico" onClick={() => { setObservando(p.im_comprobante_id); setMotivo(''); }} disabled={trabajando === p.im_comprobante_id}>
                                            Observar
                                        </button>
                                        {/* 🔑 Imprimir sin salir del panel (Mati, 09/09/2026). Si ya tiene
                                            factura, se imprime la factura; si no, el presupuesto. */}
                                        <button className="pr-btn ghost chico" title="Imprimir el presupuesto"
                                                onClick={() => imprimirComprobante(p.im_comprobante_id, 'Presupuesto')
                                                    .catch(e => setAviso(e?.message ?? 'No se pudo imprimir'))}>
                                            <Printer size={14} /> PR
                                        </button>
                                        {p.factura?.numero != null && (
                                            <button className="pr-btn ghost chico" title={`Imprimir la ${p.factura.tipo} ${p.factura.numero}`}
                                                    onClick={() => imprimirComprobante(String((p.factura as any).im_factura_id ?? ''), 'Factura')
                                                        .catch(e => setAviso(e?.message ?? 'No se pudo imprimir'))}>
                                                <Printer size={14} /> FA
                                            </button>
                                        )}
                                    </>}
                            </div>
                        </div>

                        {/* Observar pide el motivo: sin eso, al día siguiente nadie se acuerda. */}
                        {observando === p.im_comprobante_id && (
                            <div className="pr-observar">
                                <input
                                    autoFocus type="text" value={motivo} placeholder="¿Por qué queda frenado? (falta stock, precio a confirmar…)"
                                    onChange={e => setMotivo(e.target.value)}
                                    onKeyDown={e => { if (e.key === 'Enter' && motivo.trim()) void revisar(p, 'observado', motivo.trim()); }}
                                />
                                <button className="pr-btn chico" onClick={() => void revisar(p, 'observado', motivo.trim())} disabled={!motivo.trim()}>Guardar</button>
                                <button className="pr-btn ghost chico" onClick={() => setObservando(null)}>Cancelar</button>
                            </div>
                        )}

                        {abiertoEste && (
                            <div className="pr-detalle">
                                {/* El texto completo del control de listas: en la fila sólo entra el badge,
                                    y sin el detalle no se sabe QUÉ renglón está mal ni por qué. */}
                                {!!p.avisos.length && (
                                    <div className="pr-avisos">
                                        {p.avisos.map((a, i) => <div key={i}>· {a}</div>)}
                                    </div>
                                )}
                                {/* La cantidad que no cierra con el formato: es el control que más
                                    plata mueve (30 bolsas de 30 kg son 900 kg, no 30). */}
                                {!!p.avisos_cantidad?.length && (
                                    <div className="pr-avisos grave">
                                        {p.avisos_cantidad.map((a, i) => <div key={i}>· {a}</div>)}
                                    </div>
                                )}
                                {!!p.faltantes?.length && (
                                    <div className="pr-avisos">
                                        {p.faltantes.map(f => (
                                            <div key={f.cod_articulo}>· {f.descripcion}: piden <b>{f.pedido}</b> y en el depósito hay <b>{f.disponible}</b></div>
                                        ))}
                                    </div>
                                )}
                                {!items && <div className="pr-cargando chico"><Loader2 className="spin" size={16} /> Trayendo los renglones…</div>}
                                {items && !items.length && <div className="pr-cargando chico">Este presupuesto no tiene renglones.</div>}
                                {items && !!items.length && (
                                    <>
                                        {/* 🔑 Editar de verdad: cantidades, listas, descuentos, y agregar o
                                            sacar productos. Si el cambio no se puede hacer sobre el mismo
                                            comprobante, el editor avisa que se va a rehacer (Mati, 09/09/2026). */}
                                        <EditorPresupuesto
                                            comprobanteId={p.im_comprobante_id}
                                            numero={p.im_numero}
                                            observacionesOriginales={obsAbierto}
                                            itemsOriginales={items.map(it => ({
                                                id: it.id,
                                                cod_articulo: it.cod_articulo,
                                                descripcion: it.descripcion,
                                                cantidad: Number(it.cantidad),
                                                cod_lista_precios: it.cod_lista_precios,
                                                descuento_porc: it.descuento_porc ?? 0,
                                                precio: it.precio,
                                                equivalencia_um: it.equivalencia_um,
                                                unidad_de_medida: it.unidad_de_medida,
                                                stock: it.stock,
                                            }))}
                                            onCancelar={() => { setAbierto(null); setItems(null); setObsAbierto(null); }}
                                            onGuardado={(r) => {
                                                setAviso(r.aviso ?? (r.modo === 'recreado'
                                                    ? `Listo: se rehizo el presupuesto y ahora es el ${r.im_numero ?? ''}. Como cambió, quedó sin revisar.`
                                                    : 'Listo: cantidades corregidas en InfoManager.'));
                                                setAbierto(null); setItems(null); setObsAbierto(null);
                                                void cargar(true);
                                            }}
                                        />
                                    </>
                                )}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
