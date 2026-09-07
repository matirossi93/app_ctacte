import { useState } from 'react';
import { Truck, LogOut, Package, ChevronDown } from 'lucide-react';
import { clearToken, getUser } from '../utils/auth';
import { HojasRutaView } from './HojasRutaView';
import './OficinaShell.css';

/**
 * El panel de la oficina: acá se revisan los pedidos que cargan los vendedores, se arman las
 * hojas de ruta y sale lo que va a fraccionado.
 *
 * 🔑 Vive DENTRO de esta misma app a propósito, aunque se vea como un panel aparte: comparte
 * el login, los usuarios, los clientes, la cartera y el catálogo. Dos apps separadas
 * significarían dos deploys, dos sesiones y dos lugares donde arreglar el mismo bug. Si más
 * adelante quieren un dominio propio, ese dominio apunta acá y entra directo a esta pantalla.
 *
 * La estética es la misma que el resto (variables de index.css): verde #06652F, dorado
 * #EEC045, crema, Poppins.
 */

type Tab = 'hojas' | 'fraccionado';

export function OficinaShell() {
    const user = getUser();
    const [tab, setTab] = useState<Tab>('hojas');
    const [menuAbierto, setMenuAbierto] = useState(false);

    return (
        <div className="of-root">
            <header className="of-header">
                <div className="of-brand">
                    <Truck size={20} />
                    <span>Reparto</span>
                </div>

                <nav className="of-tabs">
                    <button className={tab === 'hojas' ? 'on' : ''} onClick={() => setTab('hojas')}>
                        Hojas de ruta
                    </button>
                    <button className={tab === 'fraccionado' ? 'on' : ''} onClick={() => setTab('fraccionado')}>
                        Fraccionado
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

            <main className="of-body">
                {tab === 'hojas' && <HojasRutaView />}
                {tab === 'fraccionado' && (
                    <div className="of-vacio">
                        <Package size={34} />
                        <p>El listado para fraccionado se arma junto con las hojas de ruta.</p>
                        <button onClick={() => setTab('hojas')}>Ir a hojas de ruta</button>
                    </div>
                )}
            </main>
        </div>
    );
}
