export const getToken = (): string | null => sessionStorage.getItem('auth_token');
export const setToken = (token: string): void => sessionStorage.setItem('auth_token', token);
export const clearToken = (): void => sessionStorage.removeItem('auth_token');

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
