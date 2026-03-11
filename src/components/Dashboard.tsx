import { useState, useEffect, useMemo, useCallback } from 'react';
import { Search, RefreshCw, Moon, Sun, LayoutGrid, ListOrdered, LogOut } from 'lucide-react';
import { useData } from '../hooks/useData';
import { processInvoices } from '../utils/calculations';
import { SummaryCards } from './SummaryCards';
import { VendorList } from './VendorList';
import { ClientTable } from './ClientTable';
import { InterestControl } from './InterestControl';
import { TopDebtorsAlert } from './TopDebtorsAlert';
import { AgingBars } from './AgingBars';
import { authHeaders, clearToken } from '../utils/auth';
import './Dashboard.css';

interface Props {
    onUnauthorized?: () => void;
}

export const Dashboard = ({ onUnauthorized }: Props) => {
    const [interestRate, setInterestRate] = useState(0.10);
    const [searchTerm, setSearchTerm] = useState('');
    const [locationFilter, setLocationFilter] = useState('TODAS');
    const [sortBy, setSortBy] = useState<'balance' | 'aging'>('aging');
    const [activeTab, setActiveTab] = useState<'resumen' | 'clientes'>('resumen');

    // URL vendor isolation
    const urlParams = useMemo(() => new URLSearchParams(window.location.search), []);
    const isoVendor = urlParams.get('vendedor');
    const [activeVendorId, setActiveVendorId] = useState<string | null>(isoVendor || 'GLOBAL_VIEW');

    // Theme
    const [theme, setTheme] = useState<'light' | 'dark'>(() => {
        const saved = localStorage.getItem('app_theme');
        if (saved === 'light' || saved === 'dark') return saved;
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    });

    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('app_theme', theme);
    }, [theme]);

    // Invoice overrides (persisted to SQLite via API)
    const [invoiceInterestOverrides, setInvoiceInterestOverrides] = useState<Record<string, boolean>>({});

    useEffect(() => {
        fetch('/api/overrides', { headers: authHeaders() })
            .then(res => {
                if (res.status === 401) { onUnauthorized?.(); return null; }
                return res.json();
            })
            .then(data => { if (data && !data.error) setInvoiceInterestOverrides(data); })
            .catch(err => console.error('Error fetching overrides:', err));
    }, []);

    // Client thresholds (persisted to SQLite via API, not localStorage)
    const [clientThresholds, setClientThresholds] = useState<Record<string, number>>({});

    useEffect(() => {
        fetch('/api/client-thresholds', { headers: authHeaders() })
            .then(res => {
                if (res.status === 401) { onUnauthorized?.(); return null; }
                return res.json();
            })
            .then(data => { if (data && !data.error) setClientThresholds(data); })
            .catch(err => console.error('Error fetching thresholds:', err));
    }, []);

    const onUpdateThreshold = useCallback((clientId: string, days: number) => {
        setClientThresholds(prev => ({ ...prev, [clientId]: days }));
        fetch('/api/client-thresholds', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ clientId, days })
        }).catch(err => console.error('Error saving threshold:', err));
    }, []);

    // Disabled vendors — persisted to localStorage
    const [defaultsApplied, setDefaultsApplied] = useState(
        () => localStorage.getItem('disabledVendorIds') !== null
    );
    const [disabledVendorIds, setDisabledVendorIds] = useState<Set<string>>(() => {
        const saved = localStorage.getItem('disabledVendorIds');
        return saved ? new Set(JSON.parse(saved)) : new Set();
    });

    useEffect(() => {
        localStorage.setItem('disabledVendorIds', JSON.stringify([...disabledVendorIds]));
    }, [disabledVendorIds]);

    const { rawInvoices, clientDbMap, loading, error, lastRefreshed, refresh } = useData(onUnauthorized);

    // Apply default disabled vendors on first load (Andrea & Sucursales)
    const rawData = useMemo(() => {
        if (!rawInvoices.length) return [];
        return processInvoices(rawInvoices, interestRate, clientThresholds, clientDbMap, invoiceInterestOverrides);
    }, [rawInvoices, interestRate, clientThresholds, clientDbMap, invoiceInterestOverrides]);

    useEffect(() => {
        if (rawData.length > 0 && !defaultsApplied) {
            setDefaultsApplied(true);
            const initialDisabled = new Set<string>();
            rawData.forEach(v => {
                const name = v.vendorName.toLowerCase();
                if (name.includes('andrea') || name.includes('sucursal')) {
                    initialDisabled.add(v.vendorId);
                }
            });
            if (initialDisabled.size > 0) setDisabledVendorIds(initialDisabled);
        }
    }, [rawData, defaultsApplied]);

    const toggleVendor = (vendorId: string) => {
        setDisabledVendorIds(prev => {
            const next = new Set(prev);
            if (next.has(vendorId)) next.delete(vendorId); else next.add(vendorId);
            return next;
        });
    };

    const data = rawData.filter(v => !disabledVendorIds.has(v.vendorId));

    const viewData = useMemo(() => {
        if (!isoVendor) return data;
        const normalizedIso = isoVendor.trim().toLowerCase();
        return data.filter(v => v.vendorName.toLowerCase().includes(normalizedIso));
    }, [data, isoVendor]);

    useEffect(() => {
        if (isoVendor && viewData.length > 0 && activeVendorId === isoVendor) {
            setActiveVendorId(viewData[0].vendorId);
        }
    }, [viewData, isoVendor, activeVendorId]);

    const activeVendor = useMemo(() => {
        if (activeVendorId === 'GLOBAL_VIEW') return null;
        return viewData.find(v => v.vendorId === activeVendorId) || null;
    }, [activeVendorId, viewData]);

    const preBaseClients = activeVendor ? activeVendor.clients : viewData.flatMap(v => v.clients);

    const uniqueLocations = useMemo(() => {
        const locations = new Set<string>();
        preBaseClients.forEach(c => { if (c.localidad) locations.add(c.localidad.trim()); });
        return ['TODAS', ...Array.from(locations).filter(Boolean).sort((a, b) => a.localeCompare(b))];
    }, [preBaseClients]);

    useEffect(() => { setLocationFilter('TODAS'); }, [activeVendor?.vendorId]);

    const formatTime = (d: Date) =>
        d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });

    if (loading && !rawInvoices.length) {
        return (
            <div className="loading-state">
                <div className="spinner">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="12" y1="2" x2="12" y2="6" /><line x1="12" y1="18" x2="12" y2="22" />
                        <line x1="4.93" y1="4.93" x2="7.76" y2="7.76" /><line x1="16.24" y1="16.24" x2="19.07" y2="19.07" />
                        <line x1="2" y1="12" x2="6" y2="12" /><line x1="18" y1="12" x2="22" y2="12" />
                        <line x1="4.93" y1="19.07" x2="7.76" y2="16.24" /><line x1="16.24" y1="4.93" x2="19.07" y2="7.76" />
                    </svg>
                </div>
                <h2>Sincronizando Facturas...</h2>
            </div>
        );
    }

    if (error) {
        return (
            <div className="empty-state glass" style={{ margin: '2rem' }}>
                <div style={{ color: 'var(--color-danger)' }}>
                    <h2 style={{ marginBottom: '1rem' }}>Error al cargar los datos</h2>
                    <p style={{ marginBottom: '1.5rem' }}>{error.message}</p>
                    <button className="btn-primary" onClick={refresh}>Reintentar</button>
                </div>
            </div>
        );
    }

    // Build global view
    const consolidatedClientsMap = new Map<string, any>();
    data.forEach(v => {
        v.clients.forEach(c => {
            if (!consolidatedClientsMap.has(c.clientId)) {
                consolidatedClientsMap.set(c.clientId, { ...c, invoices: [...c.invoices], vendorName: v.vendorName });
            } else {
                const ex = consolidatedClientsMap.get(c.clientId)!;
                ex.totalBalance += c.totalBalance;
                ex.totalInterest += c.totalInterest;
                ex.totalWithInterest += c.totalWithInterest;
                ex.maxDaysOverdue = Math.max(ex.maxDaysOverdue, c.maxDaysOverdue);
                ex.invoices = [...ex.invoices, ...c.invoices];
                ex.vendorName = 'Múltiples Vendedores';
            }
        });
    });

    const globalClients = Array.from(consolidatedClientsMap.values())
        .sort((a, b) => b.maxDaysOverdue - a.maxDaysOverdue);

    const globalVendor = {
        vendorId: 'GLOBAL_VIEW',
        vendorName: '🌍 VISUALIZACIÓN GLOBAL',
        totalBalance: viewData.reduce((acc, v) => acc + v.totalBalance, 0),
        totalInterest: viewData.reduce((acc, v) => acc + v.totalInterest, 0),
        totalWithInterest: viewData.reduce((acc, v) => acc + v.totalWithInterest, 0),
        clients: globalClients
    };

    const allVendorsSidebar = [globalVendor, ...rawData];
    const finalActiveVendor = activeVendor || globalVendor;

    let baseClients = finalActiveVendor.clients || [];
    let currentViewName = finalActiveVendor.vendorName || '';

    if (locationFilter !== 'TODAS') {
        baseClients = baseClients.filter(c => c.localidad?.trim() === locationFilter);
    }

    if (searchTerm.trim()) {
        baseClients = globalVendor.clients.filter(c =>
            c.clientName.toLowerCase().includes(searchTerm.toLowerCase()) ||
            c.clientId.toLowerCase().includes(searchTerm.toLowerCase())
        );
        currentViewName = `Resultados: "${searchTerm}"`;
    }

    const sortedClients = [...baseClients].sort((a, b) => {
        if (sortBy === 'aging') {
            return b.maxDaysOverdue !== a.maxDaysOverdue
                ? b.maxDaysOverdue - a.maxDaysOverdue
                : b.totalBalance - a.totalBalance;
        }
        return b.totalBalance !== a.totalBalance
            ? b.totalBalance - a.totalBalance
            : b.maxDaysOverdue - a.maxDaysOverdue;
    });

    const displayedVendor = {
        vendorId: searchTerm.trim() ? 'SEARCH_RESULTS' : (finalActiveVendor.vendorId || 'NONE'),
        vendorName: currentViewName,
        totalBalance: finalActiveVendor.totalBalance || 0,
        totalInterest: finalActiveVendor.totalInterest || 0,
        totalWithInterest: finalActiveVendor.totalWithInterest || 0,
        clients: sortedClients
    };

    return (
        <div className="dashboard-layout">
            {/* ── Header ── */}
            <header className="dashboard-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
                    <img
                        className="brand-logo mobile-brand-logo"
                        src="/logo_full.png"
                        alt="Semillero El Manantial"
                        style={{ height: '160px', objectFit: 'contain' }}
                        onError={e => { (e.target as HTMLImageElement).src = '/logo.png'; }}
                    />
                    <div className="mobile-hide" style={{ height: '50px', width: '2px', background: 'var(--color-border)' }} />
                    <div style={{ paddingLeft: '0.5rem' }}>
                        <h1 style={{ fontSize: '1.75rem', margin: '0 0 0.2rem 0', fontWeight: 800, color: 'var(--color-text)', letterSpacing: '-0.02em', lineHeight: 1.1 }}>
                            Panel de Cobranzas
                        </h1>
                        <span style={{ color: 'var(--color-primary)', fontSize: '0.9rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.9 }}>
                            Gestión de Vendedores
                        </span>
                    </div>
                </div>

                <div className="dashboard-controls">
                    {/* Last refresh + Refresh button */}
                    <div className="refresh-group">
                        {lastRefreshed && (
                            <span className="last-refresh-label">
                                {formatTime(lastRefreshed)}
                            </span>
                        )}
                        <button
                            className="btn-icon refresh-btn"
                            onClick={refresh}
                            disabled={loading}
                            title="Actualizar datos"
                        >
                            <RefreshCw size={17} className={loading ? 'spinner' : ''} />
                        </button>
                    </div>

                    <div className="search-bar glass">
                        <Search size={18} style={{ opacity: 0.5, marginRight: '0.5rem' }} />
                        <input
                            type="text"
                            placeholder="Buscar cliente o código..."
                            value={searchTerm}
                            onChange={e => setSearchTerm(e.target.value)}
                            className="search-input"
                        />
                    </div>

                    <InterestControl currentRate={interestRate} onRateChange={setInterestRate} />

                    <button
                        onClick={() => setTheme(t => t === 'light' ? 'dark' : 'light')}
                        className="btn-icon"
                        title="Alternar tema"
                        style={{ padding: '0.5rem', borderRadius: '50%' }}
                    >
                        {theme === 'light' ? <Moon size={20} /> : <Sun size={20} />}
                    </button>

                    <button
                        onClick={() => { clearToken(); onUnauthorized?.(); }}
                        className="btn-icon"
                        title="Cerrar sesión"
                        style={{ padding: '0.5rem', borderRadius: '50%', color: 'var(--color-danger)' }}
                    >
                        <LogOut size={20} />
                    </button>
                </div>
            </header>

            {/* ── Mobile Tabs ── */}
            <div className="mobile-tabs glass desktop-hide">
                <button className={`tab-btn ${activeTab === 'resumen' ? 'active' : ''}`} onClick={() => setActiveTab('resumen')}>
                    <LayoutGrid size={18} /> Resumen
                </button>
                <button className={`tab-btn ${activeTab === 'clientes' ? 'active' : ''}`} onClick={() => setActiveTab('clientes')}>
                    <ListOrdered size={18} /> Mis Clientes
                </button>
            </div>

            {/* ── Resumen section ── */}
            <div className={`dashboard-section ${activeTab === 'resumen' ? 'show-mobile' : 'hide-mobile'}`}>
                {!isoVendor && (
                    <TopDebtorsAlert data={activeVendorId === 'GLOBAL_VIEW' ? viewData : (activeVendor ? [activeVendor] : [])} />
                )}
                <SummaryCards data={viewData} />
                <AgingBars data={viewData} />
            </div>

            {/* ── Clients section ── */}
            <div className={`dashboard-section content-wrapper ${activeTab === 'clientes' ? 'show-mobile' : 'hide-mobile'}`}>
                <div className="content-grid-header mobile-filters-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '1rem', gap: '1rem', flexWrap: 'wrap' }}>
                    <h2 className="mobile-hide" style={{ fontSize: '1.25rem', color: 'var(--color-text)' }}>Detalle por Clientes</h2>

                    {!isoVendor && (
                        <div className="mobile-vendor-select glass desktop-hide" style={{ width: '100%', marginBottom: 0 }}>
                            <select
                                value={activeVendorId || 'GLOBAL_VIEW'}
                                onChange={e => setActiveVendorId(e.target.value)}
                            >
                                {allVendorsSidebar.filter(v => !disabledVendorIds.has(v.vendorId)).map(v => (
                                    <option key={v.vendorId} value={v.vendorId}>
                                        {v.vendorName}{v.vendorId !== 'GLOBAL_VIEW' ? ` (${v.clients.length})` : ''}
                                    </option>
                                ))}
                            </select>
                        </div>
                    )}

                    <div className="sort-controls glass mobile-sort-row" style={{ display: 'flex', padding: '0.25rem', borderRadius: '0.5rem', flexWrap: 'wrap', gap: '0.25rem' }}>
                        <select
                            value={locationFilter}
                            onChange={e => setLocationFilter(e.target.value)}
                            className="sort-btn location-select"
                            style={{ outline: 'none', cursor: 'pointer', appearance: 'auto' }}
                        >
                            {uniqueLocations.map(loc => (
                                <option key={loc} value={loc}>{loc === 'TODAS' ? '📍 Localidad (Todas)' : loc}</option>
                            ))}
                        </select>
                        <button
                            onClick={() => setSortBy('balance')}
                            className={`sort-btn ${sortBy === 'balance' ? 'active' : ''}`}
                            title="Ordenar por mayor saldo"
                        >
                            <LayoutGrid size={16} /> Saldo
                        </button>
                        <button
                            onClick={() => setSortBy('aging')}
                            className={`sort-btn ${sortBy === 'aging' ? 'active' : ''}`}
                            title="Ordenar por más antiguo"
                        >
                            <ListOrdered size={16} /> Antigüedad
                        </button>
                    </div>
                </div>

                <div className={`content-grid ${isoVendor ? 'isolated-view' : ''}`}>
                    {!isoVendor && (
                        <aside className="mobile-hide">
                            <VendorList
                                vendors={allVendorsSidebar}
                                activeVendorId={activeVendorId}
                                onSelectVendor={setActiveVendorId}
                                disabledVendorIds={disabledVendorIds}
                                onToggleVendor={toggleVendor}
                            />
                        </aside>
                    )}
                    <main style={{ gridColumn: isoVendor ? '1 / -1' : undefined }}>
                        <ClientTable
                            vendor={displayedVendor}
                            clientThresholds={clientThresholds}
                            onUpdateThreshold={onUpdateThreshold}
                            invoiceInterestOverrides={invoiceInterestOverrides}
                            onToggleInvoiceInterest={(invoiceId, apply) => {
                                setInvoiceInterestOverrides(prev => ({ ...prev, [invoiceId]: apply }));
                                fetch('/api/overrides', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json', ...authHeaders() },
                                    body: JSON.stringify({ invoiceId, apply })
                                }).catch(err => console.error('Error saving override:', err));
                            }}
                        />
                    </main>
                </div>
            </div>
        </div>
    );
};
