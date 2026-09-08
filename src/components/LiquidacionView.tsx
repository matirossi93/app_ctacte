import { useEffect, useState } from 'react';
import { Loader2, AlertTriangle, UserCheck, Printer } from 'lucide-react';
import { authHeaders } from '../utils/auth';
import './LiquidacionView.css';

/**
 * LO QUE ENTREGÓ CADA CHOFER EN EL MES. De acá sale un pago.
 *
 * Mati (08/09/2026): *"analizamos mes a mes las hojas de rutas porque **a ellos se les paga en
 * función a lo que entregan**. Eso tiene que estar perfecto y actualizado"*.
 *
 * 🔴 Dos cosas que la pantalla tiene que dejar ver, porque de eso depende que el número sea el
 * correcto:
 *  · Sólo se liquida lo de las hojas **cerradas**: una hoja abierta todavía puede cambiar. Lo que
 *    quedó sin cerrar se muestra aparte, en amarillo, para que se cierre antes de pagar.
 *  · El importe es lo despachado **menos las notas de crédito** por lo que volvió. Va desglosado:
 *    si el chofer discute el número, tiene que poder verse de dónde sale.
 */

interface ChoferLiq {
    chofer_id: string | null;
    chofer: string;
    hojas: number;
    pedidos: number;
    clientes: number;
    bultos: number;
    kg: number;
    /** Lo que salió en el camión, antes de descontar lo que volvió. */
    despachado: number;
    notas_credito: number;
    /** Lo que se entregó de verdad: la base del pago. */
    importe: number;
    numeros: number[];
}

interface TotalesLiq { hojas: number; pedidos: number; kg: number; importe: number }

const money = (n: number) => '$' + Math.round(n).toLocaleString('es-AR');
const kilos = (n: number) => n.toLocaleString('es-AR', { maximumFractionDigits: 0 }) + ' kg';
const mesActual = () => new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 7);
const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? '' : 's'}`;

export function LiquidacionView() {
    const [mes, setMes] = useState(mesActual());
    const [choferes, setChoferes] = useState<ChoferLiq[]>([]);
    const [totales, setTotales] = useState<TotalesLiq | null>(null);
    const [sinCerrar, setSinCerrar] = useState<{ hojas: number; importe: number } | null>(null);
    const [cargando, setCargando] = useState(true);
    const [error, setError] = useState<string | null>(null);
    /** Qué chofer tiene desplegados los números de sus hojas. */
    const [abierto, setAbierto] = useState<string | null>(null);

    /**
     * 🔴 De acá sale un pago, así que la pantalla NUNCA puede mostrar números de un mes bajo el
     * rótulo de otro. Tres cosas lo garantizan (las tres faltaban — auditoría del 08/09/2026):
     *  1. Se limpia antes de pedir: si falla, no queda el mes anterior debajo del selector nuevo.
     *  2. `vivo` descarta la respuesta si el mes ya cambió (mismo patrón que el arrastre de
     *     Hojas de ruta): con dos cambios rápidos ganaba la que llegaba última.
     *  3. Un `<input type="month">` a medio tipear reporta '' y el server caía al mes actual,
     *     contestando 200 con datos reales del mes equivocado. Sin mes no se pide nada.
     */
    useEffect(() => {
        if (!/^\d{4}-\d{2}$/.test(mes)) { setCargando(false); return; }
        let vivo = true;
        setCargando(true); setError(null);
        setChoferes([]); setTotales(null); setSinCerrar(null);
        (async () => {
            try {
                const r = await fetch(`/api/liquidacion?mes=${mes}`, { headers: authHeaders() });
                const d = await r.json().catch(() => null);
                if (!vivo) return;
                if (!r.ok) throw new Error(d?.error ?? 'No se pudo traer la liquidación');
                // Lo que contestó el server, no lo que dice el selector: si no coinciden, no se pinta.
                if (d?.mes && d.mes !== mes) return;
                setChoferes(d.choferes ?? []);
                setTotales(d.totales ?? null);
                setSinCerrar(d.sin_cerrar ?? null);
            } catch (e: any) {
                if (vivo) setError(e?.message ?? 'Error de conexión');
            } finally {
                if (vivo) setCargando(false);
            }
        })();
        return () => { vivo = false; };
    }, [mes]);

    /**
     * Mientras esta vista está abierta, imprimir saca SOLO la liquidación.
     * 🪤 La app se comporta como nativa (`html, body` en height:100% + overflow:hidden), así que
     * sin esto el impreso se recorta a lo que entraba en pantalla y las hojas de más abajo se
     * pierden SIN NINGÚN AVISO — ya pasó con el fraccionado: 23 filas de 120.
     */
    useEffect(() => {
        document.body.classList.add('lq-print-active');
        return () => document.body.classList.remove('lq-print-active');
    }, []);

    return (
        <div className="lq-root">
            <div className="lq-top">
                <label className="lq-mes">
                    Mes
                    <input type="month" value={mes} onChange={e => setMes(e.target.value)} />
                </label>
                {cargando && <Loader2 size={16} className="lq-girando" />}
                <button className="lq-btn ghost" onClick={() => window.print()} disabled={!choferes.length}>
                    <Printer size={14} /> Imprimir
                </button>
            </div>

            {error && <div className="lq-aviso error"><AlertTriangle size={14} /> {error}</div>}

            {/* 🔴 Antes de pagar hay que cerrar lo que falta: esas hojas todavía pueden cambiar. */}
            {!!sinCerrar?.hojas && (
                <div className="lq-aviso">
                    <AlertTriangle size={14} />
                    <span>
                        Quedan <b>{sinCerrar.hojas}</b> {sinCerrar.hojas === 1 ? 'hoja' : 'hojas'} sin cerrar por {money(sinCerrar.importe)}.
                        No entran en la liquidación hasta que se cierren.
                    </span>
                </div>
            )}

            {/* Sólo en el impreso: el selector de mes no se imprime y el papel quedaba sin
                ninguna referencia al período. */}
            <h2 className="lq-titulo-impreso">Liquidación de {mes}</h2>

            {totales && (
                <div className="lq-totales">
                    <div><span>Hojas cerradas</span><b>{totales.hojas}</b></div>
                    <div><span>Pedidos</span><b>{totales.pedidos}</b></div>
                    <div><span>Kilos</span><b>{kilos(totales.kg ?? 0)}</b></div>
                    <div className="importe"><span>Entregado en el mes</span><b>{money(totales.importe ?? 0)}</b></div>
                </div>
            )}

            {!cargando && !error && !choferes.length && (
                <div className="lq-vacio">
                    <UserCheck size={26} />
                    <span>No hay hojas cerradas en este mes.</span>
                    <small>Una hoja entra en la liquidación cuando se la cierra desde Hojas de ruta.</small>
                </div>
            )}

            {choferes.map(c => (
                <div className={`lq-chofer${c.chofer_id ? '' : ' sin-chofer'}`} key={c.chofer_id ?? 'sin'}>
                    <div className="lq-chofer-head" onClick={() => setAbierto(a => a === (c.chofer_id ?? 'sin') ? null : (c.chofer_id ?? 'sin'))}>
                        <span className="lq-nombre">{c.chofer}</span>
                        <span className="lq-meta">{plural(c.hojas, 'hoja')} · {plural(c.pedidos, 'pedido')} · {plural(c.clientes, 'cliente')} · {kilos(c.kg)}</span>
                        <b className="lq-importe">{money(c.importe)}</b>
                    </div>

                    {/* El desglose sólo aparece si hubo devoluciones: si no, es ruido. */}
                    {c.notas_credito > 0 && (
                        <div className="lq-desglose">
                            despachó {money(c.despachado)} · volvió {money(c.notas_credito)} en notas de crédito
                        </div>
                    )}

                    {abierto === (c.chofer_id ?? 'sin') && !!c.numeros?.length && (
                        <div className="lq-hojas">
                            Hojas: {[...c.numeros].sort((a, b) => a - b).join(' · ')}
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
}
