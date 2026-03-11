import type { VendorSummary } from '../types';

interface Props {
    data: VendorSummary[];
}

const formatAmount = (n: number) =>
    new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n);

export const AgingBars = ({ data }: Props) => {
    const buckets = [
        { label: 'Al día', color: '#10b981', count: 0, amount: 0 },
        { label: '1 – 30 días', color: '#f59e0b', count: 0, amount: 0 },
        { label: '31 – 60 días', color: '#f97316', count: 0, amount: 0 },
        { label: '+60 días', color: '#ef4444', count: 0, amount: 0 },
    ];

    data.forEach(vendor =>
        vendor.clients.forEach(c => {
            const b =
                c.maxDaysOverdue === 0 ? 0 :
                c.maxDaysOverdue <= 30 ? 1 :
                c.maxDaysOverdue <= 60 ? 2 : 3;
            buckets[b].count++;
            buckets[b].amount += c.totalWithInterest;
        })
    );

    const maxAmount = Math.max(...buckets.map(b => b.amount), 1);
    const totalClients = buckets.reduce((s, b) => s + b.count, 0);

    if (totalClients === 0) return null;

    return (
        <div className="aging-bars glass">
            <h3 className="aging-title">Antigüedad de Deuda</h3>
            <div className="aging-grid">
                {buckets.map(b => (
                    <div key={b.label} className="aging-row">
                        <div className="aging-meta">
                            <span className="aging-label">{b.label}</span>
                            <span className="aging-count">{b.count} clientes</span>
                        </div>
                        <div className="aging-track">
                            <div
                                className="aging-fill"
                                style={{
                                    width: `${(b.amount / maxAmount) * 100}%`,
                                    background: b.color
                                }}
                            />
                        </div>
                        <span className="aging-amount">{formatAmount(b.amount)}</span>
                    </div>
                ))}
            </div>
        </div>
    );
};
