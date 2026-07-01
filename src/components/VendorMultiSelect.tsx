import { useMemo, useState } from 'react';
import { Search, ChevronDown } from 'lucide-react';

interface Vendor { cod_vendedor: number; nombre: string; activo: boolean }

interface Props {
    vendedores: Vendor[];
    /** Cods seleccionados = qué vendedores se están mirando. Vacío o todos = "Todos". */
    selected: Set<number>;
    onChange: (next: Set<number>) => void;
    showInactivos: boolean;
    onToggleInactivos: (v: boolean) => void;
}

/**
 * Control único de vendedores (reemplaza el viejo dropdown + engranaje + checkbox
 * "Ver inactivos"). El padre (VendorShell) deriva de `selected`:
 *   - 1 tildado          → selectedVendor = ese (vista de UN vendedor puntual)
 *   - varios (no todos)  → cods = lista       (vista "Todos" filtrada)
 *   - todos / ninguno    → "Todos" sin filtro
 * "solo" en una fila = atajo para ver un único vendedor sin destildar a mano.
 */
export function VendorMultiSelect({ vendedores, selected, onChange, showInactivos, onToggleInactivos }: Props) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');

    const isAll = selected.size === 0 || (vendedores.length > 0 && vendedores.every(v => selected.has(v.cod_vendedor)));

    const label = useMemo(() => {
        if (isAll) return 'Todos los vendedores';
        if (selected.size === 1) {
            const only = vendedores.find(v => v.cod_vendedor === [...selected][0]);
            return only?.nombre ?? '1 vendedor';
        }
        return `${selected.size} vendedores`;
    }, [isAll, selected, vendedores]);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        return q ? vendedores.filter(v => v.nombre.toLowerCase().includes(q)) : vendedores;
    }, [vendedores, query]);

    const toggle = (cod: number) => {
        const next = new Set(selected);
        if (next.has(cod)) next.delete(cod); else next.add(cod);
        onChange(next);
    };
    const solo = (cod: number) => { onChange(new Set([cod])); setOpen(false); };
    const setAll = () => onChange(new Set(vendedores.map(v => v.cod_vendedor)));
    const setActivos = () => onChange(new Set(vendedores.filter(v => v.activo).map(v => v.cod_vendedor)));

    return (
        <span className="vs-vendor-ms">
            <button className="vs-vendor-select vs-vendor-ms-trigger"
                onClick={() => setOpen(o => !o)}
                title="Elegir vendedores" aria-haspopup="menu" aria-expanded={open}>
                <span className="vs-vendor-ms-label">{label}</span>
                <ChevronDown size={12} />
            </button>
            {open && (
                <>
                    <div className="vs-avatar-scrim" onClick={() => setOpen(false)} />
                    <div className="vs-vendores-menu" role="menu">
                        <div className="vs-vendores-menu-search">
                            <Search size={13} />
                            <input autoFocus value={query} onChange={e => setQuery(e.target.value)}
                                placeholder="Buscar vendedor…" />
                        </div>
                        <div className="vs-vendores-menu-quick">
                            <button type="button" onClick={setAll}>Todos</button>
                            <button type="button" onClick={setActivos}>Solo activos</button>
                        </div>
                        <div className="vs-vendores-menu-list">
                            {filtered.map(v => {
                                const on = selected.has(v.cod_vendedor);
                                const isSolo = selected.size === 1 && on;
                                return (
                                    <div key={v.cod_vendedor} className="vs-vendor-check">
                                        <label className="vs-vendor-check-main">
                                            <input type="checkbox" checked={on}
                                                onChange={() => toggle(v.cod_vendedor)} />
                                            <span>{v.nombre}{!v.activo && ' (inactivo)'}</span>
                                        </label>
                                        {!isSolo && (
                                            <button type="button" className="vs-vendor-solo"
                                                onClick={() => solo(v.cod_vendedor)}
                                                title={`Ver solo ${v.nombre}`}>solo</button>
                                        )}
                                    </div>
                                );
                            })}
                            {filtered.length === 0 && <div className="vs-vendores-empty">Sin resultados</div>}
                        </div>
                        <label className="vs-vendores-menu-inactivos" title="Incluir vendedores inactivos / históricos">
                            <input type="checkbox" checked={showInactivos}
                                onChange={e => onToggleInactivos(e.target.checked)} />
                            <span>Ver inactivos / históricos</span>
                        </label>
                    </div>
                </>
            )}
        </span>
    );
}
