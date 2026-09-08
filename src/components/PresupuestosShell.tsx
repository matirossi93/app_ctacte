import { useState } from 'react';
import { ClipboardCheck, Boxes } from 'lucide-react';
import { PresupuestosView } from './PresupuestosView';
import { ConsolidadoView } from './ConsolidadoView';
import './PresupuestosShell.css';

/**
 * La etapa 1 mirada de dos maneras:
 *
 *  · POR PEDIDO    — la revisión de siempre: cliente por cliente, listas, cantidades, stock.
 *  · POR ARTÍCULO  — cuánto se pidió de cada cosa en todo el rango contra lo que hay.
 *
 * 🔑 Son la misma información y contestan preguntas distintas. "¿Este pedido está bien?" se
 * responde por pedido; "¿me alcanza el alpiste y a quién se lo doy?" **sólo** se responde
 * sumando todo primero (Mati, 08/09/2026: *"eso se está midiendo factura a factura, esa no era
 * la idea"*).
 *
 * 📌 Van como sub-secciones y no como pestañas del header, por lo mismo que Entregas: cinco
 * pestañas arriba no entran en el celular.
 */

type Seccion = 'pedidos' | 'articulos';

export function PresupuestosShell({ desde, hasta }: { desde: string; hasta: string }) {
    const [seccion, setSeccion] = useState<Seccion>('pedidos');

    return (
        <div className="ps-root">
            <nav className="ps-subtabs">
                <button className={seccion === 'pedidos' ? 'on' : ''} onClick={() => setSeccion('pedidos')}>
                    <ClipboardCheck size={14} /> <span>Por pedido</span>
                </button>
                <button className={seccion === 'articulos' ? 'on' : ''} onClick={() => setSeccion('articulos')}>
                    <Boxes size={14} /> <span>Por artículo</span>
                </button>
            </nav>

            {seccion === 'pedidos' && <PresupuestosView desde={desde} hasta={hasta} />}
            {seccion === 'articulos' && <ConsolidadoView desde={desde} hasta={hasta} />}
        </div>
    );
}
