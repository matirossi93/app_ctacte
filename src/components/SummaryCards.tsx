import type { VendorSummary } from '../types';
import { formatCurrency } from '../utils/formatters';
import { Users, TrendingUp, AlertTriangle } from 'lucide-react';
import './Dashboard.css'; // We will put modular css here or inline

interface SummaryCardsProps {
    data: VendorSummary[];
}

export const SummaryCards = ({ data }: SummaryCardsProps) => {
    const totalDebt = data.reduce((acc, v) => acc + v.totalBalance, 0);
    const totalInterest = data.reduce((acc, v) => acc + v.totalInterest, 0);
    const totalExpected = totalDebt + totalInterest;

    // Let's count unique clients with debt and those with overdue invoices
    let totalClients = 0;
    let clientsWithOverdue = 0;

    data.forEach(v => {
        v.clients.forEach(c => {
            if (c.totalBalance > 0) totalClients++;
            if (c.maxDaysOverdue > 0) clientsWithOverdue++;
        });
    });

    return (
        <div className="summary-cards-container">
            <div className="summary-card glass primary-gradient">
                <div className="card-icon"><TrendingUp size={24} /></div>
                <div className="card-content">
                    <p className="card-title">Deuda Total Esperada</p>
                    <h2 className="card-value">{formatCurrency(totalExpected)}</h2>
                    <p className="card-subtitle">
                        Base: {formatCurrency(totalDebt)} + {formatCurrency(totalInterest)} interés
                    </p>
                </div>
            </div>

            <div className="summary-card glass warning-bg">
                <div className="card-icon text-warning"><AlertTriangle size={24} /></div>
                <div className="card-content">
                    <p className="card-title text-warning">Clientes en Mora</p>
                    <h2 className="card-value text-warning">{clientsWithOverdue}</h2>
                    <p className="card-subtitle text-warning-muted">
                        de {totalClients} clientes con deuda
                    </p>
                </div>
            </div>

            <div className="summary-card glass">
                <div className="card-icon text-primary"><Users size={24} /></div>
                <div className="card-content">
                    <p className="card-title">Vendedores Activos</p>
                    <h2 className="card-value">{data.filter(v => v.totalBalance > 0).length}</h2>
                    <p className="card-subtitle">
                        Con facturas pendientes
                    </p>
                </div>
            </div>
        </div>
    );
};
