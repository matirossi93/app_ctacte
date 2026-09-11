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

interface Comprobante { factura_origen?: string; im_numero: number | null; im_remito_numero?: number | null; bultos: number; kg: number; total: number; facturado: boolean }
/**
 * 🔴 Las notas de crédito y débito de ESTA entrega. Mati (10/09/2026): *"la NC de Baca tiene que
 * impactar en el importe total que se le va a entregar en ese pedido"*. El total del cliente ya
 * viene ajustado del servidor; acá se muestra el renglón para que se entienda por qué.
 */
interface NotaFila { tipo: string; numero: number | null; total: number }
interface ClienteFila {
    cod_cliente: number; cod_empresa?: number | null; saldo_actualizado?: boolean; saldo_consultado_at?: string | null; cliente_nombre: string | null; saldo_anterior: number | null;
    comprobantes: Comprobante[]; notas?: NotaFila[]; total: number; bultos: number; kg: number;
}
interface Fraccion { cod_articulo: number; descripcion: string; cantidades: number[]; paquetes: number; kg: number }
interface Datos {
    hoja: { numero: number; fecha: string; turno: string | null; transporte: string | null; camion: string | null };
    clientes: ClienteFila[];
    totales: { clientes: number; comprobantes: number; bultos: number; kg: number; total: number };
    fraccionado: Fraccion[];
    fraccionado_totales: { productos: number; paquetes: number; kg: number };
    sin_saldo: number; sin_actualizar_saldo?: number; fraccionado_completo?: boolean;
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
        const abort = new AbortController();
        setDatos(null); setError(null);
        fetch(`/api/hojas-ruta/${hojaId}/impresion`, { headers: authHeaders(), signal: abort.signal })
            .then(async r => {
                const d = await r.json().catch(() => null);
                if (!r.ok) throw new Error(d?.error ?? 'No se pudo armar el impreso');
                if (!abort.signal.aborted) setDatos(d);
            })
            .catch(e => { if (!abort.signal.aborted) setError(e?.message ?? 'Error de conexión'); });
        return () => abort.abort();
    }, [hojaId]);

    return createPortal(
        <div className="imp-overlay">
            <div className="imp-toolbar imp-no-print">
                <div className="imp-tabs">
                    <button className={que === 'ruta' ? 'on' : ''} onClick={() => setQue('ruta')}>Hoja de ruta</button>
                    <button className={que === 'fraccionado' ? 'on' : ''} onClick={() => setQue('fraccionado')}>Fraccionado</button>
                </div>
                <button className="imp-btn" onClick={() => window.print()} disabled={!datos || !!error || (que === 'fraccionado' && datos.fraccionado_completo !== true)}>
                    <Printer size={15} /> Imprimir
                </button>
                <button className="imp-cerrar" onClick={onClose}><X size={18} /></button>
            </div>

            {!datos && !error && <div className="imp-cargando"><Loader2 className="spin" size={22} /> Armando el impreso…</div>}
            {error && <div className="imp-error"><AlertTriangle size={16} /> {error}</div>}

            {datos && que === 'ruta' && (
                <div className="imp-hoja">
                    <div className="imp-head">
                        <div className="imp-head-marca">
                            <img src="/logo.svg" alt="" onError={e => { (e.target as HTMLImageElement).src = '/logo.png'; }} />
                            <div>
                                <div className="imp-empresa">Semillero El Manantial</div>
                                <div className="imp-doc">Hoja de ruta</div>
                            </div>
                        </div>
                        <div className="imp-head-nro">
                            <div className="imp-nro">N° {datos.hoja.numero}</div>
                            <div className="imp-fecha">{fechaCorta(datos.hoja.fecha)}</div>
                        </div>
                    </div>

                    <div className="imp-datos">
                        <span><b>Transporte</b> {datos.hoja.transporte || '—'}</span>
                        <span><b>Turno</b> {datos.hoja.turno || '—'}</span>
                        {datos.hoja.camion && <span><b>Camión</b> {datos.hoja.camion}</span>}
                        <span><b>Clientes</b> {datos.totales.clientes}</span>
                        <span><b>Bultos</b> {num(datos.totales.bultos)}</span>
                        <span><b>Kilos</b> {num(datos.totales.kg)}</span>
                    </div>

                    <table className="imp-tabla">
                        <thead>
                            {/* 🔄 09/09/2026. Salía una columna de BULTOS que al repartidor no le sirve
                                (Mati: *"no es relevante para el reparto"*), y el importe de cada
                                comprobante sin el total del cliente al lado: con dos pedidos del mismo
                                cliente en la hoja no se sabía cuál era cuál ni cuánto había que cobrar.
                                Ahora va el importe de cada pedido y, al lado, LO QUE SE LE COBRA a ese
                                cliente — una sola celda para todas sus filas. */}
                            <tr>
                                <th>Cliente</th><th className="c">Comprob.</th>
                                <th className="n">Kilos</th><th className="n">Importe</th>
                                <th className="n">Total cliente</th>
                                <th className="n">Cobrado</th><th className="n">Saldo anterior</th>
                            </tr>
                        </thead>
                        {/* 🪤 Cada cliente es su propio <tbody>: así el navegador NO parte un
                            cliente entre dos páginas al imprimir, y las filas no se cruzan.
                            Antes iban todas en un <tbody> con fragments sin key. */}
                        {datos.clientes.map(c => {
                            const notas = c.notas ?? [];
                            // Las notas ocupan su propia fila: el rowSpan del total tiene que contarlas.
                            const filas = c.comprobantes.length + notas.length;
                            return (
                            <tbody className="imp-grupo" key={`${c.cod_empresa ?? "?"}|${c.cod_cliente}`}>
                                {c.comprobantes.map((x, i) => (
                                    <tr key={c.cod_cliente + '-' + (x.im_numero ?? i)}>
                                        <td>{i === 0 ? <b>{c.cliente_nombre}</b> : ''}</td>
                                        <td className="c">{x.im_remito_numero ?? x.im_numero ?? '—'}</td>
                                        <td className="n">{num(x.kg)}</td>
                                        <td className="n">{money(x.total)}</td>
                                        {/* 🔑 Una sola celda para TODAS las filas del cliente: es la plata
                                            que el repartidor tiene que cobrar en esa puerta, sin sumar
                                            nada de cabeza. Con `rowSpan` no se puede repetir por error. */}
                                        {i === 0 && (
                                            <td className="n total-cli" rowSpan={filas}>
                                                {money(c.total)}
                                                {filas > 1 && <span className="imp-cuantos"> ({filas} pedidos)</span>}
                                            </td>
                                        )}
                                        <td className="n escribir"></td>
                                        {/* El saldo anterior YA IMPRESO: es lo que hoy escriben a mano
                                            antes de que salga el camión. Uno por cliente, como el total. */}
                                        {i === 0 && (
                                            <td className="n saldo" rowSpan={filas}>
                                                {c.saldo_anterior != null ? money(c.saldo_anterior) : '—'}
                                            </td>
                                        )}
                                    </tr>
                                ))}
                                {/* 🔴 Lo que se le acreditó o se le cobró de más sobre este pedido.
                                    Sin este renglón el repartidor cobra la factura entera. */}
                                {notas.map((n, i) => (
                                    <tr key={c.cod_cliente + '-nota-' + (n.numero ?? i)} className="imp-nota">
                                        <td></td>
                                        <td className="c">{n.tipo}{n.numero != null ? ` ${n.numero}` : ''}</td>
                                        <td className="n">—</td>
                                        <td className="n">
                                            {money(/^NC/i.test(n.tipo) ? -Math.abs(n.total) : Math.abs(n.total))}
                                        </td>
                                        <td className="n escribir"></td>
                                    </tr>
                                ))}
                            </tbody>
                            );
                        })}
                        <tfoot>
                            <tr>
                                <td colSpan={2}>TOTAL · {datos.totales.clientes} clientes</td>
                                <td className="n">{num(datos.totales.kg)}</td>
                                {/* El total va UNA vez, bajo "Total cliente", que es la columna que se
                                    lee. Repetirlo en las dos parece un error de la planilla. */}
                                <td className="n"></td>
                                <td className="n">{money(datos.totales.total)}</td>
                                <td className="n escribir"></td>
                                <td className="n escribir"></td>
                            </tr>
                        </tfoot>
                    </table>

                    {datos.clientes.some(c => c.comprobantes.some(p => p.factura_origen === "elegida")) && <p className="imp-nota">Hay facturas deducidas entre varias candidatas. Revisá la asociación antes de cobrar.</p>}
                    {!!datos.sin_actualizar_saldo && <p className="imp-nota">Saldo sin actualizar en {datos.sin_actualizar_saldo} cliente(s). Los importes disponibles usan la última consulta guardada.</p>}
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
                        <div className="imp-head-marca">
                            <img src="/logo.svg" alt="" onError={e => { (e.target as HTMLImageElement).src = '/logo.png'; }} />
                            <div>
                                <div className="imp-empresa">Semillero El Manantial</div>
                                <div className="imp-doc">A fraccionar</div>
                            </div>
                        </div>
                        <div className="imp-head-nro">
                            <div className="imp-nro">N° {datos.hoja.numero}</div>
                            <div className="imp-fecha">{fechaCorta(datos.hoja.fecha)}</div>
                        </div>
                    </div>

                    <div className="imp-datos">
                        <span><b>Productos</b> {datos.fraccionado_totales.productos}</span>
                        <span><b>Paquetes</b> {datos.fraccionado_totales.paquetes}</span>
                        <span><b>Kilos</b> {num(datos.fraccionado_totales.kg)}</span>
                        {datos.hoja.transporte && <span><b>Transporte</b> {datos.hoja.transporte}</span>}
                    </div>

                    {datos.fraccionado_completo !== true && <p className="imp-error">Faltan renglones para completar el fraccionado. Actualizá antes de imprimir.</p>}
                    {datos.fraccionado_completo === true && !datos.fraccionado.length && <p className="imp-nota">Esta hoja no lleva nada para fraccionar.</p>}

                    <table className="imp-tabla frac">
                        <thead>
                            <tr><th>Código</th><th>Producto</th><th>Cantidades a preparar</th><th className="n">Paq.</th><th className="n">Total kg</th></tr>
                        </thead>
                        <tbody>
                            {datos.fraccionado.map(f => (
                                <tr key={f.cod_articulo}>
                                    <td>{f.cod_articulo || '—'}</td>
                                    <td className="prod">{f.descripcion}</td>
                                    {/* Cada cantidad es UN paquete: van separadas y en cajas,
                                        para que el que prepara pueda tildarlas una por una. */}
                                    <td className="cants">
                                        {f.cantidades.map((c, i) => <span className="paq" key={i}>{num(c)}</span>)}
                                    </td>
                                    <td className="n">{f.paquetes}</td>
                                    <td className="n">{num(f.kg)}</td>
                                </tr>
                            ))}
                        </tbody>
                        <tfoot>
                            <tr>
                                <td colSpan={3}>{datos.fraccionado_totales.productos} productos</td>
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
