import { useState, type FormEvent } from 'react';
import { setToken } from '../utils/auth';
import { Lock, Eye, EyeOff } from 'lucide-react';

interface LoginScreenProps {
    onLogin: () => void;
}

export const LoginScreen = ({ onLogin }: LoginScreenProps) => {
    const [password, setPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [showPass, setShowPass] = useState(false);

    const handleSubmit = async (e: FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError('');
        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password })
            });
            const data = await res.json() as { success: boolean; token?: string; error?: string };
            if (data.success && data.token) {
                setToken(data.token);
                onLogin();
            } else {
                setError(data.error || 'Contraseña incorrecta');
            }
        } catch {
            setError('Error de conexión con el servidor');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="login-screen">
            <div className="login-card glass">
                <img
                    src="/logo_full.png"
                    alt="Semillero El Manantial"
                    className="login-logo"
                    onError={(e) => { (e.target as HTMLImageElement).src = '/logo.png'; }}
                />
                <div className="login-title-group">
                    <h1>Panel de Cobranzas</h1>
                    <p>Ingresá tu contraseña para continuar</p>
                </div>
                <form onSubmit={handleSubmit} className="login-form">
                    <div className="login-input-wrap">
                        <Lock size={16} className="login-input-icon" />
                        <input
                            type={showPass ? 'text' : 'password'}
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                            placeholder="Contraseña"
                            autoFocus
                            required
                            className="login-input"
                        />
                        <button
                            type="button"
                            className="login-eye-btn"
                            onClick={() => setShowPass(v => !v)}
                            tabIndex={-1}
                        >
                            {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                    </div>
                    {error && <p className="login-error">{error}</p>}
                    <button type="submit" className="btn-primary login-submit" disabled={loading}>
                        {loading ? 'Ingresando...' : 'Ingresar'}
                    </button>
                </form>
            </div>
        </div>
    );
};
