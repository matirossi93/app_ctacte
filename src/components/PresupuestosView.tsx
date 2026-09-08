import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    AlertTriangle, Check, CircleAlert, Loader2, RefreshCw, ChevronRight, X, Save, Package,
} from 'lucide-react';
import { authHeaders } from '../utils/auth';
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
    precio: number | null;
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
    /** Cantidades tocadas a mano: id de renglón → cantidad nueva. */
    const [editado, setEditado] = useState<Record<number, string>>({});
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
        setItems(null); setEditado({});
        try {
            const r = await fetch(`/api/presupuestos/${id}`, { headers: authHeaders() });
            const d = await r.json().catch(() => null);
            if (!r.ok) throw new Error(d?.error ?? 'No se pudo abrir el detalle');
            setItems(d.items ?? []);
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
    async function guardarCantidades(p: Presupuesto) {
        const cambios = Object.entries(editado)
            .map(([id, v]) => ({ id: Number(id), cantidad: Number(String(v).replace(',', '.')) }))
            .filter(c => Number.isFinite(c.cantidad) && c.cantidad > 0);
        if (!cambios.length) { setAviso('No cambiaste ninguna cantidad.'); return; }
        setTrabajando(p.im_comprobante_id); setAviso(null);
        try {
            const r = await fetch(`/api/presupuestos/${p.im_comprobante_id}/cantidades`, {
                method: 'PUT', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ items: cambios }),
            });
            const d = await r.json().catch(() => null);
            if (!r.ok) { setAviso(d?.error ?? 'InfoManager no aceptó el cambio'); return; }
            // (el catch de abajo cubre la caída de red)
            setEditado({});
            setAviso(d.revision_reiniciada
                ? `Listo: ${d.actualizados} renglón(es) corregidos. Como cambió el pedido, la aprobación se deshizo: revisalo de nuevo.`
                : `Listo: ${d.actualizados} renglón(es) corregidos en InfoManager.`);
            await cargarDetalle(p.im_comprobante_id);       // el detalle ya corregido
            void cargar(true);                              // y el importe del listado
        } catch (e: any) {
            setAviso(`${e?.message ?? 'Error de conexión'}. Fijate en InfoManager si el cambio entró antes de reintentar.`);
        } finally { setTrabajando(null); }
    }

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
                                    {rev?.observacion && <div className="pr-obs">“{rev.observacion}”</div>}
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
                                        <table className="pr-tabla">
                                            <thead>
                                                <tr><th>Producto</th><th className="n">Cantidad</th><th className="n">Stock</th><th className="n">Precio</th><th className="n">Importe</th><th>Lista</th></tr>
                                            </thead>
                                            <tbody>
                                                {items.map(it => (
                                                    <tr key={it.id}>
                                                        <td>
                                                            {it.descripcion}
                                                            {/* Kilos por bulto: es lo que dice si "30" son 30 kilos o 30 bolsas. */}
                                                            {it.equivalencia_um != null && it.equivalencia_um !== 1 && (
                                                                <span className="pr-um"> · {it.equivalencia_um} kg c/u</span>
                                                            )}
                                                            {it.unidad_de_medida && <span className="pr-um"> · {it.unidad_de_medida}</span>}
                                                        </td>
                                                        <td className="n">
                                                            <input
                                                                className="pr-cant" type="text" inputMode="decimal"
                                                                value={editado[it.id] ?? String(it.cantidad)}
                                                                onChange={e => setEditado(v => ({ ...v, [it.id]: e.target.value }))}
                                                            />
                                                        </td>
                                                        {/* Rojo cuando no alcanza. Puede ser negativo: hay diferencias de inventario. */}
                                                        <td className={`n${it.stock != null && it.stock < it.cantidad ? ' pr-falta' : ''}`}>
                                                            {it.stock != null ? it.stock.toLocaleString('es-AR', { maximumFractionDigits: 2 }) : '—'}
                                                        </td>
                                                        <td className="n">{it.precio != null ? money(it.precio) : '—'}</td>
                                                        <td className="n">{it.importe != null ? money(it.importe) : '—'}</td>
                                                        <td>{it.cod_lista_precios ?? '—'}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                        <div className="pr-detalle-pie">
                                            <span className="pr-nota">
                                                Se pueden corregir <b>cantidades</b>. Para agregar o sacar un producto hay que
                                                rehacer el pedido: InfoManager no deja cambiar el surtido de un presupuesto.
                                            </span>
                                            <button
                                                className="pr-btn chico"
                                                onClick={() => void guardarCantidades(p)}
                                                disabled={trabajando === p.im_comprobante_id || !Object.keys(editado).length}
                                            >
                                                <Save size={14} /> Guardar cantidades
                                            </button>
                                        </div>
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
