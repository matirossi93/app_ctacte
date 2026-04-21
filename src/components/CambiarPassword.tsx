import { useState } from 'react';
import { X, Lock, Loader2, AlertCircle, Check } from 'lucide-react';
import { authHeaders } from '../utils/auth';
import './CambiarPassword.css';

interface Props { onClose: () => void }

export const CambiarPassword = ({ onClose }: Props) => {
    const [current, setCurrent] = useState('');
    const [next, setNext] = useState('');
    const [confirm, setConfirm] = useState('');
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const [ok, setOk] = useState(false);

    const submit = async () => {
        setErr(null);
        if (next.length < 6) { setErr('La nueva contraseña debe tener al menos 6 caracteres'); return; }
        if (next !== confirm) { setErr('Las contraseñas no coinciden'); return; }
        setSaving(true);
        try {
            const res = await fetch('/api/usuarios/change-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({ current_password: current, new_password: next }),
            });
            const j = await res.json();
            if (!res.ok || !j.ok) throw new Error(j.error);
            setOk(true);
            setTimeout(onClose, 1200);
        } catch (e: any) { setErr(e.message); }
        finally { setSaving(false); }
    };

    return (
        <div className="cp-backdrop" onClick={onClose}>
            <div className="cp-modal" onClick={e => e.stopPropagation()}>
                <header>
                    <div className="cp-head-l"><Lock size={18} /> <h3>Cambiar mi contraseña</h3></div>
                    <button onClick={onClose} aria-label="Cerrar"><X size={18} /></button>
                </header>

                {ok ? (
                    <div className="cp-ok">
                        <Check size={32} />
                        <p>Contraseña actualizada</p>
                    </div>
                ) : (
                    <>
                        <label>
                            <span>Contraseña actual</span>
                            <input type="password" value={current} onChange={e => setCurrent(e.target.value)} autoFocus />
                        </label>
                        <label>
                            <span>Nueva contraseña</span>
                            <input type="password" value={next} onChange={e => setNext(e.target.value)} />
                        </label>
                        <label>
                            <span>Confirmar nueva contraseña</span>
                            <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
                        </label>

                        {err && <div className="cp-err"><AlertCircle size={14} /> {err}</div>}

                        <div className="cp-actions">
                            <button className="cp-btn-sec" onClick={onClose} disabled={saving}>Cancelar</button>
                            <button className="cp-btn-primary" onClick={submit} disabled={saving || !current || !next || !confirm}>
                                {saving ? <><Loader2 size={14} className="spin" /> Guardando…</> : 'Cambiar contraseña'}
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};
