import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { sb, TENANT_ID } from './supabase.js';

const JWT_SECRET = process.env.JWT_SECRET || '';
const JWT_TTL_SECONDS = 8 * 60 * 60;

export interface JwtPayload {
  sub: string;              // usuario.id
  email: string;
  rol: 'admin' | 'gerente' | 'vendedor';
  vendedor_key?: string | null;
  cod_vendedor?: number | null;
  nombre?: string | null;
}

export function sha256hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function getSecret(): string {
  if (!JWT_SECRET) {
    // En dev sin secret, usar uno efímero para no crashear — NO usar en prod
    const fallback = randomBytes(32).toString('hex');
    process.env.JWT_SECRET = fallback;
    console.warn('JWT_SECRET no definido; usando secreto efímero (dev only)');
    return fallback;
  }
  return JWT_SECRET;
}

export function signJwt(payload: JwtPayload): string {
  return jwt.sign(payload, getSecret(), { expiresIn: JWT_TTL_SECONDS });
}

export function verifyJwt(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, getSecret()) as JwtPayload;
  } catch {
    return null;
  }
}

export interface UsuarioRow {
  id: string;
  email: string;
  password_hash: string;
  rol: 'admin' | 'gerente' | 'vendedor';
  vendedor_key: string | null;
  cod_vendedor: number | null;
  nombre: string | null;
  activo: boolean;
}

export async function findUsuarioByEmail(email: string): Promise<UsuarioRow | null> {
  const { data, error } = await sb()
    .from('usuarios')
    .select('id, email, password_hash, rol, vendedor_key, cod_vendedor, nombre, activo')
    .eq('tenant_id', TENANT_ID)
    .ilike('email', email)
    .eq('activo', true)
    .maybeSingle();
  if (error) {
    console.error('findUsuarioByEmail error:', error.message);
    return null;
  }
  return data as UsuarioRow | null;
}

export function usuarioToJwtPayload(u: UsuarioRow): JwtPayload {
  return {
    sub: u.id,
    email: u.email,
    rol: u.rol,
    vendedor_key: u.vendedor_key,
    cod_vendedor: u.cod_vendedor,
    nombre: u.nombre
  };
}
