import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Printer, Loader2, AlertTriangle } from 'lucide-react';
import { authHeaders } from '../utils/auth';
import './ImprimirHoja.css';

/**
 * Los dos papeles que hoy Jorgelina arma a mano:
 *
 *  1. **La hoja de ruta**, con el formato de la hoja real nº 3394: cabecera con número, fecha,
 *     turno y transporte; los comprobantes agrupados por cliente con su total; y las dos
 *     columnas que se completan en la calle — `Imp. cobrado` y `Saldo`.
 *     🔑 El `Saldo` sale IMPRESO con el saldo anterior del cliente. Hoy lo escriben a mano
 *     porque InfoManager no lo trae; nosotros ya lo tenemos calculado.
 *
 *  2. **El listado de fraccionado**, sólo lo que se vende por kilo, agrupado por producto y con
 *     cada cantidad separada: cada una es un paquete a preparar.
 */

interface Comprobante { im_numero: number | null; bultos: number; kg: number; total: number; facturado: boolean }
interface ClienteFila {
    cod_cliente: number; cliente_nombre: string | null; saldo_anterior: number | null;
    comprobantes: Comprobante[]; total: number; bultos: number; kg: number;
}
interface Fraccion { descripcion: string; cantidades: number[]; paquetes: number; kg: number }
interface Datos {
    hoja: { numero: number; fecha: string; turno: string | null; transporte: string | null; camion: string | null };
    clientes: ClienteFila[];
    totales: { clientes: number; comprobantes: number; bultos: number; kg: number; total: number };
    fraccionado: Fraccion[];
    fraccionado_totales: { productos: number; paquetes: number; kg: number };
    sin_saldo: number;
}

const money = (n: number | null | undefined) =>
    n == null ? '' : new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
const num = (n: number) => new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 }).format(n);
const fechaCorta = (iso: string) => iso ? iso.slice(0, 10).split('-').reverse().join('/') : '';

export function ImprimirHoja({ hojaId, onClose }: { hojaId: string; onClose: () => void }) {
    const [datos, setDatos] = useState<Datos | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [que, setQue] = useState<'ruta' | 'fraccionado'>('ruta');

    // Mientras esta vista está abierta, el navegador imprime SOLO esto (ver el @media print
    // del css). Sin esto salen también el header y el panel de atrás.
    useEffect(() => {
        document.body.classList.add('imp-print-active');
        return () => document.body.classList.remove('imp-print-active');
    }, []);

    useEffect(() => {
        fetch(`/api/hojas-ruta/${hojaId}/impresion`, { headers: authHeaders() })
            .then(async r => {
                const d = await r.json().catch(() => null);
                if (!r.ok) throw new Error(d?.error ?? 'No se pudo armar el impreso');
                setDatos(d);
            })
            .catch(e => setError(e?.message ?? 'Error de conexión'));
    }, [hojaId]);

    return createPortal(
        <div className="imp-overlay">
            <div className="imp-toolbar imp-no-print">
                <div className="imp-tabs">
                    <button className={que === 'ruta' ? 'on' : ''} onClick={() => setQue('ruta')}>Hoja de ruta</button>
                    <button className={que === 'fraccionado' ? 'on' : ''} onClick={() => setQue('fraccionado')}>Fraccionado</button>
                </div>
                <button className="imp-btn" onClick={() => window.print()} disabled={!datos}>
                    <Printer size={15} /> Imprimir
                </button>
                <button className="imp-cerrar" onClick={onClose}><X size={18} /></button>
            </div>

            {!datos && !error && <div className="imp-cargando"><Loader2 className="spin" size={22} /> Armando el impreso…</div>}
            {error && <div className="imp-error"><AlertTriangle size={16} /> {error}</div>}

            {datos && que === 'ruta' && (
                <div className="imp-hoja">
                    <div className="imp-head">
                        <div className="imp-head-l">
                            <div><b>Transporte:</b> {datos.hoja.transporte || '—'}</div>
                            <div><b>Detalle:</b></div>
                        </div>
                        <div className="imp-head-c">
                            <div className="imp-nro">Nro Hoja: {datos.hoja.numero}</div>
                            <div>Turno: {datos.hoja.turno || '—'}</div>
                        </div>
                        <div className="imp-head-r">Fecha: {fechaCorta(datos.hoja.fecha)}</div>
                    </div>

                    <table className="imp-tabla">
                        <thead>
                            <tr>
                                <th>Fecha</th><th>Nro. Comp.</th><th className="n">Cantidad</th>
                                <th className="n">Cantidad UME</th><th className="n">Imp. Total</th>
                                <th>Cliente</th><th className="n">Imp. cobrado</th><th className="n">Saldo</th>
                            </tr>
                        </thead>
                        <tbody>
                            {datos.clientes.map(c => (
                                <>
                                    {c.comprobantes.map((x, i) => (
                                        <tr key={c.cod_cliente + '-' + i}>
                                            <td>{fechaCorta(datos.hoja.fecha)}</td>
                                            <td>{x.im_numero ?? '—'}</td>
                                            <td className="n">{num(x.bultos)}</td>
                                            <td className="n">{num(x.kg)}</td>
                                            <td className="n">{money(x.total)}</td>
                                            <td>{i === 0 ? c.cliente_nombre : ''}</td>
                                            <td className="n escribir"></td>
                                            <td className="n escribir"></td>
                                        </tr>
                                    ))}
                                    <tr className="imp-total-cli" key={c.cod_cliente + '-tot'}>
                                        <td colSpan={4}>Total por cliente:</td>
                                        <td className="n">{money(c.total)}</td>
                                        <td></td>
                                        <td className="n escribir"></td>
                                        {/* El saldo anterior YA IMPRESO: es lo que hoy escriben a mano. */}
                                        <td className="n saldo">{c.saldo_anterior != null ? money(c.saldo_anterior) : ''}</td>
                                    </tr>
                                </>
                            ))}
                        </tbody>
                        <tfoot>
                            <tr>
                                <td colSpan={2}>{datos.totales.clientes} clientes · {datos.totales.comprobantes} comp.</td>
                                <td className="n">{num(datos.totales.bultos)}</td>
                                <td className="n">{num(datos.totales.kg)}</td>
                                <td className="n">{money(datos.totales.total)}</td>
                                <td colSpan={3}>{datos.hoja.camion ?? ''}</td>
                            </tr>
                        </tfoot>
                    </table>

                    {datos.sin_saldo > 0 && (
                        <p className="imp-nota imp-no-print">
                            De {datos.sin_saldo} cliente(s) no se pudo traer el saldo: esa celda va en blanco.
                        </p>
                    )}
                </div>
            )}

            {datos && que === 'fraccionado' && (
                <div className="imp-hoja">
                    <div className="imp-head">
                        <div className="imp-head-l"><b>A FRACCIONAR</b></div>
                        <div className="imp-head-c"><div className="imp-nro">Hoja {datos.hoja.numero}</div></div>
                        <div className="imp-head-r">Fecha: {fechaCorta(datos.hoja.fecha)}</div>
                    </div>

                    {!datos.fraccionado.length && <p className="imp-nota">Esta hoja no lleva nada para fraccionar.</p>}

                    <table className="imp-tabla frac">
                        <thead>
                            <tr><th>Producto</th><th>Cantidades a preparar</th><th className="n">Paq.</th><th className="n">Total kg</th></tr>
                        </thead>
                        <tbody>
                            {datos.fraccionado.map(f => (
                                <tr key={f.descripcion}>
                                    <td>{f.descripcion}</td>
                                    {/* Cada cantidad es UN paquete: no se suman entre sí. */}
                                    <td className="cants">{f.cantidades.map(c => num(c)).join('   ·   ')}</td>
                                    <td className="n">{f.paquetes}</td>
                                    <td className="n">{num(f.kg)}</td>
                                </tr>
                            ))}
                        </tbody>
                        <tfoot>
                            <tr>
                                <td colSpan={2}>{datos.fraccionado_totales.productos} productos</td>
                                <td className="n">{datos.fraccionado_totales.paquetes}</td>
                                <td className="n">{num(datos.fraccionado_totales.kg)}</td>
                            </tr>
                        </tfoot>
                    </table>
                </div>
            )}
        </div>,
        document.body,
    );
}
