import { useState } from 'react';
import { Truck, Store, UserCheck } from 'lucide-react';
import { HojasRutaView } from './HojasRutaView';
import { RetirosView } from './RetirosView';
import { LiquidacionView } from './LiquidacionView';
import './EntregasView.css';

/**
 * La etapa 3 del circuito: cómo sale la mercadería y qué se le paga a quien la lleva.
 *
 *   · HOJAS DE RUTA — el armado del día.
 *   · RETIROS       — los que el cliente pasa a buscar, acumulados por mes.
 *   · LIQUIDACIÓN   — lo que entregó cada chofer en el mes.
 *
 * 🔑 Van como sub-secciones y NO como pestañas del header a propósito: el 08/09/2026 pasar de 2 a
 * 4 pestañas ya había roto la barra en el celular (535 px de pestañas en 325 px de pantalla).
 * Siete pestañas arriba no entran; acá abajo, cada sección respira.
 *
 * 📌 Se monta una por vez: Hojas de ruta consulta InfoManager al abrirse (~7 s) y no tiene por
 * qué correr mientras se mira la liquidación del mes pasado.
 */

type Seccion = 'hojas' | 'retiros' | 'liquidacion';

export function EntregasView({ desde, hasta }: { desde: string; hasta: string }) {
    const [seccion, setSeccion] = useState<Seccion>('hojas');

    return (
        <div className="en-root">
            <nav className="en-subtabs">
                <button className={seccion === 'hojas' ? 'on' : ''} onClick={() => setSeccion('hojas')}>
                    <Truck size={14} /> <span>Hojas de ruta</span>
                </button>
                <button className={seccion === 'retiros' ? 'on' : ''} onClick={() => setSeccion('retiros')}>
                    <Store size={14} /> <span>Retiros en sucursal</span>
                </button>
                <button className={seccion === 'liquidacion' ? 'on' : ''} onClick={() => setSeccion('liquidacion')}>
                    <UserCheck size={14} /> <span>Liquidación</span>
                </button>
            </nav>

            {seccion === 'hojas' && <HojasRutaView desde={desde} hasta={hasta} />}
            {seccion === 'retiros' && <RetirosView />}
            {seccion === 'liquidacion' && <LiquidacionView />}
        </div>
    );
}
