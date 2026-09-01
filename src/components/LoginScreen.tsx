import { useState, type FormEvent } from 'react';
import { setToken, setUser, setAuthMode, type AuthUser } from '../utils/auth';
import { Lock, Mail, Eye, EyeOff } from 'lucide-react';

interface LoginScreenProps {
    onLogin: () => void;
}

export const LoginScreen = ({ onLogin }: LoginScreenProps) => {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [showPass, setShowPass] = useState(false);

    const handleEmailSubmit = async (e: FormEvent) => {
        e.preventDefault();
        setLoading(true); setError('');
        try {
            const res = await fetch('/api/auth/login-v2', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: email.trim(), password })
            });
            const data = await res.json() as { success: boolean; jwt?: string; user?: AuthUser; error?: string };
            if (data.success && data.jwt && data.user) {
                setToken(data.jwt);
                setUser(data.user);
                setAuthMode('jwt');
                onLogin();
            } else {
                setError(data.error || 'Credenciales inválidas');
            }
        } catch {
            setError('Error de conexión con el servidor');
        } finally { setLoading(false); }
    };

    return (
        <div className="login-screen">
            <div className="login-card glass">
                <img
                    src="/logo.webp"
                    alt="Semillero El Manantial"
                    className="login-logo"
                    onError={(e) => { (e.target as HTMLImageElement).src = '/logo.png'; }}
                />
                <div className="login-title-group">
                    <h1>Panel Vendedor</h1>
                    <p>Ingresá con tu email y contraseña</p>
                </div>

                {
                    <form onSubmit={handleEmailSubmit} className="login-form">
                        <div className="login-input-wrap">
                            <Mail size={16} className="login-input-icon" />
                            <input
                                type="email"
                                value={email}
                                onChange={e => setEmail(e.target.value)}
                                placeholder="tu@semillero"
                                autoComplete="email"
                                autoFocus
                                required
                                className="login-input"
                            />
                        </div>
                        <div className="login-input-wrap">
                            <Lock size={16} className="login-input-icon" />
                            <input
                                type={showPass ? 'text' : 'password'}
                                value={password}
                                onChange={e => setPassword(e.target.value)}
                                placeholder="Contraseña"
                                autoComplete="current-password"
                                required
                                className="login-input"
                            />
                            <button type="button" className="login-eye-btn" onClick={() => setShowPass(v => !v)} tabIndex={-1}>
                                {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
                            </button>
                        </div>
                        {error && <p className="login-error">{error}</p>}
                        <button type="submit" className="btn-primary login-submit" disabled={loading}>
                            {loading ? 'Ingresando...' : 'Ingresar'}
                        </button>
                    </form>
                }
            </div>
        </div>
    );
};
