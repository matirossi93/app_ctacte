import { useCallback, useEffect, useState } from 'react';
import { Loader2, AlertTriangle, Printer, RefreshCw, Package } from 'lucide-react';
import { authHeaders } from '../utils/auth';
import './FraccionadoView.css';

/**
 * El listado de lo que hay que fraccionar, y va ACÁ y no en la hoja de ruta.
 *
 * Mati (08/09/2026): *"dentro de la sección presupuestos debería estar la parte de los productos
 * que son para fraccionar (también se hace antes que el armado de la hoja)"*. Tiene sentido: el
 * sector prepara los paquetes mientras la oficina todavía está facturando.
 *
 * 🔑 Sale de los presupuestos **aprobados** del rango. Con el interruptor se ve sobre todos,
 * para adelantar trabajo cuando la revisión no terminó — pero por defecto es lo aprobado, que
 * es lo que seguro se va a entregar.
 */

interface Linea { descripcion: string; cantidades: number[]; paquetes: number; kg: number }

const num = (n: number) => n.toLocaleString('es-AR', { maximumFractionDigits: 2 });
const fechaCorta = (iso: string) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '');

export function FraccionadoView({ desde, hasta }: { desde: string; hasta: string }) {
    const [lineas, setLineas] = useState<Linea[]>([]);
    const [totales, setTotales] = useState<{ productos: number; paquetes: number; kg: number } | null>(null);
    const [comprobantes, setComprobantes] = useState(0);
    const [soloAprobados, setSoloAprobados] = useState(true);
    const [cargando, setCargando] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const cargar = useCallback(async () => {
        setCargando(true); setError(null);
        try {
            const r = await fetch(
                `/api/presupuestos/fraccionado?desde=${desde}&hasta=${hasta}${soloAprobados ? '' : '&todos=1'}`,
                { headers: authHeaders() });
            const d = await r.json().catch(() => null);
            if (!r.ok) throw new Error(d?.error ?? 'No se pudo armar el listado');
            setLineas(d.fraccionado ?? []);
            setTotales(d.totales ?? null);
            setComprobantes(d.comprobantes ?? 0);
        } catch (e: any) {
            setError(e?.message ?? 'Error de conexión');
        } finally {
            setCargando(false);
        }
    }, [desde, hasta, soloAprobados]);

    useEffect(() => { void cargar(); }, [cargar]);

    // Mientras esta vista está abierta, imprimir saca SOLO el listado (ver el @media print).
    useEffect(() => {
        document.body.classList.add('fr-print-active');
        return () => document.body.classList.remove('fr-print-active');
    }, []);

    return (
        <div className="fr-root">
            <div className="fr-top fr-no-print">
                <button className="fr-btn ghost" onClick={() => void cargar()} disabled={cargando}>
                    <RefreshCw size={15} className={cargando ? 'spin' : ''} /> Actualizar
                </button>
                <label className="fr-check">
                    <input type="checkbox" checked={soloAprobados} onChange={e => setSoloAprobados(e.target.checked)} />
                    Sólo lo aprobado
                </label>
                <span className="fr-meta">{comprobantes} pedidos</span>
                <button className="fr-btn" onClick={() => window.print()} disabled={!lineas.length}>
                    <Printer size={15} /> Imprimir
                </button>
            </div>

            {error && <div className="fr-aviso fr-no-print"><AlertTriangle size={15} /><span>{error}</span></div>}
            {cargando && <div className="fr-cargando fr-no-print"><Loader2 className="spin" size={20} /> Armando el listado…</div>}
            {!cargando && !lineas.length && !error && (
                <div className="fr-vacio fr-no-print">
                    <Package size={26} />
                    <span>{soloAprobados
                        ? 'No hay presupuestos aprobados en estos días. Aprobalos en Presupuestos, o destildá “sólo lo aprobado”.'
                        : 'No hay nada para fraccionar en estos días.'}</span>
                </div>
            )}

            {!!lineas.length && (
                <div className="fr-hoja">
                    <div className="fr-head">
                        <div className="fr-head-marca">
                            <img src="/logo.svg" alt="" onError={e => { (e.target as HTMLImageElement).src = '/logo.png'; }} />
                            <div>
                                <div className="fr-empresa">Semillero El Manantial</div>
                                <div className="fr-doc">Listado de fraccionado</div>
                            </div>
                        </div>
                        <div className="fr-head-fecha">
                            {desde === hasta ? fechaCorta(hasta) : `${fechaCorta(desde)} al ${fechaCorta(hasta)}`}
                        </div>
                    </div>

                    <div className="fr-datos">
                        <span><b>Productos</b> {totales?.productos ?? 0}</span>
                        <span><b>Paquetes</b> {totales?.paquetes ?? 0}</span>
                        <span><b>Kilos</b> {num(totales?.kg ?? 0)}</span>
                        <span><b>Pedidos</b> {comprobantes}</span>
                    </div>

                    {/* Cada cantidad en su cajita: se tilda al preparar el paquete. */}
                    <table className="fr-tabla">
                        <thead>
                            <tr><th>Producto</th><th>Paquetes</th><th className="n">Cant.</th><th className="n">Kilos</th></tr>
                        </thead>
                        <tbody>
                            {lineas.map(l => (
                                <tr key={l.descripcion}>
                                    <td className="fr-prod">{l.descripcion}</td>
                                    <td>
                                        <div className="fr-cajitas">
                                            {l.cantidades.map((c, i) => <span className="fr-cajita" key={i}>{num(c)}</span>)}
                                        </div>
                                    </td>
                                    <td className="n">{l.paquetes}</td>
                                    <td className="n">{num(l.kg)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
