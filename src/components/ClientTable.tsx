import type { VendorSummary, Invoice } from '../types';
import { formatCurrency } from '../utils/formatters';
import { AlertTriangle, Clock, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { useState } from 'react';

interface ClientTableProps {
    vendor: VendorSummary | null;
    clientThresholds?: Record<string, number>;
    onUpdateThreshold?: (clientId: string, days: number) => void;
}

export const ClientTable = ({ vendor, clientThresholds = {}, onUpdateThreshold }: ClientTableProps) => {
    const [sortCol, setSortCol] = useState<keyof Invoice>('daysOverdue');
    const [sortDesc, setSortDesc] = useState(true);

    if (!vendor) {
        return (
            <div className="glass empty-state">
                <div className="empty-state-icon"><Clock size={48} /></div>
                <h3>Selecciona un Vendedor</h3>
                <p>Haz clic en un vendedor de la lista para ver el detalle de sus clientes.</p>
            </div>
        );
    }

    const handleSort = (col: keyof Invoice) => {
        if (sortCol === col) {
            setSortDesc(!sortDesc);
        } else {
            setSortCol(col);
            setSortDesc(col === 'daysOverdue' || col === 'balance' || col === 'totalWithInterest'); // Default to desc for numbers
        }
    };

    const sortIcon = (col: keyof Invoice) => {
        if (sortCol !== col) return <ArrowUpDown size={12} style={{ opacity: 0.3, marginLeft: '4px' }} />;
        return sortDesc ? <ArrowDown size={12} style={{ marginLeft: '4px' }} /> : <ArrowUp size={12} style={{ marginLeft: '4px' }} />;
    };

    return (
        <div className="client-detail-area">
            {vendor.clients.map(client => {
                const sortedInvoices = [...client.invoices].sort((a, b) => {
                    const aVal = a[sortCol];
                    const bVal = b[sortCol];

                    if (typeof aVal === 'string' && typeof bVal === 'string') {
                        return sortDesc ? bVal.localeCompare(aVal) : aVal.localeCompare(bVal);
                    }

                    if (typeof aVal === 'number' && typeof bVal === 'number') {
                        return sortDesc ? bVal - aVal : aVal - bVal;
                    }

                    return 0;
                });

                return (
                    <div key={client.clientId} className="glass client-section">
                        <div className="client-header">
                            <div>
                                <h3>{client.clientName}</h3>
                                <div className="client-meta">
                                    <span>Cod: {client.clientId}</span>
                                    <div className="threshold-selector">
                                        <label htmlFor={`threshold-${client.clientId}`} style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>Mora tras:</label>
                                        <select
                                            id={`threshold-${client.clientId}`}
                                            value={clientThresholds[client.clientId] || 0}
                                            onChange={(e) => onUpdateThreshold?.(client.clientId, Number(e.target.value))}
                                            className="interest-select"
                                        >
                                            <option value={0}>Por defecto (Sist.)</option>
                                            <option value={7}>7 días</option>
                                            <option value={15}>15 días</option>
                                            <option value={30}>30 días</option>
                                        </select>
                                    </div>
                                    {client.maxDaysOverdue > 0 && (
                                        <span className="badge badge-danger">
                                            <AlertTriangle size={14} style={{ display: 'inline', verticalAlign: 'middle', marginRight: '4px' }} />
                                            Atraso máx: {client.maxDaysOverdue} días
                                        </span>
                                    )}
                                </div>
                            </div>

                            <div className="client-total-box">
                                <span style={{ fontSize: '0.75rem' }}>Total adeudado (+ intereses)</span>
                                <strong>{formatCurrency(client.totalWithInterest)}</strong>
                            </div>
                        </div>

                        <div className="table-responsive">
                            <table className="data-table">
                                <thead>
                                    <tr>
                                        <th style={{ cursor: 'pointer' }} onClick={() => handleSort('date')}>Fecha Emisión {sortIcon('date')}</th>
                                        <th style={{ cursor: 'pointer' }} onClick={() => handleSort('daysEmission')}>Días Emitida {sortIcon('daysEmission')}</th>
                                        <th style={{ cursor: 'pointer' }} onClick={() => handleSort('daysOverdue')}>Días Deuda {sortIcon('daysOverdue')}</th>
                                        <th className="amount-column" style={{ cursor: 'pointer' }} onClick={() => handleSort('balance')}>Saldo Original {sortIcon('balance')}</th>
                                        <th className="amount-column">Interés Calculado</th>
                                        <th className="amount-column" style={{ cursor: 'pointer' }} onClick={() => handleSort('totalWithInterest')}>Total a Cobrar {sortIcon('totalWithInterest')}</th>
                                        <th>Factura</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {sortedInvoices.map(inv => {
                                        // Colored rows for overdue alerts
                                        const isSeverelyOverdue = inv.daysOverdue >= 30;
                                        const isWarningOverdue = inv.isOverdue && inv.daysOverdue < 30;

                                        let rowClass = "";
                                        if (isSeverelyOverdue) rowClass = "row-overdue";
                                        else if (isWarningOverdue) rowClass = "row-warning";

                                        return (
                                            <tr key={inv.id} className={rowClass}>
                                                <td>{inv.date}</td>
                                                <td>{inv.daysEmission}</td>
                                                <td>
                                                    {inv.isOverdue ? (
                                                        <strong className="text-warning">{inv.daysOverdue}</strong>
                                                    ) : (
                                                        <span style={{ opacity: 0.5 }}>Al día</span>
                                                    )}
                                                </td>
                                                <td className="amount-column">
                                                    {formatCurrency(inv.balance)}
                                                </td>
                                                <td className="amount-column cell-interest">
                                                    {inv.interestAmount > 0 ? formatCurrency(inv.interestAmount) : '-'}
                                                </td>
                                                <td className="amount-column cell-total">
                                                    {formatCurrency(inv.totalWithInterest)}
                                                </td>
                                                <td style={{ textAlign: 'right', fontSize: '0.8rem', opacity: 0.7 }}>
                                                    {inv.type} {inv.invoiceNumber}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>
                );
            })}
        </div>
    );
};
