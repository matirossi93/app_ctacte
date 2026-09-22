import { contextoReparto, rangoValido } from '../utils/contextoReparto';
import { Activity, useEffect, useState } from 'react';
import { Truck, LogOut, ChevronDown, ClipboardCheck, Scissors, Receipt, RefreshCw } from 'lucide-react';
import { authHeaders, clearToken, getUser } from '../utils/auth';
import { EntregasView } from './EntregasView';
import { PresupuestosShell } from './PresupuestosShell';
import { FraccionadoView } from './FraccionadoView';
import { FacturacionView } from './FacturacionView';
import './OficinaShell.css';
import { RepartoProvider, useReparto } from './RepartoContext';

/**
 * El panel de la oficina, ordenado como el circuito real (Mati, 08/09/2026):
 *
 *   1. PRESUPUESTOS  — el primer filtrado de Jorgelina: listas, cantidades, stock.
 *   2. FRACCIONADO   — lo que el sector prepara, y se hace ANTES de armar la hoja.
 *   3. FACTURACIÓN   — sobre lo aprobado, y de ahí salen la factura y el remito.
 *   4. HOJAS DE RUTA — el último paso, con la mercadería ya facturada.
 *
 * 🔑 Vive DENTRO de esta misma app a propósito: comparte login, usuarios, clientes, cartera y
 * catálogo. Dos apps separadas serían dos deploys, dos sesiones y dos lugares donde arreglar el
 * mismo bug. Si mañana quieren dominio propio, ese dominio apunta acá.
 */

type Tab = 'presupuestos' | 'fraccionado' | 'facturacion' | 'hojas';

const hoyISO = () => {
    const d = new Date(Date.now() - 3 * 60 * 60 * 1000);   // Argentina es UTC-3 fija
    return d.toISOString().slice(0, 10);
};

export function OficinaShell() { return <RepartoProvider><OficinaContenido /></RepartoProvider>; }
function OficinaContenido() {
    const { ocupado, puedeNavegar, borradores } = useReparto();
    const [inicial] = useState(() => contextoReparto(location.search, hoyISO()));
    const [visitadas, setVisitadas] = useState<Set<Tab>>(new Set([inicial.etapa]));
    function visitar(t: Tab) { if (!puedeNavegar() || document.querySelector('dialog[open]')) return; setVisitadas(v => new Set(v).add(t)); setTab(t); }
    const user = getUser();
    const [tab, setTab] = useState<Tab>(inicial.etapa);
    const [menuAbierto, setMenuAbierto] = useState(false);
    /**
     * "Actualizar productos y clientes": vuelve a bajar de InfoManager sin esperar el cache.
     * Mati (18/09/2026) corrigió la descripción de un artículo en IM y el presupuesto seguía
     * saliendo con la anterior; y el 22/09/2026 Jo creó un cliente en IM y no le aparecía al
     * cambiarle el cliente a un presupuesto. Son 15 y 30 minutos de cache respectivamente.
     *
     * El aviso va en el texto del propio botón: es una acción de dos segundos y el menú se
     * queda abierto mirándola, no hace falta una barra de mensajes para esto.
     */
    const [catalogo, setCatalogo] = useState<'listo' | 'yendo' | { error: string } | { ok: number; clientes: number | null }>('listo');
    async function actualizarCatalogo() {
        setCatalogo('yendo');
        try {
            const r = await fetch('/api/articulos/refrescar', { method: 'POST', headers: authHeaders() });
            const d = await r.json().catch(() => ({}));
            if (!r.ok || d?.ok === false) throw new Error(d?.error || 'No pude actualizar los productos');
            // 🪤 `clientes: null` = los artículos se actualizaron y los clientes no. Se dice, no
            // se esconde: quien apretó el botón lo hizo buscando a alguien que no le aparecía.
            setCatalogo({ ok: Number(d.articulos) || 0, clientes: d.clientes == null ? null : Number(d.clientes) });
        } catch (e: any) {
            setCatalogo({ error: e?.message || 'No pude actualizar los productos' });
        }
    }

    /**
     * El rango de días, compartido por Presupuestos, Fraccionado y Facturación.
     *
     * 🔑 Mati: *"el filtro de fecha tiene que ser por rangos, ya que Jorgelina ve franjas de
     * varios días para el armado de los pedidos"*. Arranca en el día de hoy: el rango largo se
     * paga en segundos contra InfoManager, así que se amplía cuando hace falta.
     */
    const [rango, setRango] = useState(inicial.rango);
    const { desde, hasta } = rango;
    const [borradorRango, setBorradorRango] = useState(rango);
    function cambiarRango(d: string, h: string) {
        if (!puedeNavegar()) return;
        setBorradorRango({ desde: d, hasta: h });
        if (rangoValido(d, h)) setRango({ desde: d, hasta: h });
    }

    /**
     * 🔑 El rango vale para LAS CUATRO etapas. Hasta el 09/09/2026 la hoja de ruta quedaba afuera
     * y tenía su propio selector de un día: Mati pidió que también fuera por rango, porque la
     * hoja se arma con pedidos de varios días.
     */
    const conRango = true;
    useEffect(() => {
        const u = new URL(location.href); u.searchParams.set('etapa', tab); u.searchParams.set('desde', desde); u.searchParams.set('hasta', hasta);
        history.replaceState(null, '', u);
    }, [tab, desde, hasta]);
    useEffect(() => {
        const volver = () => {
            if (!puedeNavegar() || document.querySelector('dialog[open]')) {
                const u = new URL(location.href); u.searchParams.set('etapa', tab); u.searchParams.set('desde', desde); u.searchParams.set('hasta', hasta); history.replaceState(null, '', u); return;
            }
            const c = contextoReparto(location.search, hoyISO()); setRango(c.rango); setBorradorRango(c.rango); setVisitadas(v => new Set(v).add(c.etapa)); setTab(c.etapa);
        };
        window.addEventListener('popstate', volver); return () => window.removeEventListener('popstate', volver);
    }, [puedeNavegar, tab, desde, hasta]);

    return (
        <div className="of-root">
            <header className="of-header">
                <div className="of-brand">
                    <Truck size={20} />
                    <span>Reparto</span>
                </div>

                <nav className="of-tabs">
                    <button className={tab === 'presupuestos' ? 'on' : ''} disabled={ocupado} aria-label="Presupuestos" aria-current={tab === 'presupuestos' ? 'page' : undefined} onClick={() => visitar('presupuestos')}>
                        <ClipboardCheck size={15} /> <span>Presupuestos</span>
                    </button>
                    <button className={tab === 'fraccionado' ? 'on' : ''} disabled={ocupado} aria-label="Fraccionado" aria-current={tab === 'fraccionado' ? 'page' : undefined} onClick={() => visitar('fraccionado')}>
                        <Scissors size={15} /> <span>Fraccionado</span>
                    </button>
                    <button className={tab === 'facturacion' ? 'on' : ''} disabled={ocupado} aria-label="Facturación" aria-current={tab === 'facturacion' ? 'page' : undefined} onClick={() => visitar('facturacion')}>
                        <Receipt size={15} /> <span>Facturación</span>
                    </button>
                    <button className={tab === 'hojas' ? 'on' : ''} disabled={ocupado} aria-label="Hojas de ruta" aria-current={tab === 'hojas' ? 'page' : undefined} onClick={() => visitar('hojas')}>
                        <Truck size={15} /> <span>Hojas de ruta</span>
                    </button>
                </nav>

                <div className="of-user">
                    <button className="of-user-btn" onClick={() => { if (!menuAbierto) setCatalogo('listo'); setMenuAbierto(v => !v); }}>
                        <span>{user?.nombre ?? user?.email ?? 'Usuario'}</span>
                        <ChevronDown size={15} />
                    </button>
                    {menuAbierto && (
                        <div className="of-user-menu" role="menu">
                            <button disabled={catalogo === 'yendo'} onClick={() => void actualizarCatalogo()}>
                                <RefreshCw size={15} className={catalogo === 'yendo' ? 'spin' : undefined} />
                                {catalogo === 'yendo' ? 'Actualizando…'
                                    : typeof catalogo === 'object' && 'ok' in catalogo
                                        ? (catalogo.clientes == null
                                            ? `Productos al día (${catalogo.ok}) · clientes no`
                                            : `Al día: ${catalogo.ok} productos, ${catalogo.clientes} clientes`)
                                        : typeof catalogo === 'object' ? catalogo.error
                                            : 'Actualizar productos y clientes'}
                            </button>
                            <button disabled={ocupado} onClick={() => { if (!puedeNavegar()) return; borradores.clear(); for (const k of Object.keys(sessionStorage)) if (k.startsWith('reparto:') || k.startsWith('correccion:') || k.startsWith('correccion-pendiente-')) sessionStorage.removeItem(k); clearToken(); location.reload(); }}>
                                <LogOut size={15} /> Cerrar sesión
                            </button>
                        </div>
                    )}
                </div>
            </header>

            {/* El rango vale para las cuatro etapas: lo que se revisa es lo que se fracciona, lo que
        se factura y lo que sale en el camión. */}
            {conRango && (
                <div className="of-rango">
                    <label>
                        Desde
                        <input type="date" disabled={ocupado} value={borradorRango.desde} onChange={e => cambiarRango(e.target.value, borradorRango.hasta)} />
                    </label>
                    <label>
                        Hasta
                        <input type="date" disabled={ocupado} value={borradorRango.hasta} onChange={e => cambiarRango(borradorRango.desde, e.target.value)} />
                    </label>
                    {(borradorRango.desde !== desde || borradorRango.hasta !== hasta) && <span role="status">Completá un rango ordenado de hasta 32 días; se sigue mostrando {desde} a {hasta}.</span>}
                    <div className="of-rango-atajos">
                        <button disabled={ocupado} onClick={() => cambiarRango(hoyISO(), hoyISO())}>Hoy</button>
                        <button disabled={ocupado} onClick={() => {
                            const d = new Date(Date.now() - 3 * 60 * 60 * 1000 - 6 * 864e5);
                            cambiarRango(d.toISOString().slice(0, 10), hoyISO());
                        }}>Últimos 7 días</button>
                    </div>
                </div>
            )}

            <main className="of-body">
                {visitadas.has('presupuestos') && <Activity mode={tab === 'presupuestos' ? 'visible' : 'hidden'}><PresupuestosShell desde={desde} hasta={hasta} /></Activity>}
                {visitadas.has('fraccionado') && <Activity mode={tab === 'fraccionado' ? 'visible' : 'hidden'}><FraccionadoView desde={desde} hasta={hasta} /></Activity>}
                {visitadas.has('facturacion') && <Activity mode={tab === 'facturacion' ? 'visible' : 'hidden'}><FacturacionView desde={desde} hasta={hasta} /></Activity>}
                {visitadas.has('hojas') && <Activity mode={tab === 'hojas' ? 'visible' : 'hidden'}><EntregasView desde={desde} hasta={hasta} /></Activity>}
            </main>
        </div>
    );
}
