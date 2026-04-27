import { useEffect, useMemo, useState, useRef } from 'react';
import { X, Camera, Upload, Check, AlertCircle, ChevronLeft, Loader2, Search, Clock, FileText, RefreshCw } from 'lucide-react';
import { authHeaders, getUser } from '../utils/auth';
import { MEDIOS_PAGO_UI, DEFAULT_MEDIO_UI, normalizeMedioUI } from '../utils/mediosPago';
import './RecibosApp.css';

interface Props {
    onClose: () => void;
    clients?: Array<{ cod: string; name: string; localidad?: string }>; // opcional: para selector
}

interface MPCandidate {
    cuenta: 'principal' | 'recaudadora_1' | 'recaudadora_2';
    payment_id: string;
    date_approved: string;
    amount: number;
    status: string;
    payer_email?: string;
    description?: string;
}

interface ReciboRow {
    id: string;
    cod_cliente: number;
    cod_vendedor: number;
    monto: number | null;
    fecha_comprobante: string | null;
    medio_pago: string | null;
    banco_origen: string | null;
    referencia: string | null;
    observaciones: string | null;
    foto_url: string;
    foto_signed_url: string | null;
    ocr_raw: any;
    ocr_confidence: number | null;
    status: 'pendiente_revision' | 'aprobado' | 'imputado' | 'rechazado' | 'error';
    factura_asociada: string | null;
    cod_empresa: number | null;
    infomanager_recibo_id: string | null;
    motivo_rechazo: string | null;
    error_msg: string | null;
    created_at: string;
    reviewed_at: string | null;
    imputado_at: string | null;
    // MP verification
    mp_status?: 'pending' | 'verified' | 'not_found' | 'ambiguous' | 'skipped' | 'error' | null;
    mp_payment_id?: string | null;
    mp_cuenta?: 'principal' | 'recaudadora_1' | 'recaudadora_2' | null;
    mp_verified_at?: string | null;
    mp_lookup_attempts?: number | null;
    mp_candidates?: MPCandidate[] | null;
}

interface FacturaCandidata {
    id: number | string;
    tipo_comprobante: string;
    punto_de_venta: number | string;
    numero: number | string;
    fecha_factura?: string;
    importe_factura?: number;
    importe_pagado?: number;
    saldo?: number;
    dias_deuda?: number;
    detalle?: string;
}

export const RecibosApp = ({ onClose, clients = [] }: Props) => {
    const user = getUser();
    const isBackoffice = user?.rol === 'admin' || user?.rol === 'gerente';
    const [view, setView] = useState<'list' | 'upload' | 'detail'>(isBackoffice ? 'list' : 'upload');
    const [selectedId, setSelectedId] = useState<string | null>(null);

    // Maestro completo: incluye clientes sin saldo (p.ej. adelantos de dinero).
    // El `clients` prop viene filtrado por saldo > 1000 desde VendorShell, así que
    // acá pedimos la lista completa al backend y dejamos el prop como fallback.
    const [fullClients, setFullClients] = useState<Array<{ cod: string; name: string; localidad?: string }>>([]);
    useEffect(() => {
        let alive = true;
        fetch('/api/clientes/lookup', { headers: authHeaders() })
            .then(r => r.json())
            .then(j => { if (alive && j.ok && Array.isArray(j.items)) setFullClients(j.items); })
            .catch(() => { /* silencioso: si falla, usamos el prop clients */ });
        return () => { alive = false; };
    }, []);

    // Merge: maestro + clientes con deuda. Maestro pisa por si trae razón social más actual.
    const mergedClients = useMemo(() => {
        const m = new Map<string, { cod: string; name: string; localidad?: string }>();
        clients.forEach(c => m.set(String(c.cod), c));
        fullClients.forEach(c => m.set(String(c.cod), c));
        return Array.from(m.values()).sort((a, b) => a.name.localeCompare(b.name, 'es'));
    }, [clients, fullClients]);

    // Lookup rápido por cod_cliente para mostrar nombre en lista/detalle
    const clientNameByCod = useMemo(() => {
        const m = new Map<string, string>();
        mergedClients.forEach(c => m.set(String(c.cod), c.name));
        return m;
    }, [mergedClients]);

    return (
        <div className="recibos-overlay" role="dialog" aria-modal="true">
            <div className="recibos-modal">
                <header className="recibos-header">
                    <button className="recibos-icon-btn" onClick={onClose} aria-label="Cerrar">
                        <X size={20} />
                    </button>
                    <h2>
                        {view === 'list' && (isBackoffice ? 'Recibos pendientes' : 'Mis comprobantes')}
                        {view === 'upload' && 'Cargar comprobante'}
                        {view === 'detail' && 'Revisar recibo'}
                    </h2>
                    <div className="recibos-header-actions">
                        {view === 'list' && (
                            <button className="btn-primary" onClick={() => setView('upload')}>
                                <Camera size={16} /> Cargar nuevo
                            </button>
                        )}
                    </div>
                </header>

                <div className="recibos-body">
                    {view === 'list' && (
                        <RecibosList
                            isBackoffice={!!isBackoffice}
                            clientNameByCod={clientNameByCod}
                            onOpenDetail={(id) => { setSelectedId(id); setView('detail'); }}
                            onUpload={() => setView('upload')}
                        />
                    )}
                    {view === 'upload' && (
                        <UploadRecibo
                            clients={mergedClients}
                            defaultCodVendedor={user?.cod_vendedor ?? null}
                            onDone={() => setView(isBackoffice ? 'list' : 'list')}
                            onCancel={() => setView('list')}
                        />
                    )}
                    {view === 'detail' && selectedId && (
                        <DetalleRecibo
                            id={selectedId}
                            isBackoffice={!!isBackoffice}
                            clientNameByCod={clientNameByCod}
                            onBack={() => { setSelectedId(null); setView('list'); }}
                        />
                    )}
                </div>
            </div>
        </div>
    );
};

// ───────────────────────────────────────────────────────────────────────────
// LIST
// ───────────────────────────────────────────────────────────────────────────
function RecibosList({ isBackoffice, clientNameByCod, onOpenDetail, onUpload }: { isBackoffice: boolean; clientNameByCod: Map<string, string>; onOpenDetail: (id: string) => void; onUpload: () => void }) {
    const [items, setItems] = useState<ReciboRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState<'pendiente_revision' | 'todos' | 'imputado' | 'rechazado'>(isBackoffice ? 'pendiente_revision' : 'todos');
    const [err, setErr] = useState<string | null>(null);

    const load = async () => {
        setLoading(true); setErr(null);
        try {
            const q = filter === 'todos' ? '' : `?status=${filter}`;
            const res = await fetch(`/api/recibos${q}`, { headers: authHeaders() });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            setItems(data.recibos || []);
        } catch (e: any) { setErr(e.message); }
        finally { setLoading(false); }
    };
    useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filter]);

    return (
        <div className="rec-list">
            <div className="rec-filter-bar">
                {(isBackoffice
                    ? ['pendiente_revision', 'imputado', 'rechazado', 'todos']
                    : ['todos', 'pendiente_revision', 'imputado', 'rechazado']
                ).map(f => (
                    <button key={f}
                        className={`rec-chip ${filter === f ? 'is-active' : ''}`}
                        onClick={() => setFilter(f as any)}>
                        {statusLabel(f as any)}
                    </button>
                ))}
                <button className="rec-chip" onClick={load} title="Refrescar"><RefreshCw size={14} /></button>
            </div>

            {loading && <div className="rec-loading"><Loader2 size={16} className="spin" /> Cargando…</div>}
            {err && <div className="rec-error"><AlertCircle size={16} /> {err}</div>}

            {!loading && items.length === 0 && (
                <div className="rec-empty">
                    <FileText size={32} />
                    <p>Sin comprobantes {filter !== 'todos' ? `en estado "${statusLabel(filter)}"` : 'cargados'}.</p>
                    {!isBackoffice && <button className="btn-primary" onClick={onUpload}>Cargar el primero</button>}
                </div>
            )}

            <ul className="rec-items">
                {items.map(r => (
                    <li key={r.id} className="rec-item" onClick={() => onOpenDetail(r.id)}>
                        <div className="rec-item-thumb">
                            {r.foto_signed_url && r.foto_url.toLowerCase().endsWith('.pdf') ? (
                                <div className="rec-pdf-placeholder"><FileText size={22} /></div>
                            ) : r.foto_signed_url ? (
                                <img src={r.foto_signed_url} alt="comprobante" loading="lazy" />
                            ) : <div className="rec-pdf-placeholder"><FileText size={22} /></div>}
                        </div>
                        <div className="rec-item-body">
                            <div className="rec-item-row1">
                                <strong>
                                    {clientNameByCod.get(String(r.cod_cliente)) ?? `Cliente ${r.cod_cliente}`}
                                    <span className="rec-cod"> #{r.cod_cliente}</span>
                                </strong>
                                <span className={`rec-status rec-status--${r.status}`}>{statusLabel(r.status)}</span>
                            </div>
                            <div className="rec-item-row2">
                                <span className="rec-amount">{formatMoney(r.monto)}</span>
                                <span className="rec-meta">{r.fecha_comprobante ?? '—'} · {r.medio_pago ?? 'sin medio'}</span>
                            </div>
                            <div className="rec-item-row3">
                                <Clock size={11} />
                                <span>{timeAgo(r.created_at)}</span>
                                {r.ocr_confidence != null && <span className="rec-ocr-badge">OCR {Math.round(r.ocr_confidence * 100)}%</span>}
                            </div>
                        </div>
                    </li>
                ))}
            </ul>
        </div>
    );
}

// ───────────────────────────────────────────────────────────────────────────
// UPLOAD
// ───────────────────────────────────────────────────────────────────────────
function UploadRecibo({ clients, defaultCodVendedor, onDone, onCancel }:
    { clients: Array<{ cod: string; name: string; localidad?: string }>; defaultCodVendedor: number | null; onDone: () => void; onCancel: () => void }) {
    const fileRef = useRef<HTMLInputElement>(null);
    const [file, setFile] = useState<File | null>(null);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [codCliente, setCodCliente] = useState('');
    const [codVendedor, setCodVendedor] = useState(defaultCodVendedor?.toString() ?? '');
    const [monto, setMonto] = useState('');
    const [fecha, setFecha] = useState<string>(new Date().toISOString().slice(0, 10));
    const [medioPago, setMedioPago] = useState<string>(DEFAULT_MEDIO_UI);
    const [observaciones, setObservaciones] = useState('');
    const [clientSearch, setClientSearch] = useState('');
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
    const [ocrResult, setOcrResult] = useState<any>(null);

    const filteredClients = useMemo(() => {
        if (!clientSearch.trim()) return clients.slice(0, 30);
        const q = clientSearch.toLowerCase();
        return clients.filter(c =>
            c.name.toLowerCase().includes(q) ||
            c.cod.includes(q) ||
            (c.localidad ?? '').toLowerCase().includes(q)
        ).slice(0, 30);
    }, [clients, clientSearch]);

    const onPickFile = (f: File | null) => {
        if (!f) return;
        setFile(f);
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        setPreviewUrl(URL.createObjectURL(f));
    };

    // Sanitiza lo que el user escribe en el campo monto: saca "$", letras, espacios,
    // acepta "," o "." como decimal (AR usa coma, pero aceptamos ambos).
    const cleanMonto = (raw: string): string => {
        let v = raw.replace(/[^\d.,]/g, '');
        // Si tiene "." y "," (formato AR típico "1.500,50"): "." son miles, "," decimal.
        if (v.includes('.') && v.includes(',')) {
            v = v.replace(/\./g, '').replace(',', '.');
        } else if (v.includes(',')) {
            v = v.replace(',', '.');
        }
        // Dejar un solo punto decimal
        const parts = v.split('.');
        if (parts.length > 2) v = parts[0] + '.' + parts.slice(1).join('');
        return v;
    };

    const submit = async () => {
        if (!file) { setMsg({ kind: 'err', text: 'Falta la foto del comprobante' }); return; }
        if (!codCliente) { setMsg({ kind: 'err', text: 'Elegí el cliente' }); return; }
        const montoNum = Number(monto);
        if (!monto || !isFinite(montoNum) || montoNum <= 0) { setMsg({ kind: 'err', text: 'Ingresá el monto del pago' }); return; }
        setBusy(true); setMsg(null);
        try {
            const fd = new FormData();
            fd.append('foto', file);
            fd.append('cod_cliente', codCliente);
            if (codVendedor) fd.append('cod_vendedor', codVendedor);
            if (monto) fd.append('monto', monto);
            if (fecha) fd.append('fecha_comprobante', fecha);
            if (medioPago) fd.append('medio_pago', medioPago);
            if (observaciones) fd.append('observaciones', observaciones);
            const res = await fetch('/api/recibos/upload', {
                method: 'POST',
                headers: authHeaders(), // NO Content-Type: lo setea el browser con boundary
                body: fd
            });
            const data = await res.json();
            if (!res.ok || !data.ok) {
                setMsg({ kind: 'err', text: data.error || `HTTP ${res.status}` });
                return;
            }
            setOcrResult(data.ocr);
            setMsg({ kind: 'ok', text: 'Comprobante enviado. Queda pendiente de revisión.' });
            // Prellenar con OCR si el user no cargó monto
            if (data.ocr?.monto && !monto) setMonto(String(data.ocr.monto));
            if (data.ocr?.fecha && !fecha) setFecha(data.ocr.fecha);
            setTimeout(() => { onDone(); }, 1500);
        } catch (e: any) {
            setMsg({ kind: 'err', text: e.message });
        } finally { setBusy(false); }
    };

    return (
        <div className="rec-upload">
            <div className="rec-upload-col rec-upload-photo">
                {previewUrl ? (
                    file?.type === 'application/pdf'
                        ? <div className="rec-pdf-big"><FileText size={64} /><span>{file.name}</span></div>
                        : <img src={previewUrl} alt="preview" />
                ) : (
                    <div className="rec-upload-empty">
                        <Camera size={48} />
                        <p>Tomá una foto del comprobante o subí un archivo</p>
                    </div>
                )}
                <div className="rec-upload-actions">
                    <input
                        ref={fileRef}
                        type="file"
                        accept="image/*,application/pdf"
                        style={{ display: 'none' }}
                        onChange={e => onPickFile(e.target.files?.[0] ?? null)}
                    />
                    <button className="btn-secondary" onClick={() => fileRef.current?.click()}>
                        <Camera size={16} /> {file ? 'Cambiar foto' : 'Tomar foto / subir'}
                    </button>
                </div>
            </div>

            <div className="rec-upload-col rec-upload-form">
                <label className="rec-field">
                    <span>Cliente *</span>
                    <div className="rec-client-picker">
                        <div className="rec-client-search">
                            <Search size={14} />
                            <input
                                type="text"
                                value={clientSearch}
                                onChange={e => setClientSearch(e.target.value)}
                                placeholder="Buscá por nombre, código o localidad…"
                            />
                        </div>
                        <div className="rec-client-list">
                            {filteredClients.length === 0 && (
                                <div className="rec-client-empty">Sin coincidencias. Cargá el código directo abajo.</div>
                            )}
                            {filteredClients.map(c => (
                                <button
                                    key={c.cod}
                                    type="button"
                                    className={`rec-client-option ${codCliente === c.cod ? 'is-active' : ''}`}
                                    onClick={() => setCodCliente(c.cod)}>
                                    <strong>{c.name}</strong>
                                    <span>Cod {c.cod}{c.localidad ? ` · ${c.localidad}` : ''}</span>
                                </button>
                            ))}
                        </div>
                        <input
                            type="number"
                            className="rec-cod-input"
                            placeholder="o código manual"
                            value={codCliente}
                            onChange={e => setCodCliente(e.target.value)}
                        />
                    </div>
                </label>

                <div className="rec-row">
                    <label className="rec-field">
                        <span>Monto *</span>
                        <input
                            type="text"
                            inputMode="decimal"
                            placeholder="0,00"
                            value={monto}
                            onChange={e => setMonto(cleanMonto(e.target.value))}
                        />
                    </label>
                    <label className="rec-field">
                        <span>Fecha</span>
                        <input type="date" value={fecha} onChange={e => setFecha(e.target.value)} />
                    </label>
                </div>

                <div className="rec-row">
                    <label className="rec-field">
                        <span>Medio</span>
                        <select value={medioPago} onChange={e => setMedioPago(e.target.value)}>
                            {MEDIOS_PAGO_UI.map(m => (
                                <option key={m.value} value={m.value}>{m.label}</option>
                            ))}
                        </select>
                    </label>
                    {defaultCodVendedor == null && (
                        <label className="rec-field">
                            <span>Cod vendedor</span>
                            <input type="number" value={codVendedor} onChange={e => setCodVendedor(e.target.value)} />
                        </label>
                    )}
                </div>

                <label className="rec-field">
                    <span>Observaciones</span>
                    <textarea rows={2} value={observaciones} onChange={e => setObservaciones(e.target.value)} placeholder="Ej: cliente pidió imputar a FA 142847" />
                </label>

                {ocrResult && (
                    <div className="rec-ocr-box">
                        <strong>OCR detectó:</strong>
                        <ul>
                            {ocrResult.monto != null && <li>Monto: ${ocrResult.monto}</li>}
                            {ocrResult.fecha && <li>Fecha: {ocrResult.fecha}</li>}
                            {ocrResult.banco_origen && <li>Banco origen: {ocrResult.banco_origen}</li>}
                            {ocrResult.referencia && <li>Ref: {ocrResult.referencia}</li>}
                            <li>Confianza: {Math.round((ocrResult.confidence ?? 0) * 100)}%</li>
                        </ul>
                    </div>
                )}

                {msg && (
                    <div className={`rec-msg rec-msg--${msg.kind}`}>
                        {msg.kind === 'ok' ? <Check size={16} /> : <AlertCircle size={16} />}
                        <span>{msg.text}</span>
                    </div>
                )}

                <div className="rec-form-actions">
                    <button className="btn-secondary" onClick={onCancel} disabled={busy}>Cancelar</button>
                    <button className="btn-primary" onClick={submit}
                        disabled={busy || !file || !codCliente || !monto || !(Number(monto) > 0)}
                        title={!monto ? 'Cargá el monto del comprobante' : undefined}>
                        {busy ? <><Loader2 size={16} className="spin" /> Enviando…</> : <><Upload size={16} /> Enviar comprobante</>}
                    </button>
                </div>
            </div>
        </div>
    );
}

// ───────────────────────────────────────────────────────────────────────────
// DETAIL + APPROVAL (backoffice)
// ───────────────────────────────────────────────────────────────────────────
function cuentaLabel(c: string | null | undefined): string {
    if (c === 'principal') return 'MP Principal';
    if (c === 'recaudadora_1') return 'MP Recaudadora 1';
    if (c === 'recaudadora_2') return 'MP Recaudadora 2';
    return c ?? '?';
}

function MPBadge({ rec, isBackoffice, onReverify, onPickMatch }: {
    rec: ReciboRow;
    isBackoffice: boolean;
    onReverify: () => void;
    onPickMatch: (payment_id: string, cuenta: string) => void;
}) {
    if (rec.medio_pago !== 'mercadopago') return null;
    const status = rec.mp_status;
    const candidates = rec.mp_candidates ?? [];
    if (status === 'skipped') return null;

    if (status === 'verified') {
        const c = candidates.find(x => x.payment_id === rec.mp_payment_id) ?? null;
        return (
            <div className="mp-badge mp-badge--verified">
                <strong>✓ Verificado en MercadoPago</strong>
                <div className="mp-badge-detail">
                    <span>{cuentaLabel(rec.mp_cuenta)}</span>
                    {c?.amount != null && <span>Monto MP: <strong>{formatMoney(c.amount)}</strong></span>}
                    {c?.date_approved && <span>Acreditado {new Date(c.date_approved).toLocaleString('es-AR')}</span>}
                    {c?.payer_email && <span>Pagador: {c.payer_email}</span>}
                    <span className="mp-badge-payid">ID {rec.mp_payment_id}</span>
                </div>
            </div>
        );
    }

    if (status === 'ambiguous') {
        return (
            <div className="mp-badge mp-badge--warn">
                <strong>⚠ Múltiples candidatos en MP</strong>
                <div className="mp-badge-detail">Encontramos {candidates.length} pagos con el mismo monto en la ventana. Elegí el correcto:</div>
                <div className="mp-candidates">
                    {candidates.map(c => (
                        <button key={`${c.cuenta}-${c.payment_id}`} className="mp-candidate-btn"
                            onClick={() => onPickMatch(c.payment_id, c.cuenta)}>
                            <span className="mp-cand-cuenta">{cuentaLabel(c.cuenta)}</span>
                            <span className="mp-cand-fecha">{c.date_approved ? new Date(c.date_approved).toLocaleString('es-AR') : '?'}</span>
                            {c.payer_email && <span className="mp-cand-email">{c.payer_email}</span>}
                            <span className="mp-cand-id">ID {c.payment_id}</span>
                        </button>
                    ))}
                </div>
            </div>
        );
    }

    if (status === 'not_found') {
        return (
            <div className="mp-badge mp-badge--warn">
                <strong>⚠ No encontrado en MP</strong>
                <div className="mp-badge-detail">
                    Reintentando cada 5 min (ventana 24h) · {rec.mp_lookup_attempts ?? 0} intentos
                </div>
                {isBackoffice && (
                    <button className="mp-badge-btn" onClick={onReverify}>Re-verificar ahora</button>
                )}
            </div>
        );
    }

    if (status === 'error') {
        return (
            <div className="mp-badge mp-badge--err">
                <strong>✗ Error consultando MP</strong>
                {isBackoffice && (
                    <button className="mp-badge-btn" onClick={onReverify}>Reintentar</button>
                )}
            </div>
        );
    }

    // pending o null
    return (
        <div className="mp-badge mp-badge--pending">
            <strong>⏳ Buscando en MercadoPago...</strong>
        </div>
    );
}

function DetalleRecibo({ id, isBackoffice, clientNameByCod, onBack }: { id: string; isBackoffice: boolean; clientNameByCod: Map<string, string>; onBack: () => void }) {
    const [rec, setRec] = useState<ReciboRow | null>(null);
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState<string | null>(null);
    const [facturas, setFacturas] = useState<FacturaCandidata[]>([]);
    const [loadingFacturas, setLoadingFacturas] = useState(false);
    const [codEmpresa, setCodEmpresa] = useState<number>(1);
    const [selFacturas, setSelFacturas] = useState<Record<string, number>>({});
    const [montoFinal, setMontoFinal] = useState('');
    const [fechaFinal, setFechaFinal] = useState('');
    const [medioFinal, setMedioFinal] = useState('');
    const [motivoRechazo, setMotivoRechazo] = useState('');
    const [esAnticipo, setEsAnticipo] = useState(false);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

    const loadRecibo = async () => {
        setLoading(true);
        try {
            const res = await fetch(`/api/recibos?limit=200`, { headers: authHeaders() });
            const data = await res.json();
            const item: ReciboRow | null = (data.recibos || []).find((r: ReciboRow) => r.id === id) ?? null;
            setRec(item);
            if (item) {
                // Auto-fill desde MP si el monto del comprobante es placeholder 0.01 (OCR falló)
                // y MP ya verificó el pago. Si no aplica, cae al monto original.
                const mpAuto = item.mp_status === 'verified' && item.mp_candidates
                    ? item.mp_candidates.find(c => c.payment_id === item.mp_payment_id)?.amount ?? null
                    : null;
                const montoSeed = (item.monto && item.monto > 0.01) ? item.monto : (mpAuto ?? item.monto);
                setMontoFinal(montoSeed?.toString() ?? '');
                setFechaFinal(item.fecha_comprobante ?? new Date().toISOString().slice(0, 10));
                // Normaliza recibos legacy ('transferencia', 'otro', 'tarjeta') al canon actual
                setMedioFinal(normalizeMedioUI(item.medio_pago));
            }
        } catch (e: any) { setErr(e.message); }
        finally { setLoading(false); }
    };
    useEffect(() => { loadRecibo(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

    const loadFacturas = async () => {
        if (!rec) return;
        setLoadingFacturas(true);
        try {
            const res = await fetch(`/api/recibos/${rec.id}/facturas-candidatas?cod_empresa=${codEmpresa}`, { headers: authHeaders() });
            const data = await res.json();
            setFacturas(data.facturas ?? []);
        } catch (e: any) { setMsg({ kind: 'err', text: e.message }); }
        finally { setLoadingFacturas(false); }
    };

    const reverificarMPHandler = async () => {
        if (!rec) return;
        try {
            const res = await fetch(`/api/recibos/${rec.id}/reverificar-mp`, { method: 'POST', headers: authHeaders() });
            const data = await res.json();
            if (!data.ok) { setMsg({ kind: 'err', text: data.error ?? 'error' }); return; }
            setMsg({ kind: 'ok', text: `MP: ${data.result?.status ?? 'ok'}` });
            await loadRecibo();
        } catch (e: any) { setMsg({ kind: 'err', text: e.message }); }
    };

    const elegirMatchHandler = async (payment_id: string, cuenta: string) => {
        if (!rec) return;
        try {
            const res = await fetch(`/api/recibos/${rec.id}/elegir-match`, {
                method: 'POST',
                headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ payment_id, cuenta }),
            });
            const data = await res.json();
            if (!data.ok) { setMsg({ kind: 'err', text: data.error ?? 'error' }); return; }
            setMsg({ kind: 'ok', text: 'Match asignado' });
            await loadRecibo();
        } catch (e: any) { setMsg({ kind: 'err', text: e.message }); }
    };
    useEffect(() => { if (isBackoffice && rec) loadFacturas(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [rec?.id, codEmpresa]);

    const toggleFactura = (f: FacturaCandidata) => {
        const key = String(f.id);
        setSelFacturas(prev => {
            const next = { ...prev };
            if (next[key] != null) { delete next[key]; return next; }
            // Autocompletar: saldo disponible, limitado al monto restante del recibo.
            // Redondeo a 2 decimales: IM a veces devuelve saldos con 3 decimales por
            // intereses/comisiones y eso descuadraba el balance contra montoFinal entero.
            const saldo = Math.abs(f.saldo ?? f.importe_factura ?? 0);
            const yaImputado = Object.values(prev).reduce((a, b) => a + (b || 0), 0);
            const restante = Math.max(0, Number(montoFinal) - yaImputado);
            const importe = restante > 0 ? Math.min(saldo, restante) : saldo;
            next[key] = Math.round(importe * 100) / 100;
            return next;
        });
    };

    const setImporteFactura = (key: string, value: number, saldo: number) => {
        // Cap al saldo de la factura (InfoManager rechaza si supera) + redondeo a 2 decimales.
        const capped = Math.max(0, Math.min(value, saldo));
        setSelFacturas(p => ({ ...p, [key]: Math.round(capped * 100) / 100 }));
    };

    const aprobar = async () => {
        if (!rec) return;
        setBusy(true); setMsg(null);
        try {
            const comprobantesPayload = esAnticipo
                ? []
                : Object.entries(selFacturas).map(([id, importe]) => ({
                    id, importe_a_pagar: Number(importe)
                }));
            const res = await fetch(`/api/recibos/${rec.id}/aprobar`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({
                    monto: Number(montoFinal),
                    fecha: fechaFinal,
                    medio_pago: medioFinal,
                    cod_empresa: codEmpresa,
                    comprobantes: comprobantesPayload,
                    es_anticipo: esAnticipo,
                })
            });
            const data = await res.json();
            if (!res.ok || !data.ok) {
                setMsg({ kind: 'err', text: `Error: ${data.error}${data.raw ? ' — ' + JSON.stringify(data.raw).slice(0, 200) : ''}` });
                return;
            }
            setMsg({ kind: 'ok', text: `Imputado. Recibo InfoManager: ${data.recibo_id ?? '(sin id)'}` });
            setTimeout(onBack, 1800);
        } catch (e: any) { setMsg({ kind: 'err', text: e.message }); }
        finally { setBusy(false); }
    };

    const rechazar = async () => {
        if (!rec || !motivoRechazo.trim()) { setMsg({ kind: 'err', text: 'Cargá un motivo' }); return; }
        setBusy(true); setMsg(null);
        try {
            const res = await fetch(`/api/recibos/${rec.id}/rechazar`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({ motivo: motivoRechazo })
            });
            const data = await res.json();
            if (!res.ok || !data.ok) { setMsg({ kind: 'err', text: data.error }); return; }
            setMsg({ kind: 'ok', text: 'Rechazado' });
            setTimeout(onBack, 1200);
        } catch (e: any) { setMsg({ kind: 'err', text: e.message }); }
        finally { setBusy(false); }
    };

    if (loading) return <div className="rec-loading"><Loader2 className="spin" /> Cargando…</div>;
    if (err || !rec) return <div className="rec-error"><AlertCircle /> {err ?? 'No encontrado'}</div>;

    const totalImputado = Object.values(selFacturas).reduce((a, b) => a + (b || 0), 0);

    // Si el OCR falló y el vendedor no cargó monto, comprobantes_pago.monto queda en 0.01.
    // Cuando MP verificó el pago, mostramos el amount real detectado para no engañar al admin con "$ 0".
    const mpMatch = rec.mp_status === 'verified' && rec.mp_candidates
        ? rec.mp_candidates.find(c => c.payment_id === rec.mp_payment_id) ?? null
        : null;
    const montoIsPlaceholder = !rec.monto || rec.monto <= 0.01;
    const montoEffective = !montoIsPlaceholder ? rec.monto : (mpMatch?.amount ?? null);

    // Mensaje exacto que explica por qué el botón aprobar está disabled.
    const disabledReason = (() => {
        if (busy) return '';
        if (esAnticipo) {
            return !(Number(montoFinal) > 0) ? 'Cargá el monto final del anticipo' : '';
        }
        if (Object.keys(selFacturas).length === 0) return 'Seleccioná al menos una factura, o marcá "Es anticipo de cliente"';
        const diff = Math.abs(totalImputado - Number(montoFinal));
        if (diff > 5) return `Diferencia $${(Number(montoFinal) - totalImputado).toFixed(2)} — ajustá monto final o importe imputado`;
        return '';
    })();

    return (
        <div className="rec-detail">
            <button className="rec-back" onClick={onBack}><ChevronLeft size={16} /> Volver</button>

            <div className="rec-detail-grid">
                <div className="rec-detail-photo">
                    {rec.foto_signed_url && rec.foto_url.toLowerCase().endsWith('.pdf')
                        ? <a href={rec.foto_signed_url} target="_blank" rel="noreferrer" className="rec-pdf-link"><FileText size={32} /> Ver PDF</a>
                        : rec.foto_signed_url ? <img src={rec.foto_signed_url} alt="comprobante" /> : <div>Sin foto</div>}
                </div>

                <div className="rec-detail-info">
                    <div className="rec-detail-head">
                        <div>
                            <span className={`rec-status rec-status--${rec.status}`}>{statusLabel(rec.status)}</span>
                            <h3>{clientNameByCod.get(String(rec.cod_cliente)) ?? `Cliente ${rec.cod_cliente}`}</h3>
                            <p>Cod {rec.cod_cliente} · Vendedor cod {rec.cod_vendedor} · {timeAgo(rec.created_at)}</p>
                        </div>
                        <div className="rec-detail-amount">
                            {montoEffective != null ? (
                                <>
                                    {formatMoney(montoEffective)}
                                    {montoIsPlaceholder && <small className="rec-amount-source"> (MP)</small>}
                                </>
                            ) : (
                                <span className="rec-amount-empty">Sin monto cargado</span>
                            )}
                        </div>
                    </div>

                    <dl className="rec-dl">
                        <dt>Fecha</dt><dd>{rec.fecha_comprobante ?? '—'}</dd>
                        <dt>Medio</dt><dd>{rec.medio_pago ?? '—'}</dd>
                        <dt>Banco origen</dt><dd>{rec.banco_origen ?? '—'}</dd>
                        <dt>Referencia</dt><dd>{rec.referencia ?? '—'}</dd>
                        <dt>Observaciones</dt><dd>{rec.observaciones ?? '—'}</dd>
                        {rec.ocr_confidence != null && <><dt>OCR</dt><dd>{Math.round(rec.ocr_confidence * 100)}%</dd></>}
                        {rec.factura_asociada && <><dt>Imputado a</dt><dd>{rec.factura_asociada}</dd></>}
                        {rec.infomanager_recibo_id && <><dt>Recibo IM</dt><dd>{rec.infomanager_recibo_id}</dd></>}
                        {rec.motivo_rechazo && <><dt>Motivo rechazo</dt><dd>{rec.motivo_rechazo}</dd></>}
                        {rec.error_msg && <><dt>Error</dt><dd>{rec.error_msg}</dd></>}
                    </dl>

                    <MPBadge rec={rec} isBackoffice={isBackoffice}
                        onReverify={reverificarMPHandler}
                        onPickMatch={elegirMatchHandler} />

                    {isBackoffice && (rec.status === 'pendiente_revision' || rec.status === 'error') && (
                        <div className="rec-approval">
                            <h4>{esAnticipo ? 'Imputar como anticipo' : 'Imputar a facturas'}</h4>

                            <label className="rec-anticipo-toggle">
                                <input type="checkbox" checked={esAnticipo} onChange={e => setEsAnticipo(e.target.checked)} />
                                <div>
                                    <strong>Es anticipo de cliente (sin factura)</strong>
                                    <span>Se imputa a la cuenta 2124000 — Anticipo de clientes.</span>
                                </div>
                            </label>

                            <div className="rec-row">
                                <label className="rec-field">
                                    <span>Empresa</span>
                                    <select value={codEmpresa} onChange={e => setCodEmpresa(Number(e.target.value))}>
                                        <option value={1}>1 · Casa Central</option>
                                        <option value={2}>2 · BRS San Martín</option>
                                        <option value={3}>3 · Santo Cristo</option>
                                    </select>
                                </label>
                                <label className="rec-field">
                                    <span>Monto final</span>
                                    <input type="number" step="0.01" value={montoFinal} onChange={e => setMontoFinal(e.target.value)} />
                                </label>
                            </div>
                            <div className="rec-row">
                                <label className="rec-field">
                                    <span>Fecha</span>
                                    <input type="date" value={fechaFinal} onChange={e => setFechaFinal(e.target.value)} />
                                </label>
                                <label className="rec-field">
                                    <span>Medio</span>
                                    <select value={medioFinal} onChange={e => setMedioFinal(e.target.value)}>
                                        {MEDIOS_PAGO_UI.map(m => (
                                            <option key={m.value} value={m.value}>{m.label}</option>
                                        ))}
                                    </select>
                                </label>
                            </div>

                            {!esAnticipo && <div className="rec-facturas">
                                {loadingFacturas && <div><Loader2 className="spin" size={14} /> Cargando facturas pendientes…</div>}
                                {!loadingFacturas && facturas.length === 0 && <div className="rec-empty">Sin facturas pendientes para esta empresa.</div>}
                                {!loadingFacturas && facturas.map(f => {
                                    const key = String(f.id);
                                    const sel = selFacturas[key] != null;
                                    const saldo = Math.abs(f.saldo ?? f.importe_factura ?? 0);
                                    return (
                                        <div key={key} className={`rec-factura ${sel ? 'is-active' : ''}`}>
                                            <label>
                                                <input type="checkbox" checked={sel} onChange={() => toggleFactura(f)} />
                                                <div>
                                                    <strong>{f.tipo_comprobante} {f.punto_de_venta}-{f.numero}</strong>
                                                    <span>{f.fecha_factura ?? ''} · Saldo {formatMoney(saldo)}{f.dias_deuda != null ? ` · ${f.dias_deuda}d` : ''}{f.detalle ? ` · ${f.detalle}` : ''}</span>
                                                </div>
                                            </label>
                                            {sel && (
                                                <input type="number" step="0.01" max={saldo} min="0"
                                                    value={selFacturas[key]}
                                                    onChange={e => setImporteFactura(key, Number(e.target.value), saldo)}
                                                    className="rec-importe-input"
                                                    title={`Máx $${saldo.toLocaleString('es-AR')}`} />
                                            )}
                                        </div>
                                    );
                                })}
                            </div>}

                            {!esAnticipo && (
                                <div className="rec-approval-summary">
                                    <span>Total a imputar: <strong>{formatMoney(totalImputado)}</strong> / {formatMoney(Number(montoFinal))}</span>
                                    {Math.abs(totalImputado - Number(montoFinal)) > 5 && (
                                        <span className="rec-warn">
                                            ⚠ Diferencia: ${(Number(montoFinal) - totalImputado).toFixed(2)}
                                        </span>
                                    )}
                                </div>
                            )}
                            {esAnticipo && (
                                <div className="rec-approval-summary">
                                    <span>Anticipo por <strong>{formatMoney(Number(montoFinal))}</strong> → cta 2124000</span>
                                </div>
                            )}

                            {msg && <div className={`rec-msg rec-msg--${msg.kind}`}>{msg.text}</div>}

                            <div className="rec-approval-actions">
                                <input
                                    type="text"
                                    placeholder="Motivo de rechazo (si aplica)"
                                    value={motivoRechazo}
                                    onChange={e => setMotivoRechazo(e.target.value)}
                                    className="rec-rechazo-input"
                                />
                                <button className="btn-danger" disabled={busy || !motivoRechazo.trim()} onClick={rechazar}>Rechazar</button>
                                <button className="btn-primary"
                                    disabled={busy || (esAnticipo
                                        ? !(Number(montoFinal) > 0)
                                        : (Object.keys(selFacturas).length === 0 || Math.abs(totalImputado - Number(montoFinal)) > 5))}
                                    onClick={aprobar}
                                    title={disabledReason}>
                                    {busy ? <><Loader2 size={14} className="spin" /> Emitiendo…</> : <><Check size={14} /> {esAnticipo ? 'Aprobar como anticipo' : 'Aprobar y emitir recibo'}</>}
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

// ───────────────────────────────────────────────────────────────────────────
// helpers
// ───────────────────────────────────────────────────────────────────────────
function statusLabel(s: string): string {
    switch (s) {
        case 'pendiente_revision': return 'Pendiente';
        case 'aprobado': return 'Aprobado';
        case 'imputado': return 'Imputado';
        case 'rechazado': return 'Rechazado';
        case 'error': return 'Error';
        case 'todos': return 'Todos';
        default: return s;
    }
}
function formatMoney(n: number | null | undefined): string {
    if (n == null) return '—';
    return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n);
}
function timeAgo(iso: string): string {
    const d = new Date(iso);
    const diff = Math.floor((Date.now() - d.getTime()) / 1000);
    if (diff < 60) return 'hace unos segundos';
    if (diff < 3600) return `hace ${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `hace ${Math.floor(diff / 3600)}h`;
    return `hace ${Math.floor(diff / 86400)}d`;
}
