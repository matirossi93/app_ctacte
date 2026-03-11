import { useState, useEffect, useMemo } from 'react';
import { Search } from 'lucide-react';
import { useData } from '../hooks/useData';
import { processInvoices } from '../utils/calculations';
import { SummaryCards } from './SummaryCards';
import { VendorList } from './VendorList';
import { ClientTable } from './ClientTable';
import { InterestControl } from './InterestControl';
import { TopDebtorsAlert } from './TopDebtorsAlert';
import { LayoutGrid, ListOrdered, Moon, Sun } from 'lucide-react';
import './Dashboard.css';

export const Dashboard = () => {
    const [interestRate, setInterestRate] = useState(0.10); // 10% default
    const [searchTerm, setSearchTerm] = useState('');
    const [locationFilter, setLocationFilter] = useState('TODAS');
    const [sortBy, setSortBy] = useState<'balance' | 'aging'>('aging');
    const [disabledVendorIds, setDisabledVendorIds] = useState<Set<string>>(new Set());
    const [activeTab, setActiveTab] = useState<'resumen' | 'clientes'>('resumen');
    
    // Check URL parameters for vendor isolation
    const urlParams = useMemo(() => new URLSearchParams(window.location.search), []);
    const isoVendor = urlParams.get('vendedor');
    const [activeVendorId, setActiveVendorId] = useState<string | null>(isoVendor || 'GLOBAL_VIEW');

    // Load client thresholds from localStorage
    const [clientThresholds, setClientThresholds] = useState<Record<string, number>>(() => {
        const saved = localStorage.getItem('clientInterestThresholds');
        return saved ? JSON.parse(saved) : {};
    });

    // Centralized invoice overrides state via API
    const [invoiceInterestOverrides, setInvoiceInterestOverrides] = useState<Record<string, boolean>>({});

    // Load initial overrides from the database API
    useEffect(() => {
        fetch('/api/overrides')
            .then(res => res.json())
            .then(data => {
                if (data && !data.error) {
                    setInvoiceInterestOverrides(data);
                }
            })
            .catch(err => console.error('Error fetching overrides:', err));
    }, []);

    // Theme Management
    const [theme, setTheme] = useState<'light' | 'dark'>(() => {
        if (typeof window !== 'undefined') {
            const savedTheme = localStorage.getItem('app_theme');
            if (savedTheme === 'light' || savedTheme === 'dark') return savedTheme;
            if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
        }
        return 'light';
    });

    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('app_theme', theme);
    }, [theme]);

    const toggleTheme = () => {
        setTheme(prev => prev === 'light' ? 'dark' : 'light');
    };

    const { rawInvoices, clientDbMap, loading, error } = useData();

    // Synchronously recalculate the mapped structure explicitly instead of fetching when variables change
    const rawData = useMemo(() => {
        if (!rawInvoices.length) return [];
        return processInvoices(rawInvoices, interestRate, clientThresholds, clientDbMap, invoiceInterestOverrides);
    }, [rawInvoices, interestRate, clientThresholds, clientDbMap, invoiceInterestOverrides]);

    // Set initially disabled vendors (Andrea and Sucursales) once data loads
    useEffect(() => {
        if (rawData.length > 0 && disabledVendorIds.size === 0) {
            const initialDisabled = new Set<string>();
            rawData.forEach(v => {
                const name = v.vendorName.toLowerCase();
                // If there's an isolated vendor, we disable all OTHERS inherently by not showing the vendor list
                if (name.includes('andrea') || name.includes('sucursal')) {
                    initialDisabled.add(v.vendorId);
                }
            });
            if (initialDisabled.size > 0) {
                setDisabledVendorIds(initialDisabled);
            }
        }
    }, [rawData]);

    // Save client thresholds to localStorage when they change
    useEffect(() => {
        localStorage.setItem('clientInterestThresholds', JSON.stringify(clientThresholds));
    }, [clientThresholds]);

    // Notice: We don't watch invoiceInterestOverrides to save to a database here.
    // That is handled immediately at the point of action (onToggleInvoiceInterest) to avoid 
    // sending bulk requests or reacting to the initial GET load.

    // Filter data based on disabled vendors
    const data = rawData.filter(v => !disabledVendorIds.has(v.vendorId));

    // If an isolated vendor is specified in the URL, filter data purely locally to that vendor name
    // (We match by vendorName instead of vendorId since ID might not be known to users sharing URLs)
    const viewData = useMemo(() => {
        if (!isoVendor) return data;
        const normalizedIso = isoVendor.trim().toLowerCase();
        return data.filter(v => v.vendorName.toLowerCase().includes(normalizedIso));
    }, [data, isoVendor]);

    // If isolated, try locking activeVendorId to the isolated vendor's ID once data processes
    useEffect(() => {
        if (isoVendor && viewData.length > 0 && activeVendorId === isoVendor) {
            // We successfully filtered it, let's set the activeVendorId to its actual ID
            setActiveVendorId(viewData[0].vendorId);
        }
    }, [viewData, isoVendor, activeVendorId]);

    // Calculate activeVendor early so hooks can depend on it
    const activeVendor = useMemo(() => {
        if (activeVendorId === 'GLOBAL_VIEW') {
            return null; // For GLOBAL_VIEW, we'll derive baseClients later
        }
        return viewData.find(v => v.vendorId === activeVendorId) || null;
    }, [activeVendorId, viewData]);
    
    // We need baseClients for the location dropdown, but we also define it later for sorting.
    // Let's compute a preliminary list just for the dropdown options to satisfy hook rules.
    const preBaseClients = activeVendor ? activeVendor.clients : viewData.flatMap(v => v.clients);

    // 2. Extract unique locations BEFORE filtering, so the dropdown always has options
    const uniqueLocations = useMemo(() => {
        const locations = new Set<string>();
        preBaseClients.forEach(c => {
            if (c.localidad) {
                // Cleanup text if necessary
                locations.add(c.localidad.trim());
            }
        });
        const arr = Array.from(locations).filter(Boolean).sort((a, b) => a.localeCompare(b));
        return ['TODAS', ...arr];
    }, [preBaseClients]);

    // Reset location option if the vendor changes (since locations might be different)
    useEffect(() => {
        setLocationFilter('TODAS');
    }, [activeVendor?.vendorId]);

    if (loading) {
        return (
            <div className="loading-state">
                <div className="spinner">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="12" y1="2" x2="12" y2="6"></line>
                        <line x1="12" y1="18" x2="12" y2="22"></line>
                        <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line>
                        <line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line>
                        <line x1="2" y1="12" x2="6" y2="12"></line>
                        <line x1="18" y1="12" x2="22" y2="12"></line>
                        <line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line>
                        <line x1="16.24" y1="4.93" x2="19.07" y2="7.76"></line>
                    </svg>
                </div>
                <h2>Sincronizando Facturas...</h2>
            </div>
        );
    }

    if (error) {
        return (
            <div className="empty-state glass">
                <div style={{ color: 'var(--color-danger)' }}>
                    <h2 style={{ marginBottom: '1rem' }}>Hubo un problema al cargar los datos</h2>
                    <p>{error.message}</p>
                </div>
            </div>
        );
    }

    // Consolidate clients for global view (merge duplicates if client has multiple vendors)
    const consolidatedClientsMap = new Map<string, any>();
    data.forEach(v => {
        v.clients.forEach(c => {
            if (!consolidatedClientsMap.has(c.clientId)) {
                consolidatedClientsMap.set(c.clientId, {
                    ...c,
                    invoices: [...c.invoices],
                    vendorName: v.vendorName // Initial vendor name
                });
            } else {
                const existing = consolidatedClientsMap.get(c.clientId)!;
                existing.totalBalance += c.totalBalance;
                existing.totalInterest += c.totalInterest;
                existing.totalWithInterest += c.totalWithInterest;
                existing.maxDaysOverdue = Math.max(existing.maxDaysOverdue, c.maxDaysOverdue);
                existing.invoices = [...existing.invoices, ...c.invoices];
                // If it belongs to multiple, we can mark it or just keep the first one
                existing.vendorName = 'Múltiples Vendedores';
            }
        });
    });

    const globalClients = Array.from(consolidatedClientsMap.values());
    globalClients.sort((a, b) => b.maxDaysOverdue - a.maxDaysOverdue);

    const globalVendor = {
        vendorId: 'GLOBAL_VIEW',
        vendorName: '🌍 VISUALIZACIÓN GLOBAL',
        totalBalance: viewData.reduce((acc, v) => acc + v.totalBalance, 0),
        totalInterest: viewData.reduce((acc, v) => acc + v.totalInterest, 0),
        totalWithInterest: viewData.reduce((acc, v) => acc + v.totalWithInterest, 0),
        clients: globalClients
    };

    const toggleVendor = (vendorId: string) => {
        setDisabledVendorIds(prev => {
            const next = new Set(prev);
            if (next.has(vendorId)) next.delete(vendorId);
            else next.add(vendorId);
            return next;
        });
    };

    // The sidebar needs to see ALL vendors to show them as "greyed out" instead of removing them.
    // However, the "GLOBAL_VIEW" totals should only reflect the ACTIVE (viewData) ones.
    const allVendorsSidebar = [globalVendor, ...rawData]; 
    // activeVendor is already computed above
    const finalActiveVendor = activeVendor || globalVendor;

    // 1. Determine Source of Clients
    let baseClients = finalActiveVendor.clients || [];
    let currentViewName = finalActiveVendor.vendorName || '';

    // 3. Apply location filter
    if (locationFilter !== 'TODAS') {
        baseClients = baseClients.filter(c => c.localidad?.trim() === locationFilter);
    }

    // 4. Override with search if active
    if (searchTerm.trim()) {
        baseClients = globalVendor.clients.filter(c =>
            c.clientName.toLowerCase().includes(searchTerm.toLowerCase()) ||
            c.clientId.toLowerCase().includes(searchTerm.toLowerCase())
        );
        currentViewName = `Resultados de búsqueda: "${searchTerm}"`;
    }

    // 5. Apply Multi-level Sorting
    const sortedClients = [...baseClients].sort((a, b) => {
        if (sortBy === 'aging') {
            // Priority 1: Oldest debt age
            if (b.maxDaysOverdue !== a.maxDaysOverdue) {
                return b.maxDaysOverdue - a.maxDaysOverdue;
            }
            // Priority 2: High balance as tie-breaker
            return b.totalBalance - a.totalBalance;
        } else {
            // Priority 1: Highest balance
            if (b.totalBalance !== a.totalBalance) {
                return b.totalBalance - a.totalBalance;
            }
            // Priority 2: Older debt as tie-breaker
            return b.maxDaysOverdue - a.maxDaysOverdue;
        }
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
            <header className="dashboard-header" style={{ borderBottom: '1px solid var(--color-border)', paddingBottom: '1.5rem', marginBottom: '2rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                        <img 
                            className="brand-logo mobile-brand-logo"
                            src="/logo_full.png" 
                            alt="Semillero El Manantial" 
                            style={{ 
                                height: '160px', 
                                objectFit: 'contain'
                            }}
                            onError={(e) => {
                                (e.target as HTMLImageElement).src = '/logo.png';
                            }}
                        />
                    </div>
                    <div className="mobile-hide" style={{ height: '50px', width: '2px', background: 'var(--color-border)' }}></div>
                    <div style={{ paddingLeft: '0.5rem' }}>
                        <h1 style={{ fontSize: '1.75rem', margin: '0 0 0.2rem 0', fontWeight: 800, color: 'var(--color-text)', letterSpacing: '-0.02em', lineHeight: 1.1 }}>Panel de Cobranzas</h1>
                        <span style={{ color: 'var(--color-primary)', fontSize: '0.9rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.9 }}>Gestión de Vendedores</span>
                    </div>
                </div>

                <div className="dashboard-controls">
                    <div className="search-bar glass">
                        <Search size={18} style={{ opacity: 0.5, marginRight: '0.5rem' }} />
                        <input
                            type="text"
                            placeholder="Buscar cliente o código..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="search-input"
                        />
                    </div>
                    <InterestControl
                        currentRate={interestRate}
                        onRateChange={setInterestRate}
                    />
                    <button 
                        onClick={toggleTheme} 
                        className="btn-icon" 
                        title="Alternar tema claro/oscuro"
                        style={{ padding: '0.5rem', borderRadius: '50%' }}
                    >
                        {theme === 'light' ? <Moon size={20} /> : <Sun size={20} />}
                    </button>
                </div>
            </header>

            {/* Mobile Navigation Tabs */}
            <div className="mobile-tabs glass desktop-hide">
                <button 
                    className={`tab-btn ${activeTab === 'resumen' ? 'active' : ''}`}
                    onClick={() => setActiveTab('resumen')}
                >
                    <LayoutGrid size={18} />
                    Resumen
                </button>
                <button 
                    className={`tab-btn ${activeTab === 'clientes' ? 'active' : ''}`}
                    onClick={() => setActiveTab('clientes')}
                >
                    <ListOrdered size={18} />
                    Mis Clientes
                </button>
            </div>

            <div className={`dashboard-section ${activeTab === 'resumen' ? 'show-mobile' : 'hide-mobile'}`}>
                {/* Dynamically pass only the active vendor (or global data if GLOBAL_VIEW) to Top Debtors */}
                {!isoVendor && <TopDebtorsAlert data={activeVendorId === 'GLOBAL_VIEW' ? viewData : (activeVendor ? [activeVendor] : [])} />}
                <SummaryCards data={viewData} />
            </div>

            <div className={`dashboard-section content-wrapper ${activeTab === 'clientes' ? 'show-mobile' : 'hide-mobile'}`}>
                <div className="content-grid-header mobile-filters-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '1rem', gap: '1rem', flexWrap: 'wrap' }}>
                    <h2 className="mobile-hide" style={{ fontSize: '1.25rem', color: 'var(--color-text)' }}>Detalle por Clientes</h2>
                    
                    {/* Mobile Vendor Select Dropdown */}
                    {!isoVendor && (
                        <div className="mobile-vendor-select glass desktop-hide" style={{ width: '100%', marginBottom: 0 }}>
                            <select 
                                value={activeVendorId || 'GLOBAL_VIEW'} 
                                onChange={(e) => setActiveVendorId(e.target.value)}
                            >
                                {allVendorsSidebar.filter(v => !disabledVendorIds.has(v.vendorId)).map(v => (
                                    <option key={v.vendorId} value={v.vendorId}>
                                        {v.vendorName} {v.vendorId !== 'GLOBAL_VIEW' && `(${v.clients.length})`}
                                    </option>
                                ))}
                            </select>
                        </div>
                    )}

                    <div className="sort-controls glass mobile-sort-row" style={{ display: 'flex', padding: '0.25rem', borderRadius: '0.5rem', flexWrap: 'wrap', gap: '0.25rem' }}>
                        <select
                            value={locationFilter}
                            onChange={(e) => setLocationFilter(e.target.value)}
                            className="sort-btn location-select"
                            title="Filtrar por Localidad"
                            style={{ outline: 'none', cursor: 'pointer', appearance: 'auto' }}
                        >
                            {uniqueLocations.map(loc => (
                                <option key={loc} value={loc}>
                                    {loc === 'TODAS' ? '📍 Localidad (Todas)' : loc}
                                </option>
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
                        onUpdateThreshold={(clientId, days) => {
                            setClientThresholds(prev => ({
                                ...prev,
                                [clientId]: days
                            }));
                        }}
                        invoiceInterestOverrides={invoiceInterestOverrides}
                        onToggleInvoiceInterest={(invoiceId, apply) => {
                            // Optimistic local UI update
                            setInvoiceInterestOverrides(prev => ({
                                ...prev,
                                [invoiceId]: apply
                            }));
                            // Background API update to sync across devices
                            fetch('/api/overrides', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
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
