import { useState } from 'react';
import { Truck, LogOut, ChevronDown, ClipboardCheck, Scissors, Receipt } from 'lucide-react';
import { clearToken, getUser } from '../utils/auth';
import { EntregasView } from './EntregasView';
import { PresupuestosView } from './PresupuestosView';
import { FraccionadoView } from './FraccionadoView';
import { FacturacionView } from './FacturacionView';
import './OficinaShell.css';

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

export function OficinaShell() {
    const user = getUser();
    const [tab, setTab] = useState<Tab>('presupuestos');
    const [menuAbierto, setMenuAbierto] = useState(false);
    /**
     * El rango de días, compartido por Presupuestos, Fraccionado y Facturación.
     *
     * 🔑 Mati: *"el filtro de fecha tiene que ser por rangos, ya que Jorgelina ve franjas de
     * varios días para el armado de los pedidos"*. Arranca en el día de hoy: el rango largo se
     * paga en segundos contra InfoManager, así que se amplía cuando hace falta.
     */
    const [desde, setDesde] = useState(hoyISO());
    const [hasta, setHasta] = useState(hoyISO());

    const conRango = tab !== 'hojas';

    return (
        <div className="of-root">
            <header className="of-header">
                <div className="of-brand">
                    <Truck size={20} />
                    <span>Reparto</span>
                </div>

                <nav className="of-tabs">
                    <button className={tab === 'presupuestos' ? 'on' : ''} onClick={() => setTab('presupuestos')}>
                        <ClipboardCheck size={15} /> <span>Presupuestos</span>
                    </button>
                    <button className={tab === 'fraccionado' ? 'on' : ''} onClick={() => setTab('fraccionado')}>
                        <Scissors size={15} /> <span>Fraccionado</span>
                    </button>
                    <button className={tab === 'facturacion' ? 'on' : ''} onClick={() => setTab('facturacion')}>
                        <Receipt size={15} /> <span>Facturación</span>
                    </button>
                    <button className={tab === 'hojas' ? 'on' : ''} onClick={() => setTab('hojas')}>
                        <Truck size={15} /> <span>Hojas de ruta</span>
                    </button>
                </nav>

                <div className="of-user">
                    <button className="of-user-btn" onClick={() => setMenuAbierto(v => !v)}>
                        <span>{user?.nombre ?? user?.email ?? 'Usuario'}</span>
                        <ChevronDown size={15} />
                    </button>
                    {menuAbierto && (
                        <div className="of-user-menu" role="menu">
                            <button onClick={() => { clearToken(); location.reload(); }}>
                                <LogOut size={15} /> Cerrar sesión
                            </button>
                        </div>
                    )}
                </div>
            </header>

            {/* El rango vale para las tres primeras etapas: lo que se revisa es lo que se fracciona y
        lo que se factura. La hoja se arma por día y tiene su propio selector. */}
            {conRango && (
                <div className="of-rango">
                    <label>
                        Desde
                        <input type="date" value={desde} max={hasta} onChange={e => setDesde(e.target.value)} />
                    </label>
                    <label>
                        Hasta
                        <input type="date" value={hasta} min={desde} onChange={e => setHasta(e.target.value)} />
                    </label>
                    <div className="of-rango-atajos">
                        <button onClick={() => { setDesde(hoyISO()); setHasta(hoyISO()); }}>Hoy</button>
                        <button onClick={() => {
                            const d = new Date(Date.now() - 3 * 60 * 60 * 1000 - 6 * 864e5);
                            setDesde(d.toISOString().slice(0, 10)); setHasta(hoyISO());
                        }}>Últimos 7 días</button>
                    </div>
                </div>
            )}

            <main className="of-body">
                {tab === 'presupuestos' && <PresupuestosView desde={desde} hasta={hasta} />}
                {tab === 'fraccionado' && <FraccionadoView desde={desde} hasta={hasta} />}
                {tab === 'facturacion' && <FacturacionView desde={desde} hasta={hasta} />}
                {tab === 'hojas' && <EntregasView />}
            </main>
        </div>
    );
}
