import { Activity, useState } from 'react';
import { ClipboardCheck, Boxes } from 'lucide-react';
import { PresupuestosView } from './PresupuestosView';
import { ConsolidadoView } from './ConsolidadoView';
import { useReparto } from './RepartoContext';
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
    const { ocupado, puedeNavegar } = useReparto();
    const [seccion, setSeccion] = useState<Seccion>('pedidos');
    /**
     * 🪤 La revisión NO se desmonta al cambiar de sección: se esconde.
     *
     * El flujo natural es marcar con el tacho qué sacar, pasar a "Por artículo" para ver si eso
     * alcanza, y volver. Desmontando, al volver el presupuesto estaba cerrado y las marcas no
     * estaban — trabajo perdido sin ningún aviso (auditoría del 08/09/2026).
     *
     * El consolidado sí espera a que lo visiten: consultarlo cuesta segundos contra InfoManager
     * y no tiene por qué correr cuando nadie lo abrió.
     */
    const [visitoArticulos, setVisitoArticulos] = useState(false);

    return (
        <div className="ps-root">
            <nav className="ps-subtabs">
                <button aria-label="Por pedido" className={seccion === 'pedidos' ? 'on' : ''} disabled={ocupado} onClick={() => { if (puedeNavegar()) setSeccion('pedidos'); }}>
                    <ClipboardCheck size={14} /> <span>Por pedido</span>
                </button>
                <button aria-label="Por artículo" className={seccion === 'articulos' ? 'on' : ''} disabled={ocupado} onClick={() => { if (!puedeNavegar()) return; setSeccion('articulos'); setVisitoArticulos(true); }}>
                    <Boxes size={14} /> <span>Por artículo</span>
                </button>
            </nav>

            <Activity mode={seccion === 'pedidos' ? 'visible' : 'hidden'}>
                <PresupuestosView desde={desde} hasta={hasta} />
            </Activity>
            {visitoArticulos && (
                <Activity mode={seccion === 'articulos' ? 'visible' : 'hidden'}>
                    <ConsolidadoView desde={desde} hasta={hasta} />
                </Activity>
            )}
        </div>
    );
}
