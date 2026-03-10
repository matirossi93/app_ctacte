import type { VendorSummary } from '../types';
import { AlertCircle, TrendingUp } from 'lucide-react';
import { formatCurrency } from '../utils/formatters';

interface TopDebtorsAlertProps {
    data: VendorSummary[];
}

export const TopDebtorsAlert = ({ data }: TopDebtorsAlertProps) => {
    // Flatten all clients
    const allClients = data.flatMap(v => 
        v.clients.map(c => ({
            ...c,
            // Keep track of which vendor they belong to for context
            vendorName: v.vendorName 
        }))
    );

    // Filter only those with actual overdue invoices
    const overdueClients = allClients.filter(c => c.maxDaysOverdue > 0);

    // Sort by largest debt first
    overdueClients.sort((a, b) => b.totalWithInterest - a.totalWithInterest);

    // Take top 5
    const topDebtors = overdueClients.slice(0, 5);

    if (topDebtors.length === 0) {
        return null;
    }

    return (
        <div className="glass" style={{ marginBottom: '2rem', padding: '1.5rem', borderLeft: '4px solid var(--color-danger)' }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: '1rem', gap: '0.5rem' }}>
                <AlertCircle size={24} color="var(--color-danger)" />
                <h2 style={{ fontSize: '1.25rem', color: 'var(--color-text)' }}>Alertas: Top Deudores Críticos</h2>
            </div>
            
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '1rem' }}>
                {topDebtors.map(client => (
                    <div key={`${client.vendorId}-${client.clientId}`} style={{ 
                        background: 'var(--color-bg)', 
                        padding: '1rem', 
                        borderRadius: '0.5rem',
                        border: '1px solid var(--color-border)'
                    }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
                            <div>
                                <h4 style={{ margin: 0, fontSize: '0.95rem' }}>{client.clientName}</h4>
                                <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>{client.vendorName} • Cod: {client.clientId}</span>
                            </div>
                            {client.localidad && (
                                <span className="badge" style={{ backgroundColor: 'var(--color-surface)', fontSize: '0.7rem' }}>
                                    📍 {client.localidad}
                                </span>
                            )}
                        </div>
                        
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: '1rem' }}>
                            <div>
                                <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', display: 'block' }}>Atraso Máximo</span>
                                <span style={{ color: 'var(--color-danger)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                                    <TrendingUp size={14} /> {client.maxDaysOverdue} días
                                </span>
                            </div>
                            <div style={{ textAlign: 'right' }}>
                                <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', display: 'block' }}>Deuda Total</span>
                                <span style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--color-text)' }}>
                                    {formatCurrency(client.totalWithInterest)}
                                </span>
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};
