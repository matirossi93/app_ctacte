import { useEffect, useState } from 'react';
import { Wallet, AlertTriangle, Loader2, Camera, Clock } from 'lucide-react';
import { authHeaders } from '../utils/auth';
import { fechaDeCorte, fechaLegible, type PeriodoCorte } from '../utils/fechaCorte';
import './CarteraCard.css';

/**
 * "Cuánto hay en la calle": el total de la cuenta corriente de clientes, a la fecha que
 * marca el selector de período, y desglosado por vendedor.
 *
 * Pedido de Mati (31/08/2026). Vive en su propio archivo y no adentro de VendorShell porque
 * ese archivo ya tiene 2.800 líneas y lo está tocando otra sesión.
 *
 * 🔑 El saldo de una fecha PASADA sale de la foto diaria que guarda el cron (tabla
 * conciliacion_snapshot), no de InfoManager: el reporte de IM es una foto de HOY y no acepta
 * fecha. Si de ese día no hay foto, no se muestra ningún número — ver `disponible`.
 */

interface Total { saldo_im: number; en_transito: number; ajustado: number; n_clientes: number }
interface PorVendedor extends Total { cod_vendedor: number; nombre: string }
interface Respuesta {
    ok: boolean;
    disponible: boolean;
    modo: 'vivo' | 'foto' | 'sin_foto';
    fecha: string;
    exacto?: boolean;
    generado_at?: string;
    maestro_congelado?: boolean;
    total?: Total;
    filtrado?: (Total & { cods: number[] }) | null;
    por_vendedor?: PorVendedor[];
    internas?: { saldo_im: number; n_cuentas: number };
    fechas_disponibles?: string[];
}

interface Props {
    periodo: PeriodoCorte;
    /** Los vendedores elegidos arriba, como los manda el resto de la app: "2,3,12". */
    cods: string;
}

const money = (n: number | null | undefined) =>
    n == null ? '—' : new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n);

/** Hoy en Argentina. Mismo criterio que el backend (UTC-3 fijo, acá no hay horario de verano). */
const hoyArgentina = () => new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);

const hora = (iso: string) => {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export function CarteraCard({ periodo, cods }: Props) {
    const [data, setData] = useState<Respuesta | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [cargando, setCargando] = useState(true);
    const [abierto, setAbierto] = useState(false);

    const corte = fechaDeCorte(periodo, hoyArgentina());

    useEffect(() => {
        if (corte.tipo === 'futuro') { setData(null); setError(null); setCargando(false); return; }
        let vivo = true;
        setCargando(true);
        const qs = new URLSearchParams();
        if (corte.tipo === 'fecha') qs.set('fecha', corte.fecha);
        if (cods) qs.set('cods', cods);
        fetch(`/api/cartera?${qs}`, { headers: authHeaders() })
            .then(async r => ({ ok: r.ok, d: await r.json().catch(() => null) }))
            .then(({ ok, d }) => {
                if (!vivo) return;
                if (!ok || !d?.ok) { setError(d?.error ?? 'No se pudo calcular la cartera.'); setData(null); return; }
                setError(null); setData(d);
            })
            .catch(() => { if (vivo) { setError('Sin conexión: no se pudo calcular la cartera.'); setData(null); } })
            .finally(() => { if (vivo) setCargando(false); });
        return () => { vivo = false; };
        /* eslint-disable-next-line react-hooks/exhaustive-deps */
    }, [corte.tipo, corte.tipo === 'fecha' ? corte.fecha : '', cods]);

    if (corte.tipo === 'futuro') {
        return (
            <div className="cartera-card">
                <div className="cartera-vacia"><Clock size={16} /> Ese día todavía no llegó: no hay saldo para mostrar.</div>
            </div>
        );
    }

    if (cargando) {
        return <div className="cartera-card"><div className="cartera-vacia"><Loader2 className="spin" size={16} /> Calculando la cartera…</div></div>;
    }

    if (error) {
        return (
            <div className="cartera-card">
                <div className="cartera-vacia error"><AlertTriangle size={16} /> {error}</div>
            </div>
        );
    }

    // 🔑 No hay foto de ese día. NO se muestra un aproximado: el único cálculo posible saca
    // las facturas nuevas pero los pagos posteriores ya están descontados de los saldos, así
    // que daría MENOS de lo real y no se sabe cuánto menos. Un total de cartera equivocado es
    // peor que no tenerlo.
    if (data && !data.disponible) {
        const cercanas = (data.fechas_disponibles ?? []).slice(0, 6);
        return (
            <div className="cartera-card">
                <div className="cartera-vacia aviso">
                    <AlertTriangle size={16} />
                    <span>
                        No hay foto de la cuenta corriente del <b>{fechaLegible(data.fecha)}</b>, así que no puedo decirte el saldo de ese día sin inventarlo.
                        {cercanas.length > 0 && <> Las últimas que sí tengo: {cercanas.map(fechaLegible).join(' · ')}.</>}
                    </span>
                </div>
            </div>
        );
    }

    if (!data?.total) return null;

    const { total, filtrado, por_vendedor = [], internas } = data;
    const esFoto = data.modo === 'foto';

    return (
        <div className="cartera-card">
            <div className="cartera-head">
                <div className="cartera-titulo">
                    <Wallet size={16} />
                    <span>En la calle</span>
                </div>
                <div className="cartera-fuente">
                    {esFoto
                        ? <><Camera size={13} /> foto exacta del {fechaLegible(data.fecha)}</>
                        : <><Clock size={13} /> al día de hoy{data.generado_at ? `, ${hora(data.generado_at)}` : ''}</>}
                </div>
            </div>

            <div className="cartera-numero">{money(total.saldo_im)}</div>
            <div className="cartera-sub">
                {total.n_clientes} clientes con saldo
                {total.en_transito > 0 && (
                    <> · <b>{money(total.ajustado)}</b> descontando {money(total.en_transito)} que ya se cobró y todavía no se imputó en InfoManager</>
                )}
            </div>

            {filtrado && (
                <div className="cartera-filtrado">
                    De los vendedores que tenés elegidos: <b>{money(filtrado.saldo_im)}</b> · {filtrado.n_clientes} clientes
                </div>
            )}

            {/* 🪤 Sin maestro congelado el reparto por vendedor usa el de HOY: el total sigue
                siendo exacto, pero un cliente reasignado desde el corte cae en el vendedor
                equivocado. Hay que decirlo, no dejarlo pasar. */}
            {esFoto && data.maestro_congelado === false && (
                <div className="cartera-nota">
                    <AlertTriangle size={13} />
                    Esa foto es anterior a que se guardara el vendedor de cada cliente: el total es exacto, pero el reparto por vendedor usa el de hoy.
                </div>
            )}

            <button className="cartera-toggle" onClick={() => setAbierto(a => !a)}>
                {abierto ? 'Ocultar el detalle' : 'Ver por vendedor'}
            </button>

            {abierto && (
                <div className="cartera-detalle">
                    {por_vendedor.map(v => (
                        <div key={v.cod_vendedor} className="cartera-fila">
                            <span className="cartera-vend">{v.nombre}</span>
                            <span className="cartera-cli">{v.n_clientes} cli</span>
                            <span className="cartera-monto">{money(v.saldo_im)}</span>
                        </div>
                    ))}
                    {internas && internas.n_cuentas > 0 && (
                        <div className="cartera-internas">
                            Aparte, {money(internas.saldo_im)} en {internas.n_cuentas} cuentas internas (movimientos entre depósitos). <b>No es plata de clientes</b> y no entra en el total de arriba.
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
