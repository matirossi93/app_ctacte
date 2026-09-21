import { useLecturaVigente } from '../utils/useLecturaVigente';
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

interface Linea {
    cod_articulo: number; descripcion: string; cantidades: number[]; paquetes: number; kg: number;
    /**
     * 🔑 Bolsas cerradas que NO hay que fraccionar: la cantidad pedida era un múltiplo exacto
     * del formato (Mati, 09/09/2026: *"si dice 60 kilos, son 2 bolsas de 30"*). Se informan
     * para que el sector sepa que se contemplaron y no las busque.
     */
    bolsas_enteras: number;
    formato_bolsa: number | null;
    /**
     * 🔴 No hay kilaje de bolsa cargado para este producto: las cantidades van como vinieron
     * del pedido, sin partir. Mati (17/09/2026): *"el sorgo no se está contemplando la bolsa"*.
     */
    sin_formato: boolean;
    /** Lo que pidió el cliente, sin interpretar. Va al lado del desglose para poder controlarlo. */
    pedidos: number[];
}

/** Lo que se fabrica acá: balanceados propios y maíz quebrado. No se fracciona, se produce. */
interface LineaProduccion {
    cod_articulo: number; descripcion: string; subrubro: string;
    bolsas: number; kg: number | null;
}

const num = (n: number) => n.toLocaleString('es-AR', { maximumFractionDigits: 2 });

/**
 * 🪤 La misma trampa que tiró abajo el consolidado la mañana del 18/09/2026: un campo nuevo
 * usado derecho en el render —`l.pedidos.map(...)`— no rompe su columna, rompe la PANTALLA
 * ENTERA, porque el error sube hasta el ErrorBoundary. Se normaliza una vez, al recibir.
 *
 * `sin_formato` se deduce del kilaje si no vino: así una respuesta anterior al cambio sigue
 * mostrando bien la fila en lugar de dar por sentado que tiene bolsa cargada.
 */
const normalizarLinea = (l: any): Linea => ({
    ...l,
    cantidades: l?.cantidades ?? [],
    pedidos: l?.pedidos ?? [],
    sin_formato: l?.sin_formato ?? (l?.formato_bolsa == null),
});
const fechaCorta = (iso: string) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '');

export function FraccionadoView({ desde, hasta }: { desde: string; hasta: string }) {
    const [lineas, setLineas] = useState<Linea[]>([]);
    const [totales, setTotales] = useState<{ productos: number; paquetes: number; kg: number } | null>(null);
    const [comprobantes, setComprobantes] = useState(0);
    /**
     * 🔴 QUÉ FALTA FRACCIONAR, no qué está aprobado.
     *
     * Mati (15/09/2026): la hoja se imprime ANTES de facturar, y en el día se hacen varias. Con el
     * filtro viejo —"sólo lo aprobado"— la segunda hoja repetía todo lo de la primera y el sector
     * fraccionaba dos veces la misma mercadería. Facturar es lo que marca el corte.
     */
    const [estado, setEstado] = useState<'pendientes' | 'facturados' | 'todos'>('pendientes');
    const [cuenta, setCuenta] = useState<{ pendientes: number; facturados: number } | null>(null);
    /** Balanceados propios y maíz quebrado: no se fraccionan, se fabrican. */
    const [produccion, setProduccion] = useState<LineaProduccion[]>([]);
    const [totalesProduccion, setTotalesProduccion] = useState<{ productos: number; bolsas: number; kg: number } | null>(null);
    const [cargando, setCargando] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const clave = `${desde}|${hasta}|${estado}`;
    const [snapshot, setSnapshot] = useState<string | null>(null);
    const { iniciar } = useLecturaVigente(clave);
    /**
     * `refrescarIM` va aparte de `forzar`: cuando cambia el kilaje de una bolsa hay que rearmar
     * el listado, pero los renglones de InfoManager son los mismos de hace un segundo. Pedirle a
     * IM que los baje de nuevo serían segundos de espera por un dato que no cambió.
     */
    const cargar = useCallback(async (forzar = false, refrescarIM = forzar) => {
        const lectura = iniciar(forzar); if (!lectura) return;
        setSnapshot(null);
        setCargando(true); setError(null);
        try {
            const r = await fetch(
                `/api/presupuestos/fraccionado?desde=${desde}&hasta=${hasta}&estado=${estado}${refrescarIM ? '&refrescar=1' : ''}`,
                { headers: authHeaders(), signal: lectura.signal });
            const d = await r.json().catch(() => null);
            if (!lectura.vigente()) return;
            if (!r.ok) throw new Error(d?.error ?? 'No se pudo armar el listado');
            if (d.completo === false || d.dias_faltantes?.length || d.comprobantes_sin_items?.length || d.dias_sin_items?.length || d.controles_incompletos?.length || d.parcial) throw new Error('El listado está incompleto. Actualizá antes de imprimir.');
            if ((d.desde && d.desde !== desde) || (d.hasta && d.hasta !== hasta)) throw new Error('El servidor respondió otro rango. Ajustá las fechas antes de imprimir.');
            setSnapshot(clave); lectura.confirmar();
            setLineas((d.fraccionado ?? []).map(normalizarLinea));
            setTotales(d.totales ?? null);
            setComprobantes(d.comprobantes ?? 0);
            setCuenta(d.cuenta ?? null);
            setProduccion(d.produccion ?? []);
            setTotalesProduccion(d.totales_produccion ?? null);
        } catch (e: any) {
            if (!lectura.vigente()) return;
            setCuenta(null); setProduccion([]); setTotalesProduccion(null);
            setError(e?.message ?? 'Error de conexión');
        } finally {
            if (lectura.vigente()) setCargando(false);
        }
    }, [desde, hasta, estado, clave, iniciar]);

    /**
     * 🔑 EL KILAJE DE LA BOLSA SE CARGA ACÁ MISMO.
     *
     * Mati (17/09/2026): *"van cambiando los kilajes de las bolsas, no son siempre iguales...
     * instantánea ahora tiene 20, arrollada por 30 y el sorgo por 40"*. Hasta hoy el número vivía
     * en el código: cambiarlo pedía un despliegue, y mientras tanto el sector fraccionaba mal.
     *
     * Se guarda al salir del campo y el listado se rearma en el acto —sin volver a pedirle los
     * renglones a InfoManager, que no cambiaron— para que se vea el efecto del número recién
     * escrito: es la única forma de saber si era el correcto.
     */
    const [guardandoKilaje, setGuardandoKilaje] = useState<number | null>(null);
    const [errorKilaje, setErrorKilaje] = useState<string | null>(null);
    async function guardarKilaje(cod: number, texto: string) {
        // Coma o punto: en la oficina se escribe 22,5.
        const limpio = texto.trim().replace(',', '.');
        const kg = limpio === '' ? null : Number(limpio);
        if (kg !== null && !(Number.isFinite(kg) && kg > 0)) {
            setErrorKilaje('El kilaje de la bolsa tiene que ser un número mayor que cero.'); return;
        }
        setGuardandoKilaje(cod); setErrorKilaje(null);
        try {
            const r = await fetch(`/api/presupuestos/fraccionado/kilaje/${cod}`, {
                method: 'PUT', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ kg }),
            });
            const d = await r.json().catch(() => null);
            if (!r.ok || d?.ok === false) throw new Error(d?.error ?? 'No se pudo guardar el kilaje');
            await cargar(true, false);
        } catch (e: any) {
            setErrorKilaje(e?.message ?? 'No se pudo guardar el kilaje');
        } finally { setGuardandoKilaje(null); }
    }

    useEffect(() => { void cargar(); }, [cargar]);

    // Mientras esta vista está abierta, imprimir saca SOLO el listado (ver el @media print).
    useEffect(() => {
        document.body.classList.add('fr-print-active');
        return () => document.body.classList.remove('fr-print-active');
    }, []);

    return (
        <div className="fr-root">
            <div className="fr-top fr-no-print">
                <button className="fr-btn ghost" onClick={() => void cargar(true)} disabled={cargando}>
                    <RefreshCw size={15} className={cargando ? 'spin' : ''} /> Actualizar
                </button>
                <label className="fr-check">
                    <span className="fr-check-tit">Mostrar</span>
                    <select value={estado} onChange={e => setEstado(e.target.value as any)} disabled={cargando}>
                        <option value="pendientes">Lo que falta fraccionar{cuenta ? ` (${cuenta.pendientes})` : ''}</option>
                        <option value="facturados">Lo ya facturado{cuenta ? ` (${cuenta.facturados})` : ''}</option>
                        <option value="todos">Todo el rango</option>
                    </select>
                </label>
                <span className="fr-meta">{comprobantes} pedidos</span>
                <button className="fr-btn" onClick={() => window.print()} disabled={!lineas.length || cargando || !!error || snapshot !== clave}>
                    <Printer size={15} /> Imprimir
                </button>
            </div>

            {error && <div className="fr-aviso fr-no-print"><AlertTriangle size={15} /><span>{error}</span></div>}
            {errorKilaje && <div className="fr-aviso fr-no-print"><AlertTriangle size={15} /><span>{errorKilaje}</span></div>}
            {cargando && <div className="fr-cargando fr-no-print"><Loader2 className="spin" size={20} /> Armando el listado…</div>}
            {!cargando && !lineas.length && !error && (
                <div className="fr-vacio fr-no-print">
                    <Package size={26} />
                    <span>{estado === 'pendientes'
                        ? 'No queda nada por fraccionar en estos días: los pedidos que hay ya están facturados.'
                        : estado === 'facturados'
                        ? 'Todavía no se facturó ningún pedido de estos días.'
                        : 'No hay nada para fraccionar en estos días.'}</span>
                </div>
            )}

            {!!lineas.length && !cargando && !error && snapshot === clave && (
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

                    {/**
                      * 🔴 Por qué algunas cantidades van enteras. Sin este renglón, el sector ve un
                      * paquete de 40 kg y no sabe si es un error del listado o la bolsa entera.
                      * Va también en el papel: el que fracciona es quien puede decir el kilaje.
                      */}
                    {lineas.some(l => l.sin_formato) && (
                        <div className="fr-nota-kilaje fr-no-print">
                            <AlertTriangle size={14} />
                            <span>
                                {lineas.filter(l => l.sin_formato).length} producto{lineas.filter(l => l.sin_formato).length === 1 ? '' : 's'} sin
                                kilaje de bolsa cargado: su cantidad va como vino en el pedido, sin partir.
                                Cargalo en la columna <b>Bolsa</b> y el listado se rehace solo.
                            </span>
                        </div>
                    )}

                    {/* Cada cantidad en su cajita: se tilda al preparar el paquete. */}
                    <div className="fr-tabla-scroll"><table className="fr-tabla">
                        <thead>
                            <tr><th>Código</th><th>Producto</th><th className="fr-no-print">Bolsa</th><th className="fr-no-print">Pedido</th><th>Paquetes</th><th className="n">Cant.</th><th className="n">Kilos</th></tr>
                        </thead>
                        <tbody>
                            {lineas.map(l => (
                                <tr key={l.cod_articulo} className={l.sin_formato ? 'fr-sin-formato' : undefined}>
                                    <td>{l.cod_articulo || '—'}</td>
                                    <td className="fr-prod">{l.descripcion}</td>
                                    {/* El kilaje de la bolsa, editable. Se escribe y el listado se rearma solo. */}
                                    <td className="fr-kilaje fr-no-print">
                                        <label>
                                            <input
                                                type="text" inputMode="decimal" defaultValue={l.formato_bolsa ?? ''}
                                                placeholder="—" aria-label={`Kilos por bolsa de ${l.descripcion}`}
                                                disabled={guardandoKilaje != null}
                                                onBlur={e => {
                                                    const antes = l.formato_bolsa == null ? '' : String(l.formato_bolsa);
                                                    if (e.target.value.trim().replace(',', '.') !== antes) void guardarKilaje(l.cod_articulo, e.target.value);
                                                }}
                                                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                                            />
                                            <span>kg</span>
                                        </label>
                                        {l.sin_formato && <small className="fr-falta-kilaje">cargá el kilaje</small>}
                                    </td>
                                    {/* 🔑 Lo que pidió el cliente, sin interpretar. Mientras falte el kilaje es lo
                                        único con lo que el sector puede armar el paquete a mano. */}
                                    <td className="fr-no-print">
                                        <div className="fr-cajitas fr-pedido">
                                            {l.pedidos.map((c, i) => <span className="fr-crudo" key={i}>{num(c)}</span>)}
                                        </div>
                                    </td>
                                    <td>
                                        <div className="fr-cajitas">
                                            {l.cantidades.map((c, i) => <span className="fr-cajita" key={i}>{num(c)}</span>)}
                                            {/* Las bolsas cerradas van marcadas aparte: se agarran del depósito
                                                y no se abren. Si no se mostraran, el sector las buscaría. */}
                                            {l.bolsas_enteras > 0 && (
                                                <span className="fr-bolsas">
                                                    + {l.bolsas_enteras} bolsa{l.bolsas_enteras === 1 ? '' : 's'} cerrada{l.bolsas_enteras === 1 ? '' : 's'}
                                                    {l.formato_bolsa ? ` de ${l.formato_bolsa} kg` : ''} (no fraccionar)
                                                </span>
                                            )}
                                        </div>
                                    </td>
                                    <td className="n">{l.paquetes}</td>
                                    <td className="n">{num(l.kg)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table></div>

                    {/**
                      * 🔑 LO QUE HAY QUE PRODUCIR, en su propia tabla.
                      *
                      * Mati (16/09/2026): *"necesitamos saber también para que produzcan la gente
                      * de producción"*. Son balanceados propios y maíz quebrado: bolsas cerradas
                      * que no se fraccionan, así que van aparte y no mezcladas con los paquetes
                      * —el sector de fraccionamiento no tiene nada que hacer con ellas—.
                      */}
                    {!!produccion.length && (
                        <div className="fr-produccion">
                            <h3>Para producir</h3>
                            <div className="fr-datos">
                                <span><b>Productos</b> {totalesProduccion?.productos ?? 0}</span>
                                <span><b>Bolsas</b> {num(totalesProduccion?.bolsas ?? 0)}</span>
                                {!!totalesProduccion?.kg && <span><b>Kilos</b> {num(totalesProduccion.kg)}</span>}
                            </div>
                            <div className="fr-tabla-scroll"><table className="fr-tabla">
                                <thead>
                                    <tr><th>Código</th><th>Producto</th><th className="n">Bolsas</th><th className="n">Kilos</th></tr>
                                </thead>
                                <tbody>
                                    {produccion.map(l => (
                                        <tr key={l.cod_articulo}>
                                            <td>{l.cod_articulo || '—'}</td>
                                            <td className="fr-prod">{l.descripcion}</td>
                                            <td className="n"><b>{num(l.bolsas)}</b></td>
                                            <td className="n">{l.kg == null ? '—' : num(l.kg)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table></div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
