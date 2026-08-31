import { useEffect, useState } from 'react';
import { Wallet, AlertTriangle, Loader2, Camera, Clock, ChevronDown } from 'lucide-react';
import { authHeaders } from '../utils/auth';
import { fechaDeCorte, fechaLegible, type PeriodoCorte } from '../utils/fechaCorte';
import { sumarVendedores } from '../utils/carteraFiltrado';
import { montoCorto } from '../utils/montoCorto';
import './CarteraCard.css';

/**
 * "Cuánto hay en la calle": el total de la cuenta corriente de clientes, a una fecha, y
 * desglosado por vendedor.
 *
 * Pedido de Mati (31/08/2026). Vive en su propio archivo y no adentro de VendorShell porque
 * ese archivo ya tiene 2.800 líneas.
 *
 * 🔑 El saldo de una fecha PASADA sale de la foto diaria que guarda el cron (tabla
 * conciliacion_snapshot), no de InfoManager: el reporte de IM es una foto de HOY y no acepta
 * fecha. Si de ese día no hay foto, no se muestra ningún número — ver `disponible`.
 *
 * 31/08 (segunda vuelta, por audio): *"no me gusta cómo está diseñado, quería que sea algo
 * más integrado en la página, que no ocupe mucho espacio"* + *"no veo dónde está ese filtro"*.
 * De ahí los dos cambios de esta versión:
 *   · deja de ser una tarjeta con caja propia y pasa a ser un renglón del encabezado
 *   · el filtro de fecha se ve ACÁ, al lado del número que modifica. Antes existía sólo
 *     dentro de la pastilla del mes, en una solapa "Corte", a dos clicks y sin nada que
 *     dijera que eso movía la cartera.
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
    por_vendedor?: PorVendedor[];
    internas?: { saldo_im: number; n_cuentas: number };
    fechas_disponibles?: string[];
}

interface Props {
    periodo: PeriodoCorte;
    /** Los vendedores elegidos arriba, como los manda el resto de la app: "2,3,12". */
    cods: string;
    /** Para que el calendario de acá mueva el período de toda la pantalla, sin inventar otro. */
    onPeriodoChange: (p: PeriodoCorte) => void;
}

const money = (n: number | null | undefined) =>
    n == null ? '—' : new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n);

/** Hoy en Argentina. Mismo criterio que el backend (UTC-3 fijo, acá no hay horario de verano). */
const hoyArgentina = () => new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);

const hora = (iso: string) => {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export function CarteraCard({ periodo, cods, onPeriodoChange }: Props) {
    const [data, setData] = useState<Respuesta | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [cargando, setCargando] = useState(true);
    const [abierto, setAbierto] = useState(false);

    const hoy = hoyArgentina();
    const corte = fechaDeCorte(periodo, hoy);
    const fechaElegida = corte.tipo === 'fecha' ? corte.fecha : hoy;

    // 🔑 `cods` NO está en las dependencias a propósito. El desglose por vendedor viene entero
    // en la respuesta, así que filtrar es sumar lo que la pantalla ya tiene. Mientras esto se
    // le preguntaba al server, cada click en el selector redisparaba la consulta completa:
    // 1,1 s si era una fecha pasada y hasta 6,4 s si había que ir a InfoManager (medido en
    // producción el 31/08/2026), todo para recalcular una suma de cinco términos.
    useEffect(() => {
        if (corte.tipo === 'futuro') { setData(null); setError(null); setCargando(false); return; }
        let vivo = true;
        setCargando(true);
        const qs = new URLSearchParams();
        if (corte.tipo === 'fecha') qs.set('fecha', corte.fecha);
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
    }, [corte.tipo, corte.tipo === 'fecha' ? corte.fecha : '']);

    /** El calendario mueve el período de toda la pantalla; vacío = volver a hoy. */
    const elegirFecha = (valor: string) => {
        if (!valor) {
            const [y, m] = hoy.split('-').map(Number);
            onPeriodoChange({ year: y, month: m, asOfDay: null });
            return;
        }
        const [y, m, d] = valor.split('-').map(Number);
        if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return;
        // Elegir el día de hoy es "hoy", no un corte histórico al día de hoy.
        onPeriodoChange({ year: y, month: m, asOfDay: valor === hoy ? null : d });
    };

    /* El calendario se muestra SIEMPRE, aunque abajo no haya número que mostrar: es
       justamente cuando hay un aviso ("de ese día no hay foto") que hace falta poder
       elegir otro día sin irse a buscar el control a otra parte de la pantalla. */
    const selectorFecha = (
        <label className="cartera-fecha" title="Ver la cuenta corriente a esta fecha">
            <input
                type="date"
                value={fechaElegida}
                max={hoy}
                onChange={e => elegirFecha(e.target.value)}
            />
        </label>
    );

    const envoltorio = (contenido: React.ReactNode) => (
        <div className="cartera-inline">
            {contenido}
            {selectorFecha}
        </div>
    );

    if (corte.tipo === 'futuro') {
        return envoltorio(<span className="cartera-aviso"><Clock size={14} /> Ese día todavía no llegó.</span>);
    }
    if (cargando) {
        return envoltorio(<span className="cartera-aviso"><Loader2 className="spin" size={14} /> Calculando…</span>);
    }
    if (error) {
        return envoltorio(<span className="cartera-aviso error"><AlertTriangle size={14} /> {error}</span>);
    }

    // 🔑 No hay foto de ese día. NO se muestra un aproximado: el único cálculo posible saca
    // las facturas nuevas pero los pagos posteriores ya están descontados de los saldos, así
    // que daría MENOS de lo real y no se sabe cuánto menos. Un total de cartera equivocado es
    // peor que no tenerlo.
    if (data && !data.disponible) {
        const cercanas = (data.fechas_disponibles ?? []).slice(0, 3);
        return envoltorio(
            <span className="cartera-aviso amarillo">
                <AlertTriangle size={14} />
                <span>
                    Del {fechaLegible(data.fecha)} no hay foto guardada.
                    {cercanas.length > 0 && <> Sí tengo: {cercanas.map(fechaLegible).join(' · ')}.</>}
                </span>
            </span>,
        );
    }

    if (!data?.total) return null;

    const { total, por_vendedor = [], internas } = data;
    const filtrado = sumarVendedores(por_vendedor, cods);
    const esFoto = data.modo === 'foto';
    // 🪤 Sin maestro congelado el reparto por vendedor usa el de HOY: el total sigue siendo
    // exacto, pero un cliente reasignado desde el corte cae en el vendedor equivocado. El
    // texto vive adentro del detalle, pero el triángulo se ve SIN abrir: un aviso que hay que
    // desplegar para enterarse no es un aviso.
    const repartoDudoso = esFoto && data.maestro_congelado === false;

    return (
        <div className="cartera-wrap">
            <div className="cartera-inline">
                {/* Toda la línea es el botón: en el celular no hay que apuntarle a un link chico. */}
                <button
                    className={`cartera-linea ${abierto ? 'is-open' : ''}`}
                    onClick={() => setAbierto(a => !a)}
                    aria-expanded={abierto}
                >
                    <Wallet size={14} />
                    <span className="cartera-rotulo">En la calle</span>
                    {/* Abreviado para que entre en un renglón; el exacto está al desplegar. */}
                    <strong className="cartera-numero">{montoCorto(total.saldo_im)}</strong>
                    <span className="cartera-cli">{total.n_clientes} cli</span>
                    {repartoDudoso && <AlertTriangle size={12} className="cartera-alerta" />}
                    <ChevronDown size={15} className="cartera-chevron" />
                </button>
                {selectorFecha}
            </div>

            {abierto && (
                <div className="cartera-detalle">
                    <div className="cartera-fila cartera-fila--fuerte">
                        <span>Total al {esFoto ? fechaLegible(data.fecha) : 'día de hoy'}</span>
                        <span className="cartera-monto">{money(total.saldo_im)}</span>
                    </div>
                    <div className="cartera-cuando">
                        {esFoto
                            ? <><Camera size={11} /> foto del cierre del {fechaLegible(data.fecha)}</>
                            : <><Clock size={11} /> InfoManager{data.generado_at ? `, ${hora(data.generado_at)}` : ''}</>}
                    </div>

                    {total.en_transito > 0 && (
                        <>
                            <div className="cartera-fila">
                                <span>Ya cobrado, sin imputar en InfoManager</span>
                                <span className="cartera-monto">−{money(total.en_transito)}</span>
                            </div>
                            <div className="cartera-fila cartera-fila--fuerte">
                                <span>Queda por cobrar</span>
                                <span className="cartera-monto">{money(total.ajustado)}</span>
                            </div>
                        </>
                    )}
                    {filtrado && (
                        <div className="cartera-fila">
                            <span>De los vendedores que elegiste · {filtrado.n_clientes} clientes</span>
                            <span className="cartera-monto">{money(filtrado.saldo_im)}</span>
                        </div>
                    )}

                    {repartoDudoso && (
                        <div className="cartera-nota">
                            <AlertTriangle size={13} />
                            Esa foto es anterior a que se guardara el vendedor de cada cliente: el total es exacto, pero el reparto por vendedor usa el de hoy.
                        </div>
                    )}

                    <div className="cartera-subtitulo">Por vendedor</div>
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
