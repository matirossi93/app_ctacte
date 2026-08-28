import { createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { sb, TENANT_ID } from './supabase.js';

const BCRYPT_ROUNDS = 12;

const JWT_SECRET = process.env.JWT_SECRET || '';
const JWT_TTL_SECONDS = 8 * 60 * 60;

if (!JWT_SECRET) {
  // Fail-loud en startup. Sin secret válido, sesiones quedarían rotas silenciosamente.
  // En dev, exportá JWT_SECRET=<cualquier-string-largo> en tu .env local.
  console.error('FATAL: JWT_SECRET no está definida en el entorno. Abortando.');
  process.exit(1);
}

// `administrativo` y `socio` los agregó el panel único (28/08/2026). Acá sólo
// hacen falta para que el rol que viene de la base sea un valor conocido: los
// permisos de esta app se siguen decidiendo caso por caso, no por el tipo.
// Un `administrativo` NO filtra por cartera (ve a todos los clientes, como
// gerente) pero tampoco entra a lo que pide admin/gerente explícito.
export type Rol = 'admin' | 'socio' | 'gerente' | 'administrativo' | 'vendedor' | 'repartidor';

export interface JwtPayload {
  sub: string;              // usuario.id
  email: string;
  rol: Rol;
  vendedor_key?: string | null;
  cod_vendedor?: number | null;
  nombre?: string | null;
}

export function sha256hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Hashea un password con bcrypt (cost 12). Usar para nuevos usuarios y rehash. */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

/**
 * Verifica un password contra un hash almacenado. Soporta dos formatos:
 *  - bcrypt: empieza con $2a$, $2b$ o $2y$ → verify con bcrypt
 *  - sha256 legacy: 64 chars hex → compare directo con sha256hex(plain)
 *
 * Devuelve `{ ok, needsRehash }`. `needsRehash=true` indica que el hash es
 * legacy y conviene rehashear con bcrypt tras un login exitoso para migrar
 * gradualmente sin tocar a los usuarios.
 */
export async function verifyPassword(plain: string, hash: string): Promise<{ ok: boolean; needsRehash: boolean }> {
  if (!hash) return { ok: false, needsRehash: false };
  if (hash.startsWith('$2a$') || hash.startsWith('$2b$') || hash.startsWith('$2y$')) {
    const ok = await bcrypt.compare(plain, hash);
    return { ok, needsRehash: false };
  }
  // Fallback: sha256 hex legacy (64 chars). Comparación constant-time vía Buffer.
  const computed = sha256hex(plain);
  const ok = computed.length === hash.length && computed === hash;
  return { ok, needsRehash: ok };
}

function getSecret(): string {
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
  rol: Rol;
  vendedor_key: string | null;
  cod_vendedor: number | null;
  nombre: string | null;
  im_usuario: string | null;
  activo: boolean;
}

export async function findUsuarioByEmail(email: string): Promise<UsuarioRow | null> {
  const { data, error } = await sb()
    .from('usuarios')
    .select('id, email, password_hash, rol, vendedor_key, cod_vendedor, nombre, im_usuario, activo')
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

/** Middleware: exige JWT con rol admin o gerente. Requiere que requireJwt haya ya corrido. */
export function requireAdmin(req: any, res: any, next: any): void {
  if (!req.user) { res.status(401).json({ error: 'Requiere autenticación' }); return; }
  if (req.user.rol !== 'admin' && req.user.rol !== 'gerente') {
    res.status(403).json({ error: 'Requiere rol admin o gerente' }); return;
  }
  next();
}

export function usuarioToJwtPayload(u: UsuarioRow): JwtPayload {
  return {
    sub: u.id,
    email: u.email,
    rol: u.rol,
    vendedor_key: u.vendedor_key,
    cod_vendedor: u.cod_vendedor,
    nombre: u.nombre,
  };
}
