import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, PieChart, Pie } from 'recharts';
import type { VendorSummary } from '../types';
import './AnalyticsDashboard.css';

interface Props {
    data: VendorSummary[];
}

export const AnalyticsDashboard = ({ data }: Props) => {
    // 1. Prepare data for Aging (Debt Maturity)
    // We'll categorize clients based on their maxDaysOverdue
    const agingBuckets = [
        { name: '0-30 días', value: 0, color: '#10b981' }, // emerald-500
        { name: '31-60 días', value: 0, color: '#f59e0b' }, // amber-500
        { name: '61-90 días', value: 0, color: '#ef4444' }, // red-500
        { name: '+90 días', value: 0, color: '#991b1b' },   // red-800
    ];

    data.forEach(vendor => {
        vendor.clients.forEach(client => {
            if (client.maxDaysOverdue <= 30) agingBuckets[0].value += client.totalBalance;
            else if (client.maxDaysOverdue <= 60) agingBuckets[1].value += client.totalBalance;
            else if (client.maxDaysOverdue <= 90) agingBuckets[2].value += client.totalBalance;
            else agingBuckets[3].value += client.totalBalance;
        });
    });

    // 2. Prepare data for Concentration by Vendor (Pie Chart)
    const vendorConcentration = data
        .map(v => ({
            name: v.vendorName.replace('VENDEDOR ', ''),
            value: v.totalBalance
        }))
        .sort((a, b) => b.value - a.value);

    const COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f43f5e', '#f97316', '#eab308'];

    const formatCurrency = (val: number) =>
        new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(val);

    return (
        <div className="analytics-grid">
            <div className="analytics-card glass">
                <h3>Antigüedad de la Deuda (Aging)</h3>
                <p className="subtitle">Desglose de capital en la calle por atraso</p>
                <div className="chart-container">
                    <ResponsiveContainer width="100%" height={300}>
                        <BarChart data={agingBuckets}>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.1} />
                            <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 12 }} />
                            <YAxis
                                hide
                            />
                            <Tooltip
                                formatter={(value: number | any) => [formatCurrency(Number(value) || 0), 'Deuda']}
                                contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                            />
                            <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                                {agingBuckets.map((entry, index) => (
                                    <Cell key={`cell-${index}`} fill={entry.color} />
                                ))}
                            </Bar>
                        </BarChart>
                    </ResponsiveContainer>
                </div>
            </div>

            <div className="analytics-card glass">
                <h3>Concentración por Vendedor</h3>
                <p className="subtitle">Reparto del total a cobrar</p>
                <div className="chart-container">
                    <ResponsiveContainer width="100%" height={300}>
                        <PieChart>
                            <Pie
                                data={vendorConcentration}
                                cx="50%"
                                cy="50%"
                                innerRadius={60}
                                outerRadius={80}
                                paddingAngle={5}
                                dataKey="value"
                            >
                                {vendorConcentration.map((_, index) => (
                                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                                ))}
                            </Pie>
                            <Tooltip
                                formatter={(value: number | any) => [formatCurrency(Number(value) || 0), 'Monto']}
                            />
                        </PieChart>
                    </ResponsiveContainer>
                    <div className="pie-legend">
                        {vendorConcentration.slice(0, 4).map((v, i) => (
                            <div key={v.name} className="legend-item">
                                <span className="dot" style={{ backgroundColor: COLORS[i % COLORS.length] }}></span>
                                <span className="name">{v.name}</span>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
};
