import type { VendorSummary } from '../types';
import { formatCurrency } from '../utils/formatters';
import { Eye, EyeOff } from 'lucide-react';

interface VendorListProps {
    vendors: VendorSummary[];
    activeVendorId: string | null;
    onSelectVendor: (id: string) => void;
    disabledVendorIds: Set<string>;
    onToggleVendor: (id: string) => void;
}

export const VendorList = ({ vendors, activeVendorId, onSelectVendor, disabledVendorIds, onToggleVendor }: VendorListProps) => {
    return (
        <div className="glass vendor-list">
            <div className="vendor-list-header">
                <h3>Vendedores ({vendors.filter(v => v.vendorId !== 'GLOBAL_VIEW').length})</h3>
            </div>

            {vendors.map(vendor => {
                const isDisabled = disabledVendorIds.has(vendor.vendorId);
                const isGlobal = vendor.vendorId === 'GLOBAL_VIEW';

                return (
                    <div
                        key={vendor.vendorId}
                        className={`vendor-item ${activeVendorId === vendor.vendorId ? 'active' : ''} ${isDisabled ? 'disabled' : ''}`}
                        onClick={() => onSelectVendor(vendor.vendorId)}
                    >
                        <div className="vendor-info">
                            <span className="vendor-name" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                {vendor.vendorName}
                                {!isGlobal && (
                                    <button
                                        className="toggle-btn"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onToggleVendor(vendor.vendorId);
                                        }}
                                        title={isDisabled ? "Activar vendedor" : "Desactivar vendedor"}
                                    >
                                        {isDisabled ? <EyeOff size={14} /> : <Eye size={14} />}
                                    </button>
                                )}
                            </span>
                            <span className="vendor-clients">{vendor.clients.length} clientes contables</span>
                        </div>
                        <div className="vendor-amount">
                            {formatCurrency(vendor.totalWithInterest)}
                        </div>
                    </div>
                );
            })}

            {vendors.length === 0 && (
                <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--color-text-muted)' }}>
                    No se encontraron vendedores
                </div>
            )}
        </div>
    );
};
