export interface AuthUser {
    email: string;
    rol: 'admin' | 'gerente' | 'vendedor';
    cod_vendedor: number | null;
    vendedor_key: string | null;
    nombre: string | null;
}

export const getToken = (): string | null => sessionStorage.getItem('auth_token');
export const setToken = (token: string): void => sessionStorage.setItem('auth_token', token);
export const clearToken = (): void => {
    sessionStorage.removeItem('auth_token');
    sessionStorage.removeItem('auth_user');
    sessionStorage.removeItem('auth_mode');
};

export type AuthMode = 'legacy' | 'jwt';
export const getAuthMode = (): AuthMode => (sessionStorage.getItem('auth_mode') as AuthMode) || 'legacy';
export const setAuthMode = (m: AuthMode): void => { sessionStorage.setItem('auth_mode', m); };

export const getUser = (): AuthUser | null => {
    const raw = sessionStorage.getItem('auth_user');
    if (!raw) return null;
    try { return JSON.parse(raw) as AuthUser; } catch { return null; }
};
export const setUser = (u: AuthUser): void => { sessionStorage.setItem('auth_user', JSON.stringify(u)); };

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
