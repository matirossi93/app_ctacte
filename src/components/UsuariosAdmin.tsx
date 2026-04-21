import { useEffect, useState } from 'react';
import { X, Users, Plus, Edit3, Check, Lock, UserX, UserCheck, Loader2, AlertCircle } from 'lucide-react';
import { authHeaders } from '../utils/auth';
import './UsuariosAdmin.css';

interface Props { onClose: () => void }

type Rol = 'admin' | 'gerente' | 'vendedor';
interface Usuario {
    id: string;
    email: string;
    nombre: string | null;
    rol: Rol;
    cod_vendedor: number | null;
    vendedor_key: string | null;
    activo: boolean;
    created_at: string;
}

export const UsuariosAdmin = ({ onClose }: Props) => {
    const [items, setItems] = useState<Usuario[]>([]);
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState<string | null>(null);
    const [showNew, setShowNew] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [resetPassFor, setResetPassFor] = useState<Usuario | null>(null);

    const load = async () => {
        setLoading(true); setErr(null);
        try {
            const res = await fetch('/api/usuarios', { headers: authHeaders() });
            const j = await res.json();
            if (!res.ok || !j.ok) throw new Error(j.error);
            setItems(j.items || []);
        } catch (e: any) { setErr(e.message); }
        finally { setLoading(false); }
    };
    useEffect(() => { load(); }, []);

    const toggleActivo = async (u: Usuario) => {
        if (!u.activo) {
            // Reactivar: PUT activo=true
            await fetch(`/api/usuarios/${u.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({ activo: true }),
            });
        } else {
            if (!confirm(`Desactivar a ${u.nombre ?? u.email}? No podrá loguearse.`)) return;
            await fetch(`/api/usuarios/${u.id}`, { method: 'DELETE', headers: authHeaders() });
        }
        await load();
    };

    return (
        <div className="ua-backdrop" onClick={onClose}>
            <div className="ua-modal" onClick={e => e.stopPropagation()}>
                <header>
                    <div className="ua-head-l"><Users size={18} /> <h3>Gestión de usuarios</h3></div>
                    <div className="ua-head-r">
                        <button className="ua-btn-primary" onClick={() => setShowNew(true)}><Plus size={14} /> Nuevo</button>
                        <button onClick={onClose} className="ua-close" aria-label="Cerrar"><X size={18} /></button>
                    </div>
                </header>

                <div className="ua-body">
                    {loading && <div className="ua-loading"><Loader2 className="spin" /> Cargando…</div>}
                    {err && <div className="ua-err"><AlertCircle size={14} /> {err}</div>}

                    {!loading && items.length > 0 && (
                        <div className="ua-list">
                            {items.map(u => (
                                editingId === u.id
                                    ? <EditUsuarioInline key={u.id} u={u} onClose={() => setEditingId(null)} onSaved={() => { setEditingId(null); load(); }} />
                                    : <UsuarioRow key={u.id} u={u}
                                        onEdit={() => setEditingId(u.id)}
                                        onToggleActivo={() => toggleActivo(u)}
                                        onResetPass={() => setResetPassFor(u)} />
                            ))}
                        </div>
                    )}
                </div>

                {showNew && <NuevoUsuario onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load(); }} />}
                {resetPassFor && <ResetPassword u={resetPassFor} onClose={() => setResetPassFor(null)} />}
            </div>
        </div>
    );
};

// ─── Row de usuario (vista) ─────────────────────────────────────────────────
function UsuarioRow({ u, onEdit, onToggleActivo, onResetPass }:
    { u: Usuario; onEdit: () => void; onToggleActivo: () => void; onResetPass: () => void }) {
    return (
        <div className={`ua-row ${u.activo ? '' : 'inactivo'}`}>
            <div className="ua-row-main">
                <div className="ua-row-name">
                    <strong>{u.nombre ?? u.email}</strong>
                    {!u.activo && <span className="ua-tag inactivo">inactivo</span>}
                    <span className={`ua-tag rol-${u.rol}`}>{u.rol}</span>
                </div>
                <div className="ua-row-meta">
                    <span>{u.email}</span>
                    {u.cod_vendedor != null && <span>· cod {u.cod_vendedor}</span>}
                    {u.vendedor_key && <span>· {u.vendedor_key}</span>}
                </div>
            </div>
            <div className="ua-row-actions">
                <button onClick={onResetPass} title="Resetear contraseña"><Lock size={14} /></button>
                <button onClick={onEdit} title="Editar"><Edit3 size={14} /></button>
                <button onClick={onToggleActivo} title={u.activo ? 'Desactivar' : 'Reactivar'}>
                    {u.activo ? <UserX size={14} /> : <UserCheck size={14} />}
                </button>
            </div>
        </div>
    );
}

// ─── Edit inline ────────────────────────────────────────────────────────────
function EditUsuarioInline({ u, onClose, onSaved }: { u: Usuario; onClose: () => void; onSaved: () => void }) {
    const [nombre, setNombre] = useState(u.nombre ?? '');
    const [rol, setRol] = useState<Rol>(u.rol);
    const [codVendedor, setCodVendedor] = useState(u.cod_vendedor?.toString() ?? '');
    const [vendedorKey, setVendedorKey] = useState(u.vendedor_key ?? '');
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    const save = async () => {
        setSaving(true); setErr(null);
        try {
            const body: any = { nombre, rol, vendedor_key: vendedorKey || null };
            body.cod_vendedor = codVendedor ? Number(codVendedor) : null;
            const res = await fetch(`/api/usuarios/${u.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify(body),
            });
            const j = await res.json();
            if (!res.ok || !j.ok) throw new Error(j.error);
            onSaved();
        } catch (e: any) { setErr(e.message); }
        finally { setSaving(false); }
    };

    return (
        <div className="ua-edit">
            <div className="ua-edit-email">{u.email}</div>
            <div className="ua-edit-grid">
                <label><span>Nombre</span><input value={nombre} onChange={e => setNombre(e.target.value)} /></label>
                <label><span>Rol</span>
                    <select value={rol} onChange={e => setRol(e.target.value as Rol)}>
                        <option value="admin">admin</option>
                        <option value="gerente">gerente</option>
                        <option value="vendedor">vendedor</option>
                    </select>
                </label>
                <label><span>Cod. vendedor</span><input type="number" value={codVendedor} onChange={e => setCodVendedor(e.target.value)} /></label>
                <label><span>Vendedor key</span><input value={vendedorKey} onChange={e => setVendedorKey(e.target.value)} placeholder="brian, marcelo…" /></label>
            </div>
            {err && <div className="ua-err"><AlertCircle size={14} /> {err}</div>}
            <div className="ua-edit-actions">
                <button className="ua-btn-sec" onClick={onClose}>Cancelar</button>
                <button className="ua-btn-primary" onClick={save} disabled={saving}>
                    {saving ? <Loader2 size={14} className="spin" /> : <Check size={14} />} Guardar
                </button>
            </div>
        </div>
    );
}

// ─── Nuevo usuario ──────────────────────────────────────────────────────────
function NuevoUsuario({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
    const [email, setEmail] = useState('');
    const [nombre, setNombre] = useState('');
    const [password, setPassword] = useState('');
    const [rol, setRol] = useState<Rol>('vendedor');
    const [codVendedor, setCodVendedor] = useState('');
    const [vendedorKey, setVendedorKey] = useState('');
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    const submit = async () => {
        setSaving(true); setErr(null);
        try {
            const body: any = { email, password, nombre, rol };
            if (codVendedor) body.cod_vendedor = Number(codVendedor);
            if (vendedorKey) body.vendedor_key = vendedorKey;
            const res = await fetch('/api/usuarios', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify(body),
            });
            const j = await res.json();
            if (!res.ok || !j.ok) throw new Error(j.error);
            onCreated();
        } catch (e: any) { setErr(e.message); }
        finally { setSaving(false); }
    };

    return (
        <div className="ua-inner-backdrop" onClick={onClose}>
            <div className="ua-inner-modal" onClick={e => e.stopPropagation()}>
                <header><h4>Nuevo usuario</h4><button onClick={onClose}><X size={16} /></button></header>
                <div className="ua-inner-grid">
                    <label><span>Email</span><input type="email" value={email} onChange={e => setEmail(e.target.value)} autoFocus /></label>
                    <label><span>Nombre</span><input value={nombre} onChange={e => setNombre(e.target.value)} /></label>
                    <label><span>Contraseña inicial</span><input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="mín 6 chars" /></label>
                    <label><span>Rol</span>
                        <select value={rol} onChange={e => setRol(e.target.value as Rol)}>
                            <option value="vendedor">vendedor</option>
                            <option value="gerente">gerente</option>
                            <option value="admin">admin</option>
                        </select>
                    </label>
                    <label><span>Cod. vendedor</span><input type="number" value={codVendedor} onChange={e => setCodVendedor(e.target.value)} placeholder={rol === 'vendedor' ? 'obligatorio' : 'opcional'} /></label>
                    <label><span>Vendedor key</span><input value={vendedorKey} onChange={e => setVendedorKey(e.target.value)} placeholder="brian, marcelo…" /></label>
                </div>
                {err && <div className="ua-err"><AlertCircle size={14} /> {err}</div>}
                <div className="ua-edit-actions">
                    <button className="ua-btn-sec" onClick={onClose}>Cancelar</button>
                    <button className="ua-btn-primary" onClick={submit} disabled={saving || !email || !password}>
                        {saving ? <Loader2 size={14} className="spin" /> : <Plus size={14} />} Crear
                    </button>
                </div>
            </div>
        </div>
    );
}

// ─── Reset password ─────────────────────────────────────────────────────────
function ResetPassword({ u, onClose }: { u: Usuario; onClose: () => void }) {
    const [pass, setPass] = useState('');
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const [ok, setOk] = useState(false);

    const submit = async () => {
        if (pass.length < 6) { setErr('Mínimo 6 caracteres'); return; }
        setSaving(true); setErr(null);
        try {
            const res = await fetch('/api/usuarios/change-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({ user_id: u.id, new_password: pass }),
            });
            const j = await res.json();
            if (!res.ok || !j.ok) throw new Error(j.error);
            setOk(true);
            setTimeout(onClose, 1200);
        } catch (e: any) { setErr(e.message); }
        finally { setSaving(false); }
    };

    return (
        <div className="ua-inner-backdrop" onClick={onClose}>
            <div className="ua-inner-modal" onClick={e => e.stopPropagation()}>
                <header><h4>Resetear contraseña</h4><button onClick={onClose}><X size={16} /></button></header>
                <p className="ua-reset-info">Para: <strong>{u.nombre ?? u.email}</strong></p>
                {ok ? (
                    <div className="ua-ok"><Check size={24} /> Contraseña cambiada</div>
                ) : (
                    <>
                        <label><span>Nueva contraseña</span>
                            <input type="password" value={pass} onChange={e => setPass(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') submit(); }} autoFocus />
                        </label>
                        {err && <div className="ua-err"><AlertCircle size={14} /> {err}</div>}
                        <div className="ua-edit-actions">
                            <button className="ua-btn-sec" onClick={onClose}>Cancelar</button>
                            <button className="ua-btn-primary" onClick={submit} disabled={saving || !pass}>
                                {saving ? <Loader2 size={14} className="spin" /> : <Lock size={14} />} Resetear
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
