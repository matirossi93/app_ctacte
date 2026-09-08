import { useCallback, useEffect, useState } from 'react';
import { Loader2, AlertTriangle, Boxes, ChevronRight, RefreshCw } from 'lucide-react';
import { authHeaders } from '../utils/auth';
import './ConsolidadoView.css';

/**
 * CUÁNTO SE PIDIÓ DE CADA ARTÍCULO, CONTRA LO QUE HAY.
 *
 * Mati (08/09/2026): *"que Jo antes de facturar pueda ver con qué cantidad cuenta de cada
 * artículo y si hay algo que le falta, o si está más pedido de lo que hay, pueda avisar o pueda
 * **redistribuir esas cantidades entre los clientes** que hicieron el pedido"*.
 *
 * 🔑 Es una vista AGREGADA, y ésa es toda la gracia: el control que ya existía miraba un
 * presupuesto por vez, y así tres clientes que piden 200 con 300 en depósito parecen los tres
 * servibles. La pregunta —a quién le doy— sólo se contesta sumando primero.
 */

interface Quien {
    im_comprobante_id: string;
    im_numero: number | null;
    cod_cliente: number;
    cliente_nombre: string;
    cantidad: number;
    revision_estado: string | null;
    /** Lo que le tocaría si se reparte lo que hay en proporción a lo pedido. */
    sugerido: number;
}

interface Articulo {
    cod_articulo: number;
    descripcion: string;
    unidad_de_medida: string | null;
    equivalencia_um: number | null;
    pedido: number;
    /** null = no se pudo consultar el stock. NO es "no hay". */
    stock: number | null;
    falta: number | null;
    pedidos: number;
    quienes: Quien[];
}

const num = (n: number) => n.toLocaleString('es-AR', { maximumFractionDigits: 2 });

export function ConsolidadoView({ desde, hasta }: { desde: string; hasta: string }) {
    const [articulos, setArticulos] = useState<Articulo[]>([]);
    const [totales, setTotales] = useState<{ articulos: number; faltantes: number; sin_stock_consultado: boolean } | null>(null);
    const [cargando, setCargando] = useState(true);
    const [error, setError] = useState<string | null>(null);
    /** Sólo lo que no alcanza: es lo único que hay que resolver hoy. */
    const [soloFaltantes, setSoloFaltantes] = useState(true);
    const [abierto, setAbierto] = useState<number | null>(null);

    const cargar = useCallback(async (refrescar = false) => {
        setCargando(true); setError(null);
        try {
            const r = await fetch(
                `/api/presupuestos/consolidado?desde=${desde}&hasta=${hasta}${refrescar ? '&refrescar=1' : ''}`,
                { headers: authHeaders() });
            const d = await r.json().catch(() => null);
            if (!r.ok) throw new Error(d?.error ?? 'No se pudo armar el consolidado');
            setArticulos(d.articulos ?? []);
            setTotales(d.totales ?? null);
        } catch (e: any) {
            setError(e?.message ?? 'Error de conexión');
        } finally {
            setCargando(false);
        }
    }, [desde, hasta]);

    useEffect(() => { void cargar(); }, [cargar]);

    const visibles = soloFaltantes ? articulos.filter(a => (a.falta ?? 0) > 0) : articulos;

    return (
        <div className="co-root">
            <div className="co-top">
                <button className="co-btn ghost" onClick={() => void cargar(true)} disabled={cargando}>
                    <RefreshCw size={15} className={cargando ? 'co-girando' : ''} /> Actualizar
                </button>
                <label className="co-check">
                    <input type="checkbox" checked={soloFaltantes} onChange={e => setSoloFaltantes(e.target.checked)} />
                    Sólo lo que no alcanza
                </label>
                {totales && (
                    <div className="co-resumen">
                        <span><b>{totales.articulos}</b> artículos pedidos</span>
                        {totales.faltantes > 0 && (
                            <span className="co-chip grave"><AlertTriangle size={13} /> {totales.faltantes} sin stock suficiente</span>
                        )}
                    </div>
                )}
            </div>

            {error && <div className="co-aviso error"><AlertTriangle size={14} /> <span>{error}</span></div>}

            {/* 🔴 Que no se pueda consultar el stock NO es que no haya: la pantalla lo dice. */}
            {totales?.sin_stock_consultado && (
                <div className="co-aviso">
                    <AlertTriangle size={14} />
                    <span>No se pudo consultar el stock de InfoManager, así que no se puede saber qué falta. Los pedidos sí están bien sumados.</span>
                </div>
            )}

            {cargando && !articulos.length && (
                <div className="co-cargando"><Loader2 size={20} className="co-girando" /> Sumando los pedidos del rango…</div>
            )}

            {!cargando && !visibles.length && (
                <div className="co-vacio">
                    <Boxes size={26} />
                    <span>{soloFaltantes ? 'Alcanza el stock para todo lo pedido en este rango.' : 'No hay pedidos en este rango.'}</span>
                </div>
            )}

            {visibles.map(a => {
                const falta = (a.falta ?? 0) > 0;
                return (
                    <div className={`co-art${falta ? ' falta' : ''}`} key={a.cod_articulo}>
                        <button className="co-art-head" onClick={() => setAbierto(x => x === a.cod_articulo ? null : a.cod_articulo)}>
                            <ChevronRight size={15} className={`co-chevron${abierto === a.cod_articulo ? ' abierto' : ''}`} />
                            <div className="co-art-nom">
                                <span>{a.descripcion}</span>
                                <small>
                                    {a.pedidos} pedido{a.pedidos === 1 ? '' : 's'}
                                    {a.equivalencia_um != null && a.equivalencia_um !== 1 && ` · ${a.equivalencia_um} kg c/u`}
                                </small>
                            </div>
                            <div className="co-num"><span>Pedido</span><b>{num(a.pedido)}</b></div>
                            <div className="co-num"><span>Hay</span><b>{a.stock != null ? num(a.stock) : '—'}</b></div>
                            {falta
                                ? <div className="co-num falta"><span>Falta</span><b>{num(a.falta!)}</b></div>
                                : <div className="co-num ok"><span>Alcanza</span><b>✓</b></div>}
                        </button>

                        {abierto === a.cod_articulo && (
                            <div className="co-quienes">
                                {falta && (
                                    <p className="co-ayuda">
                                        No alcanza para todos. La columna <b>sugerido</b> reparte lo que hay en proporción
                                        a lo que pidió cada uno — es una propuesta para arrancar, la decisión es de la oficina.
                                    </p>
                                )}
                                <table>
                                    <thead>
                                        <tr>
                                            <th>Cliente</th><th className="n">Pidió</th>
                                            {falta && <th className="n">Sugerido</th>}
                                            <th>Estado</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {a.quienes.map(q => (
                                            <tr key={q.im_comprobante_id}>
                                                <td>
                                                    {q.cliente_nombre}
                                                    <small className="co-pr"> · PR {q.im_numero ?? '—'}</small>
                                                </td>
                                                <td className="n">{num(q.cantidad)}</td>
                                                {falta && <td className="n co-sug">{num(q.sugerido)}</td>}
                                                <td>
                                                    {q.revision_estado === 'aprobado' && <span className="co-tag ok">aprobado</span>}
                                                    {q.revision_estado === 'observado' && <span className="co-tag obs">observado</span>}
                                                    {!q.revision_estado && <span className="co-tag tenue">sin revisar</span>}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
