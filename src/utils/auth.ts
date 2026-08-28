export interface AuthUser {
    email: string;
    // `socio` y `administrativo` los agregó el panel único (28/08/2026).
    rol: 'admin' | 'socio' | 'gerente' | 'administrativo' | 'vendedor' | 'repartidor';
    cod_vendedor: number | null;
    vendedor_key: string | null;
    nombre: string | null;
}

export const getToken = (): string | null => localStorage.getItem('auth_token');
export const setToken = (token: string): void => localStorage.setItem('auth_token', token);
export const clearToken = (): void => {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_user');
    localStorage.removeItem('auth_mode');
};

export type AuthMode = 'legacy' | 'jwt';
export const getAuthMode = (): AuthMode => (localStorage.getItem('auth_mode') as AuthMode) || 'jwt';
export const setAuthMode = (m: AuthMode): void => { localStorage.setItem('auth_mode', m); };

export const getUser = (): AuthUser | null => {
    const raw = localStorage.getItem('auth_user');
    if (!raw) return null;
    try { return JSON.parse(raw) as AuthUser; } catch { return null; }
};
export const setUser = (u: AuthUser): void => { localStorage.setItem('auth_user', JSON.stringify(u)); };

export const authHeaders = (): Record<string, string> => {
    const token = getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
};

export class UnauthorizedError extends Error {
    constructor() {
        super('No autorizado');
        this.name = 'UnauthorizedError';
    }
}
