import type { Request, Response } from 'express';
import { sb, TENANT_ID, hasSupabase } from './supabase.js';
import { sha256hex, type JwtPayload } from './auth.js';

type Rol = 'admin' | 'gerente' | 'vendedor';
const VALID_ROLES: Rol[] = ['admin', 'gerente', 'vendedor'];

function requireSb(res: Response): boolean {
  if (!hasSupabase()) {
    res.status(500).json({ error: 'Supabase no configurado' });
    return false;
  }
  return true;
}

/** GET /api/usuarios — lista todos (admin/gerente). */
export async function listUsuarios(_req: Request & { user?: JwtPayload }, res: Response) {
  try {
    if (!requireSb(res)) return;
    const { data, error } = await sb().from('usuarios')
      .select('id, email, nombre, rol, cod_vendedor, vendedor_key, activo, created_at')
      .eq('tenant_id', TENANT_ID)
      .order('activo', { ascending: false })
      .order('rol', { ascending: true })
      .order('nombre', { ascending: true });
    if (error) { res.status(500).json({ error: error.message }); return; }
    res.json({ ok: true, items: data ?? [] });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/** POST /api/usuarios — crea usuario (admin/gerente). */
export async function createUsuario(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    if (!requireSb(res)) return;
    const b = req.body ?? {};
    const email = String(b.email ?? '').trim().toLowerCase();
    const password = String(b.password ?? '');
    const nombre = String(b.nombre ?? '').trim() || null;
    const rol = String(b.rol ?? '') as Rol;
    const cod_vendedor = b.cod_vendedor != null && b.cod_vendedor !== '' ? Number(b.cod_vendedor) : null;
    const vendedor_key = b.vendedor_key ? String(b.vendedor_key).trim().toLowerCase() : null;

    if (!email || !email.includes('@')) { res.status(400).json({ error: 'email inválido' }); return; }
    if (!password || password.length < 6) { res.status(400).json({ error: 'password mínimo 6 chars' }); return; }
    if (!VALID_ROLES.includes(rol)) { res.status(400).json({ error: 'rol inválido' }); return; }
    if (rol === 'vendedor' && cod_vendedor == null) {
      res.status(400).json({ error: 'vendedor requiere cod_vendedor' }); return;
    }

    const password_hash = sha256hex(password);
    const { data, error } = await sb().from('usuarios').insert({
      tenant_id: TENANT_ID,
      email, password_hash, nombre, rol, cod_vendedor, vendedor_key,
      activo: true,
    }).select('id, email, nombre, rol, cod_vendedor, vendedor_key, activo, created_at').single();
    if (error) {
      if (error.code === '23505') { res.status(409).json({ error: 'Email ya existe' }); return; }
      res.status(500).json({ error: error.message }); return;
    }
    res.json({ ok: true, usuario: data });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/** PUT /api/usuarios/:id — actualiza nombre, rol, cod_vendedor, vendedor_key, activo (admin). */
export async function updateUsuario(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    if (!requireSb(res)) return;
    const id = String(req.params.id ?? '');
    if (!id) { res.status(400).json({ error: 'id requerido' }); return; }
    const b = req.body ?? {};
    const patch: any = {};
    if (b.nombre !== undefined) patch.nombre = String(b.nombre ?? '').trim() || null;
    if (b.rol !== undefined) {
      if (!VALID_ROLES.includes(b.rol)) { res.status(400).json({ error: 'rol inválido' }); return; }
      patch.rol = b.rol;
    }
    if (b.cod_vendedor !== undefined) {
      patch.cod_vendedor = b.cod_vendedor == null || b.cod_vendedor === '' ? null : Number(b.cod_vendedor);
    }
    if (b.vendedor_key !== undefined) {
      patch.vendedor_key = b.vendedor_key ? String(b.vendedor_key).trim().toLowerCase() : null;
    }
    if (b.activo !== undefined) patch.activo = !!b.activo;
    if (Object.keys(patch).length === 0) { res.status(400).json({ error: 'nada que actualizar' }); return; }

    const { data, error } = await sb().from('usuarios').update(patch)
      .eq('tenant_id', TENANT_ID).eq('id', id)
      .select('id, email, nombre, rol, cod_vendedor, vendedor_key, activo, created_at').single();
    if (error) { res.status(500).json({ error: error.message }); return; }
    res.json({ ok: true, usuario: data });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/** DELETE /api/usuarios/:id — soft delete (activo=false). Admin/gerente. */
export async function deleteUsuario(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    if (!requireSb(res)) return;
    const id = String(req.params.id ?? '');
    if (!id) { res.status(400).json({ error: 'id requerido' }); return; }
    if (req.user?.sub === id) { res.status(400).json({ error: 'No podés desactivar tu propia cuenta' }); return; }
    const { error } = await sb().from('usuarios').update({ activo: false })
      .eq('tenant_id', TENANT_ID).eq('id', id);
    if (error) { res.status(500).json({ error: error.message }); return; }
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/**
 * POST /api/usuarios/change-password
 * Body:
 *  - { current_password, new_password }   → cambia la propia (cualquier user)
 *  - { user_id, new_password }            → reset admin/gerente (sin current)
 */
export async function changePassword(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    if (!requireSb(res)) return;
    const user = req.user!;
    const b = req.body ?? {};
    const newPass = String(b.new_password ?? '');
    if (!newPass || newPass.length < 6) { res.status(400).json({ error: 'new_password mínimo 6 chars' }); return; }

    const targetId = b.user_id ? String(b.user_id) : user.sub;
    const isAdminReset = !!b.user_id && targetId !== user.sub;

    if (isAdminReset) {
      if (user.rol !== 'admin' && user.rol !== 'gerente') {
        res.status(403).json({ error: 'Solo admin/gerente puede resetear passwords de otros' }); return;
      }
    } else {
      // Self-change: requiere current_password y debe coincidir con el hash.
      const current = String(b.current_password ?? '');
      if (!current) { res.status(400).json({ error: 'current_password requerido' }); return; }
      const { data: u } = await sb().from('usuarios')
        .select('password_hash')
        .eq('tenant_id', TENANT_ID).eq('id', targetId).maybeSingle();
      if (!u) { res.status(404).json({ error: 'Usuario no encontrado' }); return; }
      if (sha256hex(current) !== (u as any).password_hash) {
        res.status(401).json({ error: 'Contraseña actual incorrecta' }); return;
      }
    }

    const { error } = await sb().from('usuarios').update({ password_hash: sha256hex(newPass) })
      .eq('tenant_id', TENANT_ID).eq('id', targetId);
    if (error) { res.status(500).json({ error: error.message }); return; }
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}
