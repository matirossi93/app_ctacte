import type { Request, Response } from 'express';
import { puedeTocarActividadAjena } from './permisos.js';
import { sb, TENANT_ID, hasSupabase } from './supabase.js';
import type { JwtPayload } from './auth.js';

export type ActivityTipo = 'nota' | 'llamada' | 'wa' | 'promesa' | 'pago' | 'visita';
const TIPOS: ActivityTipo[] = ['nota', 'llamada', 'wa', 'promesa', 'pago', 'visita'];

/**
 * Normaliza una hora a formato "HH:MM" (postgres TIME).
 * Acepta "HH:MM", "HH:MM:SS", o "" / null → null.
 * Devuelve `null` si entrada vacía/nula, string normalizado si válido,
 * o objeto con error si inválido.
 */
function parseHoraPromesa(input: unknown): string | null | { error: string } {
  if (input == null || input === '') return null;
  const s = String(input).trim();
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s);
  if (!m) return { error: `hora_promesa inválida: "${s}". Usá HH:MM (24h).` };
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    return { error: `hora_promesa fuera de rango: ${s}` };
  }
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** GET /api/activity?tipo=&cod_cliente=&cod_vendedor=&limit=&offset= */
export async function listActivity(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    if (!hasSupabase()) { res.status(500).json({ error: 'Supabase no configurado' }); return; }
    const user = req.user!;
    let q = sb().from('vendor_activity').select('*').eq('tenant_id', TENANT_ID);

    if (user.rol === 'vendedor') {
      if (user.cod_vendedor == null) { res.json({ ok: true, items: [] }); return; }
      q = q.eq('cod_vendedor', user.cod_vendedor);
    } else if (req.query.cod_vendedor) {
      q = q.eq('cod_vendedor', Number(req.query.cod_vendedor));
    } else if (req.query.cods) {
      const parsed = String(req.query.cods)
        .split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0);
      if (parsed.length) q = q.in('cod_vendedor', parsed);
    }

    if (req.query.tipo) q = q.eq('tipo', String(req.query.tipo));
    if (req.query.cod_cliente) q = q.eq('cod_cliente', Number(req.query.cod_cliente));

    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Number(req.query.offset) || 0;
    q = q.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

    const { data, error } = await q;
    if (error) { res.status(500).json({ error: error.message }); return; }

    // Enriquecer con email del creador (nombre para display)
    const ids = Array.from(new Set((data ?? []).map((r: any) => r.created_by).filter(Boolean)));
    let creadoresMap = new Map<string, { email: string; nombre: string | null }>();
    if (ids.length) {
      const { data: us } = await sb().from('usuarios').select('id, email, nombre').in('id', ids);
      (us ?? []).forEach((u: any) => creadoresMap.set(u.id, { email: u.email, nombre: u.nombre }));
    }

    const items = (data ?? []).map((r: any) => ({
      ...r,
      created_by_email: r.created_by ? creadoresMap.get(r.created_by)?.email ?? null : null,
      created_by_nombre: r.created_by ? creadoresMap.get(r.created_by)?.nombre ?? null : null,
    }));

    res.json({ ok: true, items });
  } catch (err: any) {
    console.error('listActivity error:', err);
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/** POST /api/activity { tipo, cod_cliente?, contenido?, monto?, fecha_promesa?, cod_vendedor? } */
export async function createActivity(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    if (!hasSupabase()) { res.status(500).json({ error: 'Supabase no configurado' }); return; }
    const user = req.user!;
    const body = req.body ?? {};

    const tipo = String(body.tipo);
    if (!TIPOS.includes(tipo as ActivityTipo)) {
      res.status(400).json({ error: `tipo inválido: ${tipo}. Válidos: ${TIPOS.join(', ')}` });
      return;
    }

    // cod_vendedor: vendedor usa el suyo, admin/gerente puede elegir
    let codVendedor: number;
    if (user.rol === 'vendedor') {
      if (user.cod_vendedor == null) {
        res.status(400).json({ error: 'Tu usuario no tiene cod_vendedor asignado' });
        return;
      }
      codVendedor = user.cod_vendedor;
    } else {
      codVendedor = Number(body.cod_vendedor) || 0;
      if (!codVendedor) {
        res.status(400).json({ error: 'cod_vendedor obligatorio para admin/gerente' });
        return;
      }
    }

    const horaParsed = parseHoraPromesa(body.hora_promesa);
    if (horaParsed && typeof horaParsed === 'object' && 'error' in horaParsed) {
      res.status(400).json({ error: horaParsed.error });
      return;
    }

    const row: any = {
      tenant_id: TENANT_ID,
      cod_vendedor: codVendedor,
      cod_cliente: body.cod_cliente ? Number(body.cod_cliente) : null,
      tipo,
      contenido: body.contenido ?? null,
      monto: body.monto != null ? Number(body.monto) : null,
      fecha_promesa: body.fecha_promesa ?? null,
      hora_promesa: horaParsed,
      created_by: user.sub,
    };

    const { data, error } = await sb().from('vendor_activity').insert(row).select().single();
    if (error) { res.status(500).json({ error: error.message }); return; }
    res.json({ ok: true, item: data });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/** PUT /api/activity/:id — edita (solo propia o admin/gerente) */
export async function updateActivity(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    if (!hasSupabase()) { res.status(500).json({ error: 'Supabase no configurado' }); return; }
    const user = req.user!;
    const body = req.body ?? {};

    const { data: row } = await sb()
      .from('vendor_activity')
      .select('created_by, cod_vendedor')
      .eq('id', req.params.id)
      .eq('tenant_id', TENANT_ID)
      .maybeSingle();
    if (!row) { res.status(404).json({ error: 'No encontrado' }); return; }
    // 🪤 El comentario de esta función decía "solo propia o admin" y el código dejaba pasar a
    // TODO el que no fuera vendedor: socio, encargado y administrativo editarban la promesa de
    // pago de cualquiera. La regla, ahora en lista blanca, vive en permisos.ts.
    if (!puedeTocarActividadAjena(user.rol) && row.created_by !== user.sub) {
      res.status(403).json({ error: 'No podés editar actividad de otro usuario' });
      return;
    }

    const patch: Record<string, any> = {};
    if (body.tipo !== undefined) {
      if (!TIPOS.includes(body.tipo)) { res.status(400).json({ error: `tipo inválido: ${body.tipo}` }); return; }
      patch.tipo = body.tipo;
    }
    if (body.contenido !== undefined) patch.contenido = body.contenido || null;
    if (body.monto !== undefined) patch.monto = body.monto != null && body.monto !== '' ? Number(body.monto) : null;
    // Editar fecha/hora de la promesa = se quiere re-disparar el push con el
    // nuevo timing. Reseteamos push_notificado_at para que el cron de Web Push
    // vuelva a evaluar la fila. Sin esto, si el usuario corrige la hora después
    // de que el cron ya disparó (a un device viejo, o por error), el push nunca
    // se reenvía al timing nuevo.
    let resetPushFlag = false;
    if (body.fecha_promesa !== undefined) {
      patch.fecha_promesa = body.fecha_promesa || null;
      resetPushFlag = true;
    }
    if (body.hora_promesa !== undefined) {
      const h = parseHoraPromesa(body.hora_promesa);
      if (h && typeof h === 'object' && 'error' in h) {
        res.status(400).json({ error: h.error });
        return;
      }
      patch.hora_promesa = h;
      resetPushFlag = true;
    }
    if (resetPushFlag) patch.push_notificado_at = null;
    if (body.cod_cliente !== undefined) patch.cod_cliente = body.cod_cliente ? Number(body.cod_cliente) : null;
    // cod_vendedor sólo lo cambia admin/gerente.
    if (body.cod_vendedor !== undefined && user.rol !== 'vendedor') {
      patch.cod_vendedor = Number(body.cod_vendedor) || row.cod_vendedor;
    }

    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: 'Nada para actualizar' });
      return;
    }

    const { data, error } = await sb()
      .from('vendor_activity')
      .update(patch)
      .eq('id', req.params.id)
      .eq('tenant_id', TENANT_ID)
      .select()
      .single();
    if (error) { res.status(500).json({ error: error.message }); return; }
    res.json({ ok: true, item: data });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/**
 * GET /api/notificaciones
 *
 * Devuelve las promesas/recordatorios pendientes del vendedor (o todos los
 * vendedores si admin/gerente). Ventana: fecha_promesa entre hoy-14d y
 * hoy+7d, así cubrimos vencidas recientes + próximas.
 *
 * Cada notificación viene con:
 *   - vencida: true si fecha_promesa < hoy
 *   - dias_relativos: signo positivo = vence en N días; negativo = vencida hace |N| días
 */
export async function listNotificaciones(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    if (!hasSupabase()) { res.json({ ok: true, items: [], alertas: [] }); return; }
    const user = req.user!;

    const today = new Date();
    const ymd = (d: Date) => d.toISOString().slice(0, 10);
    const desde = ymd(new Date(today.getTime() - 14 * 24 * 60 * 60 * 1000));
    const hasta = ymd(new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000));
    const todayStr = ymd(today);

    let q = sb().from('vendor_activity')
      .select('id, cod_vendedor, cod_cliente, tipo, contenido, monto, fecha_promesa, hora_promesa, created_at')
      .eq('tenant_id', TENANT_ID)
      .eq('tipo', 'promesa')
      .not('fecha_promesa', 'is', null)
      .gte('fecha_promesa', desde)
      .lte('fecha_promesa', hasta);

    if (user.rol === 'vendedor') {
      if (user.cod_vendedor == null) { res.json({ ok: true, items: [], alertas: [] }); return; }
      q = q.eq('cod_vendedor', user.cod_vendedor);
    }

    // Orden secundario por hora_promesa (NULLs al final del día naturalmente).
    q = q.order('fecha_promesa', { ascending: true }).order('hora_promesa', { ascending: true, nullsFirst: false });
    const { data, error } = await q;
    if (error) { res.status(500).json({ error: error.message }); return; }

    const items = (data ?? []).map((r: any) => {
      const fp: string = r.fecha_promesa;
      const fpMs = Date.parse(fp + 'T00:00:00Z');
      const todayMs = Date.parse(todayStr + 'T00:00:00Z');
      const diasRel = Math.round((fpMs - todayMs) / (1000 * 60 * 60 * 24));
      return { ...r, vencida: diasRel < 0, dias_relativos: diasRel };
    });

    // Alertas (cliente / producto en abandono): solo para vendedores con
    // cod_vendedor asignado. Admin/gerente no las ve en su campana — verían
    // alertas de todos los vendedores, demasiado ruido.
    let alertas: any[] = [];
    if (user.rol === 'vendedor' && user.cod_vendedor != null) {
      try {
        const { calcularAlertasVendedor } = await import('./notificacionesAlertas.js');
        alertas = await calcularAlertasVendedor(user.cod_vendedor);
      } catch (e: any) {
        console.warn('[listNotificaciones] alertas fail:', e?.message ?? e);
      }
    }

    res.json({ ok: true, items, alertas });
  } catch (err: any) {
    console.error('listNotificaciones error:', err);
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/** DELETE /api/activity/:id — borra (solo propia o admin) */
export async function deleteActivity(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const user = req.user!;
    const { data: row } = await sb().from('vendor_activity').select('created_by').eq('id', req.params.id).eq('tenant_id', TENANT_ID).maybeSingle();
    if (!row) { res.status(404).json({ error: 'No encontrado' }); return; }
    // 🪤 El comentario de esta función decía "solo propia o admin" y el código dejaba pasar a
    // TODO el que no fuera vendedor: socio, encargado y administrativo borrarban la promesa de
    // pago de cualquiera. La regla, ahora en lista blanca, vive en permisos.ts.
    if (!puedeTocarActividadAjena(user.rol) && row.created_by !== user.sub) {
      res.status(403).json({ error: 'No podés borrar actividad de otro usuario' });
      return;
    }
    const { error } = await sb().from('vendor_activity').delete().eq('id', req.params.id).eq('tenant_id', TENANT_ID);
    if (error) { res.status(500).json({ error: error.message }); return; }
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}
