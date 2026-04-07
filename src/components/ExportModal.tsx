import { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { X, FileText } from 'lucide-react';
import type { VendorSummary } from '../types';
import { generateVendorReport } from '../utils/pdfReport';

interface ExportModalProps {
    onClose: () => void;
    vendors: VendorSummary[];
    activeVendorId: string | null;
    disabledVendorIds: Set<string>;
}

export const ExportModal = ({ onClose, vendors, activeVendorId, disabledVendorIds }: ExportModalProps) => {
    // Only real vendors (not GLOBAL_VIEW)
    const realVendors = useMemo(() =>
        vendors.filter(v => v.totalBalance > 1 && v.clients.length > 0),
        [vendors]
    );

    const [selectedIds, setSelectedIds] = useState<Set<string>>(() => {
        if (activeVendorId && activeVendorId !== 'GLOBAL_VIEW') {
            const match = realVendors.find(v => v.vendorId === activeVendorId);
            if (match) return new Set([match.vendorId]);
        }
        // Default: all non-disabled
        return new Set(realVendors.filter(v => !disabledVendorIds.has(v.vendorId)).map(v => v.vendorId));
    });

    const [includeDetail, setIncludeDetail] = useState(true);

    // Close on Escape
    useEffect(() => {
        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [onClose]);

    const toggleVendor = (id: string) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const selectAll = () => setSelectedIds(new Set(realVendors.map(v => v.vendorId)));
    const selectNone = () => setSelectedIds(new Set());

    // Preview counts
    const preview = useMemo(() => {
        let clients = 0;
        let invoices = 0;
        realVendors.forEach(v => {
            if (!selectedIds.has(v.vendorId)) return;
            clients += v.clients.length;
            invoices += v.clients.reduce((s, c) => s + c.invoices.length, 0);
        });
        return { vendors: selectedIds.size, clients, invoices };
    }, [realVendors, selectedIds]);

    const handleExport = () => {
        const filtered = realVendors.filter(v => selectedIds.has(v.vendorId));
        if (filtered.length === 0) return;
        generateVendorReport(filtered, { includeInvoiceDetail: includeDetail });
        onClose();
    };

    return createPortal(
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content glass" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
                {/* Header */}
                <div className="modal-header">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <FileText size={20} style={{ color: 'var(--color-primary)' }} />
                        <h3 style={{ margin: 0, fontSize: '1.1rem', color: 'var(--color-text)' }}>Exportar Informe PDF</h3>
                    </div>
                    <button className="modal-close-btn" onClick={onClose} title="Cerrar">
                        <X size={18} />
                    </button>
                </div>

                {/* Vendor selection */}
                <div className="modal-section">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                        <label className="modal-label">Vendedores</label>
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                            <button className="modal-link-btn" onClick={selectAll}>Todos</button>
                            <button className="modal-link-btn" onClick={selectNone}>Ninguno</button>
                        </div>
                    </div>
                    <div className="vendor-checkbox-list">
                        {realVendors.map(v => {
                            const isDisabled = disabledVendorIds.has(v.vendorId);
                            return (
                                <label key={v.vendorId} className={`vendor-checkbox-item ${isDisabled ? 'vendor-checkbox-disabled' : ''}`}>
                                    <input
                                        type="checkbox"
                                        checked={selectedIds.has(v.vendorId)}
                                        onChange={() => toggleVendor(v.vendorId)}
                                    />
                                    <span className="vendor-checkbox-name">{v.vendorName}</span>
                                    <span className="vendor-checkbox-count">{v.clients.length} clientes</span>
                                    {isDisabled && <span className="vendor-checkbox-tag">oculto</span>}
                                </label>
                            );
                        })}
                    </div>
                </div>

                {/* Options */}
                <div className="modal-section">
                    <label className="modal-label" style={{ marginBottom: '0.5rem', display: 'block' }}>Opciones</label>
                    <label className="modal-toggle">
                        <input
                            type="checkbox"
                            checked={includeDetail}
                            onChange={e => setIncludeDetail(e.target.checked)}
                        />
                        <span>Detalle por factura</span>
                    </label>
                    <p className="modal-hint">
                        {includeDetail
                            ? 'Cada factura aparece como fila individual con subtotales por cliente.'
                            : 'Solo totales por cliente, sin desglose de facturas.'}
                    </p>
                </div>

                {/* Preview */}
                <div className="export-preview">
                    {preview.vendors > 0
                        ? `${preview.invoices} facturas de ${preview.clients} clientes de ${preview.vendors} vendedor${preview.vendors > 1 ? 'es' : ''}`
                        : 'Seleccioná al menos un vendedor'}
                </div>

                {/* Action */}
                <button
                    className="export-btn-primary"
                    onClick={handleExport}
                    disabled={preview.vendors === 0}
                >
                    Generar PDF
                </button>
            </div>
        </div>,
        document.body
    );
};
