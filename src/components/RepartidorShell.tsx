import { RecibosApp } from './RecibosApp';

interface Props {
    onLogout: () => void;
}

/**
 * Shell del repartidor.
 *
 * Los repartidores no hacen ventas ni siguen cuenta corriente: solo necesitan
 * (1) cargar comprobantes de pago — a veces los clientes les transfieren al
 * recibir la mercadería — y (2) consultar los comprobantes cargados por los
 * vendedores, para saber si un cliente ya pagó antes de ir a entregarle.
 *
 * Por eso su pantalla es directamente la app de Recibos en modo página
 * completa, sin las tabs de Hoy / Cobranzas / Objetivos / Comisiones /
 * Actividad que ven vendedores y backoffice en VendorShell.
 *
 * El picker de clientes lo resuelve RecibosApp solo (fetch a
 * /api/clientes/lookup, que para el repartidor devuelve el maestro completo).
 */
export const RepartidorShell = ({ onLogout }: Props) => {
    return (
        <RecibosApp fullPage onClose={onLogout} onLogout={onLogout} />
    );
};
