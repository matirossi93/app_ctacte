import { useEffect, useState } from 'react';
import { Loader2, AlertCircle, Target } from 'lucide-react';
import { authHeaders } from '../utils/auth';
import { formatCurrency } from '../utils/formatters';
import { pctParaMostrar, type Historico, type CeldaMes } from '../utils/cumplimiento';
import './HistoricoObjetivos.css';

/**
 * El año completo de objetivos contra lo vendido, en una grilla vendedores × meses.
 *
 * Pedido de Mati (01/09/2026): él y Manolo definen los objetivos todos los meses y querían
 * ver la tendencia justo cuando los definen, sin ir mes por mes.
 *
 * Vive en su propio archivo porque lo usan dos pantallas distintas (la app de vendedores y
 * el panel viejo). La primera versión quedó embebida en el panel viejo — que casi nadie
 * abre — y Mati no la encontró por ningún lado.
 */

const MES_CORTO = ['E', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const MES_LARGO = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const money = (n: number | null | undefined) => (n == null ? '—' : formatCurrency(n));

/** Celda seleccionada: de quién y de qué mes, para el detalle en pesos de abajo. */
interface Sel { nombre: string; celda: CeldaMes }

export function HistoricoObjetivos({ yearActual }: { yearActual: number }) {
    const [year, setYear] = useState(yearActual);
    const [data, setData] = useState<Historico | null>(null);
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState<string | null>(null);
    const [sel, setSel] = useState<Sel | null>(null);

    useEffect(() => {
        let vivo = true;
        setLoading(true); setErr(null); setSel(null);
        fetch(`/api/goals/historico?year=${year}`, { headers: authHeaders() })
            .then(async r => {
                const j = await r.json();
                if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
                return j;
            })
            .then(j => { if (vivo) setData(j); })
            .catch(e => { if (vivo) setErr(e.message); })
            .finally(() => { if (vivo) setLoading(false); });
        return () => { vivo = false; };
    }, [year]);

    if (loading) return <div className="obj-loading"><Loader2 className="spin" /> Cargando histórico…</div>;
    if (err) return <div className="obj-error"><AlertCircle size={16} /> {err}</div>;
    if (!data) return null;

    const años = [yearActual, yearActual - 1, yearActual - 2];

    return (
        <div className="obj-hist">
            <div className="obj-hist-bar">
                <select className="obj-hist-year" value={year} onChange={e => setYear(Number(e.target.value))}
                    aria-label="Año del histórico">
                    {años.map(a => <option key={a} value={a}>{a}</option>)}
                </select>
                <span className="obj-hist-legend">
                    <i className="dot cumplio" /> cumplió
                    <i className="dot cerca" /> cerca
                    <i className="dot lejos" /> lejos
                </span>
            </div>

            {data.primerMesConObjetivo == null ? (
                <div className="obj-hist-vacio">
                    <Target size={28} />
                    <p>No hay objetivos cargados en {year}.</p>
                </div>
            ) : (
                <>
                    {/* Si los objetivos arrancaron a mitad de año, decirlo: una grilla con la
                        primera mitad vacía se lee como "no cumplieron", y no es eso. */}
                    {data.primerMesConObjetivo > 1 && (
                        <p className="obj-hist-nota">
                            Los objetivos de {year} arrancan en {MES_LARGO[data.primerMesConObjetivo - 1]}.
                            Los meses anteriores están vacíos porque no se cargaron, no porque no se hayan cumplido.
                        </p>
                    )}

                    <div className="obj-hist-scroll">
                        <table className="obj-hist-table">
                            <thead>
                                <tr>
                                    <th className="sticky">Vendedor</th>
                                    {MES_CORTO.map((m, i) => <th key={i} title={MES_LARGO[i]}>{m}</th>)}
                                    <th className="obj-hist-resumen">Año</th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.filas.map(f => (
                                    <tr key={f.cod_vendedor}>
                                        <th className="sticky">{f.nombre}</th>
                                        {f.meses.map(c => (
                                            <Celda key={c.month} celda={c}
                                                activa={sel?.nombre === f.nombre && sel?.celda.month === c.month}
                                                onClick={() => setSel({ nombre: f.nombre, celda: c })} />
                                        ))}
                                        <td className="obj-hist-resumen">
                                            {f.conObjetivo === 0 ? '—' : (
                                                <>
                                                    <strong>{pctParaMostrar(f.promedio ?? 0)}%</strong>
                                                    <small>cumplió {f.cumplidos} de {f.conObjetivo}</small>
                                                </>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                                <tr className="obj-hist-equipo">
                                    <th className="sticky">Equipo</th>
                                    {data.equipo.map(c => (
                                        <Celda key={c.month} celda={c}
                                            activa={sel?.nombre === 'Equipo' && sel?.celda.month === c.month}
                                            onClick={() => setSel({ nombre: 'Equipo', celda: c })} />
                                    ))}
                                    <td className="obj-hist-resumen">—</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    {sel ? (
                        <div className="obj-hist-detalle">
                            <div className="obj-hist-detalle-head">
                                <strong>{sel.nombre}</strong>
                                <span>{MES_LARGO[sel.celda.month - 1]} {year}</span>
                            </div>
                            {sel.celda.target == null ? (
                                <p className="obj-hist-detalle-nota">
                                    {sel.celda.estado === 'futuro'
                                        ? 'Este mes todavía no llegó.'
                                        : `Sin objetivo cargado. Vendió ${money(sel.celda.neto)}.`}
                                </p>
                            ) : (
                                <div className="obj-hist-detalle-figs">
                                    <div><span className="k">Objetivo</span><span className="v">{money(sel.celda.target)}</span></div>
                                    <div><span className="k">Vendido</span><span className="v gold">{money(sel.celda.neto)}</span></div>
                                    <div><span className="k">Diferencia</span><span className="v">{money(sel.celda.neto - sel.celda.target)}</span></div>
                                    <div>
                                        <span className="k">Cumplimiento</span>
                                        <span className="v">{pctParaMostrar(sel.celda.pct ?? 0)}%
                                            {sel.celda.estado === 'en_curso' && <small> (mes en curso)</small>}
                                        </span>
                                    </div>
                                </div>
                            )}
                        </div>
                    ) : (
                        <p className="obj-hist-hint">Tocá cualquier mes para ver el objetivo y lo vendido en pesos.</p>
                    )}
                </>
            )}
        </div>
    );
}

function Celda({ celda, activa, onClick }: { celda: CeldaMes; activa: boolean; onClick: () => void }) {
    const vacia = celda.estado === 'futuro' || celda.estado === 'sin_objetivo';
    return (
        <td className={`obj-hist-cell is-${celda.estado} ${activa ? 'is-sel' : ''}`}
            onClick={onClick} role="button" tabIndex={0}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
            title={vacia ? undefined : `${money(celda.neto)} de ${money(celda.target)}`}>
            {vacia ? '' : `${pctParaMostrar(celda.pct ?? 0)}%`}
        </td>
    );
}
