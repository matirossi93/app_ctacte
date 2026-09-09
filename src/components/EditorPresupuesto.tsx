import { useMemo, useState } from 'react';
import { Save, Trash2, Plus, Search, AlertTriangle, Loader2, X } from 'lucide-react';
import { authHeaders } from '../utils/auth';
import './EditorPresupuesto.css';

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
    /** El id del renglón en IM. Los que se agregan acá todavía no tienen. */
    id?: number;
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

/** Las cuatro listas mayoristas, con el nombre que usa la oficina. */
const LISTAS: Array<[number, string]> = [[12, 'Lista 1'], [13, 'Lista 2'], [14, 'Lista 3'], [15, 'Lista 4']];

const money = (n: number) => '$' + Math.round(n).toLocaleString('es-AR');
/** El renglón como lo compara el server para decidir si alcanza con un PUT. */
const firma = (rs: ItemEditable[]) =>
    rs.map(r => `${r.cod_articulo}:${Number(r.cod_lista_precios)}:${Number(r.descuento_porc) || 0}`).join('|');

export function EditorPresupuesto({ comprobanteId, numero, itemsOriginales, onGuardado, onCancelar }: {
    comprobanteId: string;
    numero: number | null;
    itemsOriginales: ItemEditable[];
    /** Se llama con el comprobante resultante: puede ser otro si hubo que recrearlo. */
    onGuardado: (r: { modo: string; im_numero: number | null; aviso?: string | null }) => void;
    onCancelar: () => void;
}) {
    const [items, setItems] = useState<ItemEditable[]>(() => itemsOriginales.map(i => ({ ...i })));
    const [busqueda, setBusqueda] = useState('');
    const [resultados, setResultados] = useState<ArticuloBuscado[] | null>(null);
    const [buscando, setBuscando] = useState(false);
    const [guardando, setGuardando] = useState(false);
    const [error, setError] = useState<string | null>(null);

    /**
     * 🔑 Si cambia el surtido, la lista o un descuento, el presupuesto se rehace y CAMBIA DE
     * NÚMERO. Se avisa antes, no después: la oficina anota ese número.
     */
    const seRecrea = firma(items) !== firma(itemsOriginales);
    const hayCambios = seRecrea || items.some((it, i) => Number(it.cantidad) !== Number(itemsOriginales[i]?.cantidad));

    const total = useMemo(() => items.reduce((s, i) =>
        s + (Number(i.precio ?? 0) * Number(i.cantidad) * (1 - (Number(i.descuento_porc) || 0) / 100)), 0), [items]);

    function cambiar(idx: number, campo: keyof ItemEditable, valor: any) {
        setItems(xs => xs.map((x, i) => i === idx ? { ...x, [campo]: valor } : x));
    }

    async function buscar() {
        const q = busqueda.trim();
        if (q.length < 2) { setResultados([]); return; }
        setBuscando(true); setError(null);
        try {
            const r = await fetch(`/api/articulos/buscar?q=${encodeURIComponent(q)}`, { headers: authHeaders() });
            const d = await r.json().catch(() => null);
            if (!r.ok) throw new Error(d?.error ?? 'No se pudo buscar');
            setResultados(d.articulos ?? []);
        } catch (e: any) {
            setError(e?.message ?? 'Error de conexión');
        } finally {
            setBuscando(false);
        }
    }

    function agregar(a: ArticuloBuscado) {
        setItems(xs => [...xs, {
            cod_articulo: a.cod_articulo,
            descripcion: a.descripcion,
            cantidad: 1,
            // La lista del último renglón: casi siempre el pedido entero va en la misma.
            cod_lista_precios: xs[xs.length - 1]?.cod_lista_precios ?? 12,
            descuento_porc: 0,
            precio: a.precio_venta,
            equivalencia_um: a.equivalencia_um,
            unidad_de_medida: a.unidad_de_medida,
        }]);
        setBusqueda(''); setResultados(null);
    }

    async function guardar() {
        if (!items.length) { setError('Tiene que quedar al menos un producto.'); return; }
        if (items.some(i => !(Number(i.cantidad) > 0))) { setError('Hay un renglón con cantidad cero o vacía. Sacalo con el tacho o poné una cantidad.'); return; }
        if (seRecrea && !confirm(
            `Este cambio no se puede hacer sobre el mismo presupuesto: InfoManager sólo deja corregir cantidades.\n\n` +
            `Se va a crear un presupuesto NUEVO con estos datos y se va a anular el ${numero ?? ''}.\n\n` +
            `El número cambia. ¿Seguimos?`)) return;

        setGuardando(true); setError(null);
        try {
            const r = await fetch(`/api/presupuestos/${comprobanteId}/editar`, {
                method: 'PUT',
                headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    items: items.map(i => ({
                        cod_articulo: i.cod_articulo,
                        cantidad: Number(i.cantidad),
                        cod_lista_precios: Number(i.cod_lista_precios),
                        descuento_porc: Number(i.descuento_porc) || 0,
                        ...(i.precio != null ? { precio: i.precio } : {}),
                    })),
                }),
            });
            const d = await r.json().catch(() => null);
            if (!r.ok) throw new Error(d?.error ?? 'InfoManager no aceptó el cambio');
            onGuardado({ modo: d.modo, im_numero: d.im_numero ?? null, aviso: d.aviso ?? null });
        } catch (e: any) {
            setError(`${e?.message ?? 'Error de conexión'}. Fijate en InfoManager antes de reintentar.`);
        } finally {
            setGuardando(false);
        }
    }

    return (
        <div className="ed-root">
            {error && <div className="ed-aviso error"><AlertTriangle size={14} /> <span>{error}</span></div>}

            {/* 🔑 El aviso más importante de la pantalla: si el número va a cambiar, se dice antes. */}
            {seRecrea && (
                <div className="ed-aviso">
                    <AlertTriangle size={14} />
                    <span>
                        Cambiaste la lista, un descuento o los productos. InfoManager no deja hacer eso sobre
                        el mismo presupuesto, así que al guardar se <b>crea uno nuevo y se anula el {numero ?? 'actual'}</b>.
                        El número va a cambiar.
                    </span>
                </div>
            )}

            <table className="ed-tabla">
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
                        <tr key={`${it.cod_articulo}-${it.id ?? 'nuevo'}-${idx}`} className={it.id == null ? 'ed-nuevo' : ''}>
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
                                <input className="ed-cant" type="text" inputMode="decimal" value={String(it.cantidad)}
                                       onChange={e => cambiar(idx, 'cantidad', e.target.value.replace(',', '.'))} />
                            </td>
                            <td>
                                <select value={Number(it.cod_lista_precios) || 12}
                                        onChange={e => cambiar(idx, 'cod_lista_precios', Number(e.target.value))}>
                                    {LISTAS.map(([cod, nom]) => <option key={cod} value={cod}>{nom}</option>)}
                                </select>
                            </td>
                            <td className="n">
                                <input className="ed-desc" type="text" inputMode="decimal"
                                       value={String(it.descuento_porc ?? 0)}
                                       onChange={e => cambiar(idx, 'descuento_porc', e.target.value.replace(',', '.'))} />
                            </td>
                            <td className="n">
                                {it.precio != null
                                    ? money(Number(it.precio) * Number(it.cantidad) * (1 - (Number(it.descuento_porc) || 0) / 100))
                                    : '—'}
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
            </table>

            {/* ─── Agregar un producto ────────────────────────────────────────── */}
            <div className="ed-agregar">
                <div className="ed-buscar">
                    <Search size={14} />
                    <input type="text" value={busqueda} placeholder="Agregar un producto: escribí parte del nombre o el código"
                           onChange={e => setBusqueda(e.target.value)}
                           onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void buscar(); } }} />
                    <button className="ed-btn ghost chico" onClick={() => void buscar()} disabled={buscando || busqueda.trim().length < 2}>
                        {buscando ? <Loader2 size={13} className="ed-girando" /> : <Search size={13} />} Buscar
                    </button>
                    {resultados && (
                        <button className="ed-icono" title="Cerrar los resultados" onClick={() => { setResultados(null); setBusqueda(''); }}>
                            <X size={14} />
                        </button>
                    )}
                </div>
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

            <div className="ed-pie">
                <span className="ed-total">Total estimado <b>{money(total)}</b></span>
                <button className="ed-btn ghost chico" onClick={onCancelar} disabled={guardando}>Cancelar</button>
                <button className="ed-btn chico" onClick={() => void guardar()} disabled={guardando || !hayCambios}>
                    {guardando ? <Loader2 size={14} className="ed-girando" /> : <Save size={14} />}
                    {seRecrea ? ' Guardar (rehace el presupuesto)' : ' Guardar cantidades'}
                </button>
            </div>
        </div>
    );
}
