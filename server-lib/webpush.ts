/**
 * Web Push: VAPID + envío + handlers HTTP + cron que dispara recordatorios.
 *
 * Flujo:
 *   1. Admin genera VAPID keys (`npx web-push generate-vapid-keys`) y las
 *      setea en .env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT).
 *   2. El cliente (browser) pide la PUBLIC key, suscribe el navegador a su
 *      push service y manda {endpoint,p256dh,auth} a POST /api/push/subscribe.
 *   3. Cron 1 min: busca promesas vencidas (fecha+hora <= now) con
 *      push_notificado_at IS NULL, manda push, marca el flag.
 *
 * Si VAPID_* no están en env: los endpoints /api/push/* responden enabled:false
 * pero la app sigue funcionando con la campana in-app (que es la primaria).
 */

import webpush from 'web-push';
import type { Request, Response } from 'express';
import { sb, TENANT_ID, hasSupabase } from './supabase.js';
import type { JwtPayload } from './auth.js';

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:matias@semilleroelmanantial.com.ar';

let vapidConfigured = false;
export function isWebPushEnabled(): boolean {
  if (vapidConfigured) return true;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    vapidConfigured = true;
    return true;
  } catch (err: any) {
    console.error('[webpush] setVapidDetails falló:', err?.message);
    return false;
  }
}

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  tag?: string;
  url?: string;
  data?: Record<string, any>;
}

/**
 * Manda push a un usuario, iterando sus suscripciones (un user puede tener
 * varios devices). Push services devuelven 410/404 si la sub está muerta:
 * la borramos para no acumular zombies.
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<{ sent: number; failed: number; removed: number }> {
  if (!isWebPushEnabled() || !hasSupabase()) return { sent: 0, failed: 0, removed: 0 };
  const { data: subs } = await sb()
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('tenant_id', TENANT_ID)
    .eq('user_id', userId);
  if (!subs?.length) return { sent: 0, failed: 0, removed: 0 };

  const json = JSON.stringify(payload);
  let sent = 0, failed = 0, removed = 0;

  await Promise.all(subs.map(async (s: any) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        json,
        { TTL: 24 * 3600 }
      );
      sent++;
      await sb().from('push_subscriptions')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', s.id);
    } catch (err: any) {
      const status = err?.statusCode || 0;
      if (status === 404 || status === 410) {
        await sb().from('push_subscriptions').delete().eq('id', s.id);
        removed++;
      } else {
        console.warn(`[webpush] fallo a ${s.endpoint.slice(0, 60)}…: ${err?.message} (${status})`);
        failed++;
      }
    }
  }));

  return { sent, failed, removed };
}

// ─── HTTP handlers ─────────────────────────────────────────────────────────

/** GET /api/push/vapid-public-key — pública para el frontend al suscribir. */
export function getVapidPublicKeyHandler(_req: Request, res: Response): void {
  if (!isWebPushEnabled()) {
    res.json({ ok: false, enabled: false, error: 'Web Push no configurado' });
    return;
  }
  res.json({ ok: true, enabled: true, publicKey: VAPID_PUBLIC_KEY });
}

/** POST /api/push/subscribe — guarda suscripción upsert por endpoint. */
export async function subscribePush(req: Request & { user?: JwtPayload }, res: Response): Promise<void> {
  try {
    if (!hasSupabase()) { res.status(500).json({ error: 'Supabase no configurado' }); return; }
    if (!isWebPushEnabled()) { res.status(503).json({ error: 'Web Push no configurado' }); return; }
    const user = req.user!;
    const sub = req.body?.subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      res.status(400).json({ error: 'subscription inválida (falta endpoint/keys)' });
      return;
    }
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 240);
    const { data, error } = await sb()
      .from('push_subscriptions')
      .upsert({
        tenant_id: TENANT_ID,
        user_id: user.sub,
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        user_agent: userAgent,
        last_used_at: new Date().toISOString(),
      }, { onConflict: 'endpoint' })
      .select('id')
      .single();
    if (error) { res.status(500).json({ error: error.message }); return; }
    res.json({ ok: true, id: data?.id });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/** POST /api/push/unsubscribe — borra suscripción (cerrar sesión, opt-out). */
export async function unsubscribePush(req: Request & { user?: JwtPayload }, res: Response): Promise<void> {
  try {
    if (!hasSupabase()) { res.status(500).json({ error: 'Supabase no configurado' }); return; }
    const user = req.user!;
    const endpoint = String(req.body?.endpoint || '');
    if (!endpoint) { res.status(400).json({ error: 'endpoint requerido' }); return; }
    await sb().from('push_subscriptions')
      .delete()
      .eq('user_id', user.sub)
      .eq('endpoint', endpoint);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/** POST /api/push/test — envía un push de prueba al usuario actual. */
export async function testPush(req: Request & { user?: JwtPayload }, res: Response): Promise<void> {
  try {
    const user = req.user!;
    const r = await sendPushToUser(user.sub, {
      title: '🌱 Semillero — Test',
      body: 'Si ves esto, tu device recibe avisos. Tap acá para abrir la app.',
      icon: '/icon-192.png',
      tag: 'test-' + Date.now(),
      url: '/',
    });
    res.json({ ok: r.sent > 0, ...r });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/**
 * POST /api/push/dispatch-now — admin-only. Dispara manualmente el worker del
 * cron de recordatorios y devuelve el resultado en línea para diagnóstico.
 * Sirve cuando hay sospecha de que el cron no está corriendo en EasyPanel
 * (idle, restart, etc.) y queremos verificar si la lógica responde.
 *
 * Bonus: agrega los IDs candidatos al response para que admin sepa exactamente
 * cuáles entraron en la evaluación (útil para depurar timing).
 */
export async function dispatchPushNow(req: Request & { user?: JwtPayload }, res: Response): Promise<void> {
  try {
    if (req.user?.rol !== 'admin' && req.user?.rol !== 'gerente') {
      res.status(403).json({ error: 'Requiere admin/gerente' });
      return;
    }
    const t0 = Date.now();
    const enabled = isWebPushEnabled();
    if (!enabled) {
      res.json({ ok: false, enabled: false, error: 'Web Push no configurado (faltan VAPID env)' });
      return;
    }
    const r = await dispararRecordatoriosPromesa();
    res.json({ ok: true, enabled: true, elapsedMs: Date.now() - t0, ...r });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/**
 * Cron worker — corre cada minuto. Busca promesas con fecha+hora <= now y
 * push_notificado_at IS NULL, manda push al vendedor asignado, marca flag.
 *
 * Sin hora: dispara una sola vez al inicio del día (00:00 local del día).
 * Para no spammear al usuario apenas se carga la app a la mañana, miramos
 * por lo menos las 8 AM como umbral mínimo. NULL hora_promesa → 09:00 default
 * (alineado con quick option "Mañana 9:00").
 *
 * Ventana: solo procesa promesas con fecha_promesa entre hoy y hoy+1d. Si una
 * promesa quedó atrás varios días sin push (cron caído), la marcamos como ya
 * notificada para evitar floods al volver a estar online.
 */
export async function dispararRecordatoriosPromesa(): Promise<{ candidatos: number; enviados: number; fallidos: number; sinSub: number; saltados: number }> {
  if (!hasSupabase()) return { candidatos: 0, enviados: 0, fallidos: 0, sinSub: 0, saltados: 0 };
  if (!isWebPushEnabled()) return { candidatos: 0, enviados: 0, fallidos: 0, sinSub: 0, saltados: 0 };

  const now = new Date();
  const todayYmd = now.toISOString().slice(0, 10);
  const yest = new Date(now.getTime() - 24 * 3600 * 1000).toISOString().slice(0, 10);

  // Traemos promesas de ayer (por si quedaron sin notificar tarde) y hoy con
  // push_notificado_at IS NULL. Filtramos en memoria por fecha+hora <= now.
  const { data: rows, error } = await sb()
    .from('vendor_activity')
    .select('id, cod_vendedor, cod_cliente, tipo, contenido, fecha_promesa, hora_promesa, push_notificado_at, created_by, asignado_por')
    .eq('tenant_id', TENANT_ID)
    .eq('tipo', 'promesa')
    .is('push_notificado_at', null)
    .gte('fecha_promesa', yest)
    .lte('fecha_promesa', todayYmd)
    .limit(200);
  if (error) {
    console.warn('[cron push] query fail:', error.message);
    return { candidatos: 0, enviados: 0, fallidos: 0, sinSub: 0, saltados: 0 };
  }

  const due: any[] = [];
  for (const r of rows ?? []) {
    if (!r.fecha_promesa) continue;
    // Hora default 09:00 si no se cargó hora específica.
    const hora = r.hora_promesa ?? '09:00';
    // Construimos timestamp en zona local del server (que en EasyPanel debería
    // estar en UTC; el cliente carga horas en su local). Como el server corre
    // en UTC y el usuario está en Tucumán (UTC-3), restamos 3h para alinear.
    // Construcción robusta: tratamos hora_promesa como hora local del usuario.
    // -03:00 = Argentina sin DST.
    const iso = `${r.fecha_promesa}T${hora.slice(0, 5)}:00-03:00`;
    const tsMs = Date.parse(iso);
    if (!isFinite(tsMs)) continue;
    if (tsMs <= now.getTime()) due.push(r);
  }
  if (!due.length) return { candidatos: 0, enviados: 0, fallidos: 0, sinSub: 0, saltados: 0 };

  // Resolver cod_vendedor → user.id (push_subscriptions es por user_id).
  const cods = Array.from(new Set(due.map(r => r.cod_vendedor)));
  const { data: usersByCodVend } = await sb()
    .from('usuarios')
    .select('id, cod_vendedor, nombre, email')
    .in('cod_vendedor', cods);
  const userByCod = new Map<number, { id: string; nombre: string | null; email: string }>();
  (usersByCodVend ?? []).forEach((u: any) => userByCod.set(u.cod_vendedor, { id: u.id, nombre: u.nombre, email: u.email }));

  let enviados = 0, fallidos = 0, sinSub = 0;
  for (const r of due) {
    // Reunir TODOS los user_id a notificar para esta promesa, sin duplicar:
    //   - El vendedor asignado (cod_vendedor → user.id).
    //   - El usuario que la creó (created_by) — clave cuando admin se carga una
    //     promesa "para acordarse" y la asigna a un vendedor que aún no tiene
    //     PWA instalada: sin esto, el push se va al vacío.
    //   - El admin que la asignó (asignado_por), si fue diferente al creador.
    // Set deduplica si el creador es el mismo vendedor asignado (caso vendedor
    // que se carga promesa para sí).
    const targets = new Set<string>();
    const vendedor = userByCod.get(r.cod_vendedor);
    if (vendedor?.id) targets.add(vendedor.id);
    if (r.created_by) targets.add(r.created_by);
    if (r.asignado_por) targets.add(r.asignado_por);
    if (targets.size === 0) { sinSub++; continue; }

    const body = (r.contenido || `Promesa pendiente${r.cod_cliente ? ` (cliente ${r.cod_cliente})` : ''}`).slice(0, 140);
    let sentForRow = 0, failedForRow = 0;
    for (const userId of targets) {
      const result = await sendPushToUser(userId, {
        title: '📌 Recordatorio Semillero',
        body,
        icon: '/icon-192.png',
        tag: `promesa-${r.id}`,
        url: '/',
        data: { activityId: r.id, codCliente: r.cod_cliente },
      });
      sentForRow += result.sent;
      failedForRow += result.failed;
    }
    if (sentForRow > 0) enviados++; else if (failedForRow > 0) fallidos++; else sinSub++;

    // Marcamos notificado incluso si no había sub: así el cron no re-evalúa cada
    // minuto la misma promesa. La campana in-app sigue cubriendo al usuario.
    await sb().from('vendor_activity')
      .update({ push_notificado_at: new Date().toISOString() })
      .eq('id', r.id);
  }

  return { candidatos: due.length, enviados, fallidos, sinSub, saltados: 0 };
}
