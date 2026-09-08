import { useCallback, useEffect, useState } from 'react';
import { Store, Loader2, AlertTriangle, Check, X, Users, Package } from 'lucide-react';
import { authHeaders } from '../utils/auth';
import './RetirosView.css';

/**
 * RETIRO EN SUCURSAL: los pedidos que el cliente pasa a buscar y no salen en el camión.
 *
 * Mati (08/09/2026): *"hay algunos de esos pedidos que no van por hoja de ruta sino que los
 * clientes pasan a retirar (son pocos)... debería ir acumulándose los de todo el mes para poder
 * analizarlo después"*. Por eso la pantalla es el ACUMULADO DEL MES y no el día: el día ya se ve
 * al armar la hoja, lo que no existía era el total.
 *
 * 📌 Se facturan igual que los que viajan (*"los retiros en sucursal se facturan igual"*): salen
 * de la misma pantalla de Facturación y acá se los marca como retiro en vez de mandarlos a una
 * hoja.
 */

interface Retiro {
    im_comprobante_id: string;
    im_numero: number | null;
    cod_cliente: number;
    cliente_nombre: string | null;
    fecha: string;
    total: number;
    bultos: number | null;
    kg: number | null;
    im_factura_numero: number | null;
    im_remito_numero: number | null;
    retirado_at: string | null;
}

interface PorCliente {
    cod_cliente: number; cliente_nombre: string | null;
    pedidos: number; importe: number; kg: number; bultos: number;
}

const money = (n: number) => '$' + Math.round(n).toLocaleString('es-AR');
const kilos = (n: number) => n.toLocaleString('es-AR', { maximumFractionDigits: 0 }) + ' kg';
const mesActual = () => new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 7);

export function RetirosView() {
    const [mes, setMes] = useState(mesActual());
    const [clientes, setClientes] = useState<PorCliente[]>([]);
    const [retiros, setRetiros] = useState<Retiro[]>([]);
    const [totales, setTotales] = useState<any>(null);
    const [cargando, setCargando] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [trabajando, setTrabajando] = useState(false);

    const cargar = useCallback(async () => {
        setCargando(true); setError(null);
        try {
            const r = await fetch(`/api/retiros/resumen?mes=${mes}`, { headers: authHeaders() });
            const d = await r.json().catch(() => null);
            if (!r.ok) throw new Error(d?.error ?? 'No se pudo traer el resumen');
            setClientes(d.clientes ?? []);
            setTotales(d.totales ?? null);

            // El detalle del mismo rango, para poder marcar cada uno.
            const l = await fetch(`/api/retiros?desde=${d.desde}&hasta=${d.hasta}`, { headers: authHeaders() });
            const dl = await l.json().catch(() => null);
            if (l.ok) setRetiros(dl?.retiros ?? []);
        } catch (e: any) {
            setError(e?.message ?? 'Error de conexión');
        } finally {
            setCargando(false);
        }
    }, [mes]);

    useEffect(() => { void cargar(); }, [cargar]);

    /** El cliente pasó a buscarlo (o se deshace la marca si se apretó por error). */
    async function marcarRetirado(r: Retiro, retirado: boolean) {
        setTrabajando(true); setError(null);
        try {
            const resp = await fetch(`/api/retiros/${r.im_comprobante_id}`, {
                method: 'PUT',
                headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ retirado }),
            });
            const d = await resp.json().catch(() => null);
            if (!resp.ok) throw new Error(d?.error ?? 'No se pudo marcar');
            await cargar();
        } catch (e: any) {
            setError(e?.message ?? 'Error de conexión');
        } finally {
            setTrabajando(false);
        }
    }

    /**
     * Sacarlo de retiros: vuelve a estar libre para armar una hoja.
     * 🪤 Si el cliente ya lo retiró, el server lo rechaza — el registro del mes tiene que
     * reflejar lo que pasó de verdad.
     */
    async function quitar(r: Retiro) {
        if (!confirm(`¿Sacar el pedido ${r.im_numero ?? ''} de ${r.cliente_nombre ?? 'el cliente'} de la lista de retiros?\n\nVuelve a estar disponible para armar una hoja de ruta.`)) return;
        setTrabajando(true); setError(null);
        try {
            const resp = await fetch(`/api/retiros/${r.im_comprobante_id}`, { method: 'DELETE', headers: authHeaders() });
            const d = await resp.json().catch(() => null);
            if (!resp.ok) throw new Error(d?.error ?? 'No se pudo sacar');
            await cargar();
        } catch (e: any) {
            setError(e?.message ?? 'Error de conexión');
        } finally {
            setTrabajando(false);
        }
    }

    return (
        <div className="rt-root">
            <div className="rt-top">
                <label className="rt-mes">
                    Mes
                    <input type="month" value={mes} onChange={e => setMes(e.target.value)} />
                </label>
                {cargando && <Loader2 size={16} className="rt-girando" />}
            </div>

            {error && <div className="rt-aviso error"><AlertTriangle size={14} /> {error}</div>}

            {totales && (
                <div className="rt-totales">
                    <div><span>Pedidos</span><b>{totales.pedidos}</b></div>
                    <div><span>Clientes</span><b>{totales.clientes}</b></div>
                    <div><span>Kilos</span><b>{kilos(totales.kg ?? 0)}</b></div>
                    <div><span>Bultos</span><b>{Math.round(totales.bultos ?? 0)}</b></div>
                    <div className="importe"><span>Importe del mes</span><b>{money(totales.importe ?? 0)}</b></div>
                    {/* Mercadería preparada que sigue ocupando lugar en el depósito. */}
                    {totales.sin_retirar > 0 && (
                        <div className="pendiente"><span>Sin retirar</span><b>{totales.sin_retirar}</b></div>
                    )}
                </div>
            )}

            {!cargando && !retiros.length && (
                <div className="rt-vacio">
                    <Store size={26} />
                    <span>No hay retiros en sucursal este mes.</span>
                    <small>Se marcan desde Hojas de ruta: se eligen los pedidos y se aprieta “Retira el cliente”.</small>
                </div>
            )}

            {!!clientes.length && (
                <section className="rt-seccion">
                    <h3><Users size={15} /> Por cliente</h3>
                    <div className="rt-tabla">
                        {clientes.map(c => (
                            <div className="rt-cli" key={c.cod_cliente}>
                                <span className="rt-cli-nom">{c.cliente_nombre ?? `Cliente ${c.cod_cliente}`}</span>
                                <span>{c.pedidos} ped.</span>
                                <span>{kilos(c.kg)}</span>
                                <b>{money(c.importe)}</b>
                            </div>
                        ))}
                    </div>
                </section>
            )}

            {!!retiros.length && (
                <section className="rt-seccion">
                    <h3><Package size={15} /> Detalle</h3>
                    {retiros.map(r => (
                        <div className={`rt-fila${r.retirado_at ? ' listo' : ''}`} key={r.im_comprobante_id}>
                            <div>
                                <div className="rt-fila-tit">
                                    {r.cliente_nombre ?? `Cliente ${r.cod_cliente}`}
                                    {r.im_remito_numero != null
                                        ? <span className="rt-badge">FA {r.im_factura_numero ?? '—'} · RE {r.im_remito_numero}</span>
                                        : <span className="rt-badge sin">sin facturar</span>}
                                </div>
                                <div className="rt-fila-meta">
                                    {r.fecha} · PR {r.im_numero ?? '—'} · {kilos(Number(r.kg ?? 0))} · {money(Number(r.total ?? 0))}
                                    {r.retirado_at && ' · retirado'}
                                </div>
                            </div>
                            <button
                                className={`rt-btn${r.retirado_at ? ' ghost' : ''}`}
                                onClick={() => void marcarRetirado(r, !r.retirado_at)}
                                disabled={trabajando}
                                title={r.retirado_at ? 'Deshacer' : 'El cliente ya pasó a buscarlo'}
                            >
                                <Check size={14} /> {r.retirado_at ? 'Retirado' : 'Marcar retirado'}
                            </button>
                            {/* Una vez retirado no se borra: el registro del mes tiene que quedar. */}
                            {!r.retirado_at && (
                                <button className="rt-icono" title="Sacar de retiros" onClick={() => void quitar(r)} disabled={trabajando}>
                                    <X size={14} />
                                </button>
                            )}
                        </div>
                    ))}
                </section>
            )}
        </div>
    );
}
