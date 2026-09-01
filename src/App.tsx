import { useState, useEffect } from 'react';
import { LoginScreen } from './components/LoginScreen';
import { VendorShell } from './components/VendorShell';
import { RepartidorShell } from './components/RepartidorShell';
import { authHeaders, clearToken, getToken, getUser, setUser } from './utils/auth';
import { sesionRechazada } from './utils/sesionInicial';

type AuthState = 'checking' | 'authenticated' | 'unauthenticated';

function App() {
    const [authState, setAuthState] = useState<AuthState>('checking');

    /**
     * No se pudo PREGUNTAR si la sesión vale — que no es lo mismo que una sesión que no vale.
     *
     * 🔴 31/08/2026: acá se hacía `clearToken()` en el `.catch()` y en cualquier respuesta que
     * no fuera 200. O sea que un bache de señal al abrir la app —o un 502 del proxy, o el
     * server reiniciándose— **deslogueaba al vendedor** y lo dejaba en el login con «Error de
     * conexión con el servidor», con la sesión ya borrada. En la calle, con la PWA que se
     * relanza sola cada vez que el celular la descarta, eso pasa seguido.
     *
     * Si en este teléfono ya había entrado, entra igual: las pantallas piden sus datos por su
     * cuenta y cada una ya sabe avisar cuando no hay red. Si el token de verdad está vencido,
     * el server contesta 401 y ahí sí se borra, que es abajo.
     */
    const seguirConLaSesionGuardada = () => {
        setAuthState(getToken() && getUser() ? 'authenticated' : 'unauthenticated');
    };

    // Ya no hay dos modos de sesión: sólo JWT. El de contraseña compartida se fue junto
    // con el panel viejo el 01/09/2026 (el server ya lo rechazaba desde antes).
    useEffect(() => {
        fetch('/api/me', { headers: authHeaders() })
            .then(async res => {
                const data = res.ok
                    ? await res.json().catch(() => null) as { ok: boolean; user: any } | null
                    : null;
                // La regla vive en utils/sesionInicial.ts, con tests: es la que estaba mal.
                if (sesionRechazada(res.status, !!(data?.ok && data.user))) {
                    clearToken();
                    setAuthState('unauthenticated');
                    return;
                }
                if (data?.ok && data.user) {
                    setUser({
                        email: data.user.email,
                        rol: data.user.rol,
                        cod_vendedor: data.user.cod_vendedor ?? null,
                        vendedor_key: data.user.vendedor_key ?? null,
                        nombre: data.user.nombre ?? null,
                    });
                    setAuthState('authenticated');
                    return;
                }
                // El server no pudo contestar (5xx, proxy): se sigue con lo guardado.
                seguirConLaSesionGuardada();
            })
            .catch(seguirConLaSesionGuardada);
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

    const user = getUser();

    // 🗑️ 01/09/2026: se borró el panel viejo (Dashboard) y con él el modo "contraseña
    // compartida". Hacía rato que no se podía entrar por ahí: el server ya respondía
    // "Acceso deshabilitado" porque APP_PASSWORD no está configurado.
    // Una sesión vieja guardada en ese modo no tiene a dónde ir ⇒ al login.
    if (!user) {
        clearToken();
        return <LoginScreen onLogin={() => setAuthState('authenticated')} />;
    }

    // El repartidor solo carga y consulta comprobantes: no ve cobranzas,
    // objetivos ni comisiones. Tiene su propia pantalla acotada.
    if (user.rol === 'repartidor') {
        return <RepartidorShell onLogout={() => { clearToken(); setAuthState('unauthenticated'); }} />;
    }
    return <VendorShell onLogout={() => { clearToken(); setAuthState('unauthenticated'); }} />;
}

export default App;
