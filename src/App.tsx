import { useState, useEffect } from 'react';
import { Dashboard } from './components/Dashboard';
import { LoginScreen } from './components/LoginScreen';
import { authHeaders, clearToken } from './utils/auth';

type AuthState = 'checking' | 'authenticated' | 'unauthenticated';

function App() {
    const [authState, setAuthState] = useState<AuthState>('checking');

    useEffect(() => {
        fetch('/api/auth/check', { headers: authHeaders() })
            .then(async res => {
                if (res.ok) {
                    const data = await res.json() as { valid: boolean; authRequired: boolean };
                    if (!data.authRequired || data.valid) {
                        setAuthState('authenticated');
                    } else {
                        setAuthState('unauthenticated');
                    }
                } else {
                    clearToken();
                    setAuthState('unauthenticated');
                }
            })
            .catch(() => setAuthState('unauthenticated'));
    }, []);

    if (authState === 'checking') {
        return (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--color-primary)' }}>
                <div className="spinner">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="12" y1="2" x2="12" y2="6" /><line x1="12" y1="18" x2="12" y2="22" />
                        <line x1="4.93" y1="4.93" x2="7.76" y2="7.76" /><line x1="16.24" y1="16.24" x2="19.07" y2="19.07" />
                        <line x1="2" y1="12" x2="6" y2="12" /><line x1="18" y1="12" x2="22" y2="12" />
                        <line x1="4.93" y1="19.07" x2="7.76" y2="16.24" /><line x1="16.24" y1="4.93" x2="19.07" y2="7.76" />
                    </svg>
                </div>
            </div>
        );
    }

    if (authState === 'unauthenticated') {
        return <LoginScreen onLogin={() => setAuthState('authenticated')} />;
    }

    return (
        <div className="app-container">
            <Dashboard onUnauthorized={() => { clearToken(); setAuthState('unauthenticated'); }} />
        </div>
    );
}

export default App;
