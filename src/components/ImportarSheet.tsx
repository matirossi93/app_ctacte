import { useState, useRef } from 'react';
import { X, Upload, Loader2, Check, AlertCircle, FileSpreadsheet } from 'lucide-react';
import { authHeaders } from '../utils/auth';
import './ImportarSheet.css';

interface Props { onClose: () => void; onImported?: () => void }

const MONTH_NAMES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

export const ImportarSheet = ({ onClose, onImported }: Props) => {
    const now = new Date();
    const [year, setYear] = useState(now.getUTCFullYear());
    const [month, setMonth] = useState(now.getUTCMonth() + 1);
    const [file, setFile] = useState<File | null>(null);
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const [result, setResult] = useState<{ rows_importadas: number; rows_descartadas: number; rows_leidas: number } | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    const submit = async () => {
        if (!file) { setErr('Subí un archivo XLSX primero'); return; }
        setSaving(true); setErr(null);
        try {
            const fd = new FormData();
            fd.append('file', file);
            fd.append('year', String(year));
            fd.append('month', String(month));
            const res = await fetch('/api/sheet-import/maestro-clientes', {
                method: 'POST',
                headers: { ...authHeaders() },
                body: fd,
            });
            const j = await res.json();
            if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
            setResult(j);
            // Disparar sync en background para refrescar vendor/client_sales_monthly.
            fetch('/api/goals/sync-now', { method: 'POST', headers: authHeaders() }).catch(() => { });
            onImported?.();
        } catch (e: any) { setErr(e.message); }
        finally { setSaving(false); }
    };

    const years = [now.getUTCFullYear(), now.getUTCFullYear() + 1, now.getUTCFullYear() - 1];

    return (
        <div className="is-backdrop" onClick={onClose}>
            <div className="is-modal" onClick={e => e.stopPropagation()}>
                <header>
                    <div className="is-head-l"><FileSpreadsheet size={18} /> <h3>Actualizar objetivos del mes</h3></div>
                    <button onClick={onClose} aria-label="Cerrar"><X size={18} /></button>
                </header>

                {result ? (
                    <div className="is-ok">
                        <Check size={40} />
                        <h4>Importación completada</h4>
                        <ul>
                            <li><strong>{result.rows_importadas}</strong> clientes actualizados</li>
                            <li><strong>{result.rows_descartadas}</strong> descartados (sin código)</li>
                            <li>Total filas leídas: {result.rows_leidas}</li>
                        </ul>
                        <p className="is-ok-hint">Los objetivos ya están cargados para <strong>{MONTH_NAMES[month - 1]} {year}</strong>. El avance del equipo se está recalculando en background.</p>
                        <button className="is-btn-primary" onClick={onClose}>Listo</button>
                    </div>
                ) : (
                    <>
                        <p className="is-intro">
                            Descargá el sheet <strong>Maestro Clientes</strong> → hoja <code>mes actual</code> como <code>.xlsx</code> y subilo acá. Los objetivos y metadata operativa se actualizan para el mes seleccionado.
                        </p>

                        <div className="is-row">
                            <label>
                                <span>Mes</span>
                                <select value={month} onChange={e => setMonth(Number(e.target.value))}>
                                    {MONTH_NAMES.map((n, i) => <option key={i} value={i + 1}>{n}</option>)}
                                </select>
                            </label>
                            <label>
                                <span>Año</span>
                                <select value={year} onChange={e => setYear(Number(e.target.value))}>
                                    {years.sort().map(y => <option key={y} value={y}>{y}</option>)}
                                </select>
                            </label>
                        </div>

                        <div className="is-file-wrap">
                            <input ref={inputRef} type="file" accept=".xlsx,.xls"
                                onChange={e => setFile(e.target.files?.[0] ?? null)}
                                style={{ display: 'none' }} />
                            <button className="is-file-btn" onClick={() => inputRef.current?.click()}>
                                <Upload size={16} />
                                {file ? file.name : 'Elegir archivo XLSX'}
                            </button>
                            {file && <button className="is-file-clear" onClick={() => { setFile(null); if (inputRef.current) inputRef.current.value = ''; }}>Quitar</button>}
                        </div>

                        {err && <div className="is-err"><AlertCircle size={14} /> {err}</div>}

                        <div className="is-actions">
                            <button className="is-btn-sec" onClick={onClose} disabled={saving}>Cancelar</button>
                            <button className="is-btn-primary" onClick={submit} disabled={saving || !file}>
                                {saving ? <><Loader2 size={14} className="spin" /> Importando…</> : <><Upload size={14} /> Importar</>}
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};
