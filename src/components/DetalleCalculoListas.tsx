import type { ResultadoPedido } from '../../server-lib/listas';
import './DetalleCalculoListas.css';

/** Un único detalle consultable por pedido, sin repetir las reglas por producto. */
export function DetalleCalculoListas({ control }: { control: Pick<ResultadoPedido, 'bultos' | 'promo_general' | 'lineas'> }) {
    return <details className="listas-calculo">
        <summary>{control.bultos} {control.bultos === 1 ? 'bulto' : 'bultos'} · {control.promo_general ? 'Promo general habilitada' : `Faltan ${Math.max(0, 10 - control.bultos)} para la promo general`}</summary>
        <div>
            <p>La promo general suma los bultos de todo el presupuesto, aunque sean de distintas líneas. Cada producto conserva las listas habilitadas por sus condiciones.</p>
            {control.lineas?.map(l => <p key={l.nombre}><b>{l.nombre}: {l.unidades} unidades</b><br />{l.condiciones.join(' · ')}</p>)}
            <p>Las cantidades de una misma línea se suman entre todos sus productos y presentaciones. Las condiciones por artículo se calculan sólo con ese artículo.</p>
        </div>
    </details>;
}
