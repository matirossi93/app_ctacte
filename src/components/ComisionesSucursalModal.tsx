import { useEffect, useState, useCallback } from 'react';
import { X, Store, Loader2, AlertCircle, ChevronLeft, ChevronRight, ChevronDown, ChevronUp } from 'lucide-react';
import { authHeaders } from '../utils/auth';
import type { ViewPeriod } from './PeriodSelector';
import './ComisionesSucursalModal.css';

interface Props {
    onClose: () => void;
    /** Período inicial (mes). Adentro se puede navegar mes a mes. */
    period: ViewPeriod;
}

interface VendedorRow {
    cod_vendedor: number;
    nombre: string;
    neto_total: number;
    comision_total: number;
    num_comprobantes: number;
}
interface FacturaRow {
    id: number;
    fecha: string;
    tipo: string;
    cod_cliente: number;
    razon_social: string;
    cod_vendedor: number;
    nombre_vendedor: string;
    neto: number;
    comision: number;
}
interface SucursalResp {
    ok: boolean;
    empresa_nombre: string;
    items: VendedorRow[];
    totales: { neto_total: number; comision_total: number; num_comprobantes: number };
    facturas: FacturaRow[];
    excluidos: number[];
    error?: string;
}

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const money = (n: number) => '$' + (n ?? 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fechaCorta = (f: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(f || '');
    return m ? `${m[3]}/${m[2]}` : (f || '');
};

export function ComisionesSucursalModal({ onClose, period }: Props) {
    const [year, setYear] = useState(period.year);
    const [month, setMonth] = useState(period.month);
    const [data, setData] = useState<SucursalResp | null>(null);
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState<string | null>(null);
    const [showDetalle, setShowDetalle] = useState(false);

    const load = useCallback(async (y: number, m: number, signal?: AbortSignal) => {
        setLoading(true);
        setErr(null);
        try {
            const res = await fetch(`/api/comisiones/sucursal?year=${y}&month=${m}`, { headers: authHeaders(), signal });
            const j = await res.json().catch(() => ({}));
            if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
            setData(j as SucursalResp);
        } catch (e: any) {
            if (e?.name === 'AbortError') return;
            setErr(e?.message ?? 'Error al cargar');
            setData(null);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        const ctrl = new AbortController();
        load(year, month, ctrl.signal);
        return () => ctrl.abort();
    }, [year, month, load]);

    const irMes = (delta: number) => {
        let m = month + delta, y = year;
        if (m < 1) { m = 12; y -= 1; }
        else if (m > 12) { m = 1; y += 1; }
        setMonth(m); setYear(y);
    };

    const total = data?.totales.comision_total ?? 0;
    const nFact = data?.facturas?.length ?? 0;
    const nVend = data?.items?.length ?? 0;

    return (
        <div className="csm-overlay" onClick={onClose}>
            <div className="csm-modal" onClick={e => e.stopPropagation()}>
                <header className="csm-head">
                    <h2><Store size={18} /> Comisiones · Sucursal San Martín</h2>
                    <button className="csm-close" onClick={onClose} aria-label="Cerrar"><X size={20} /></button>
                </header>

                <p className="csm-sub">
                    Solo administración. Comisión que le corresponde a cada vendedor por sus clientes que
                    <strong> retiran en la sucursal</strong> (el panel de comisiones de los vendedores no incluye esto).
                </p>

                <div className="csm-nav">
                    <button onClick={() => irMes(-1)} aria-label="Mes anterior" disabled={loading}><ChevronLeft size={18} /></button>
                    <strong>{MESES[month - 1]} {year}</strong>
                    <button onClick={() => irMes(1)} aria-label="Mes siguiente" disabled={loading}><ChevronRight size={18} /></button>
                </div>

                {err && <div className="csm-error"><AlertCircle size={16} /> {err}</div>}

                {loading ? (
                    <div className="csm-loading"><Loader2 size={22} className="csm-spin" /> Calculando desde InfoManager…</div>
                ) : data && (
                    <>
                        <div className="csm-total">
                            <span className="csm-total-label">Total a comisionar</span>
                            <span className="csm-total-val">{money(total)}</span>
                            <span className="csm-total-meta">{nFact} factura{nFact === 1 ? '' : 's'} · {nVend} vendedor{nVend === 1 ? '' : 'es'}</span>
                        </div>

                        {nVend === 0 ? (
                            <div className="csm-empty">No hay ventas de clientes de vendedores en la sucursal este mes.</div>
                        ) : (
                            <table className="csm-table">
                                <thead>
                                    <tr><th>Vendedor</th><th className="num">Fact.</th><th className="num">Neto</th><th className="num">Comisión</th></tr>
                                </thead>
                                <tbody>
                                    {data.items.map(v => (
                                        <tr key={v.cod_vendedor}>
                                            <td>{v.nombre}</td>
                                            <td className="num">{v.num_comprobantes}</td>
                                            <td className="num">{money(v.neto_total)}</td>
                                            <td className="num csm-strong">{money(v.comision_total)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                                <tfoot>
                                    <tr>
                                        <td>TOTAL</td>
                                        <td className="num">{data.totales.num_comprobantes}</td>
                                        <td className="num">{money(data.totales.neto_total)}</td>
                                        <td className="num csm-strong">{money(data.totales.comision_total)}</td>
                                    </tr>
                                </tfoot>
                            </table>
                        )}

                        {data.excluidos?.length > 0 && (
                            <div className="csm-note">
                                Se excluyó {data.excluidos.length === 1 ? 'al cliente' : 'a los clientes'} <strong>{data.excluidos.join(', ')}</strong> por
                                decisión de negocio (compras directas de mostrador, sin intervención del vendedor).
                            </div>
                        )}

                        {nFact > 0 && (
                            <button className="csm-detalle-toggle" onClick={() => setShowDetalle(s => !s)}>
                                {showDetalle ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                                {showDetalle ? 'Ocultar' : 'Ver'} detalle factura por factura ({nFact})
                            </button>
                        )}
                        {showDetalle && nFact > 0 && (
                            <table className="csm-table csm-detalle">
                                <thead>
                                    <tr><th>Fecha</th><th>Cliente</th><th>Vendedor</th><th className="num">Neto</th><th className="num">Comisión</th></tr>
                                </thead>
                                <tbody>
                                    {data.facturas.map(f => (
                                        <tr key={f.id}>
                                            <td>{fechaCorta(f.fecha)}</td>
                                            <td>{f.razon_social || `Cliente ${f.cod_cliente}`}</td>
                                            <td>{f.nombre_vendedor}</td>
                                            <td className="num">{money(f.neto)}</td>
                                            <td className="num">{money(f.comision)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </>
                )}

                <footer className="csm-foot">
                    Mismo criterio de comisión que Casa Central (reglas por producto). Cálculo en vivo desde InfoManager.
                </footer>
            </div>
        </div>
    );
}
