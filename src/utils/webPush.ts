/**
 * Helper para registrar Service Worker y suscribir el navegador a Web Push.
 *
 * Idempotente. Si el usuario denegó permiso, no re-pregunta. Si el server no
 * tiene VAPID configurado, devuelve 'not-configured' sin error visible.
 */

import { authHeaders } from './auth';

const SW_URL = '/sw.js';

export type PushStatus =
  | 'unsupported'
  | 'permission-denied'
  | 'permission-default'
  | 'not-configured'
  | 'subscribed'
  | 'error';

export function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register(SW_URL);
  } catch (err) {
    console.warn('[push] SW register fail:', err);
    return null;
  }
}

// Construimos ArrayBuffer explícito (TS 5.9 distingue de SharedArrayBuffer).
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - base64.length % 4) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const buf = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Registra SW, pide permiso si está en 'default', suscribe y manda al server.
 * Si el usuario ya denegó, no reintentamos (cooldown de los browsers).
 */
export async function ensurePushSubscription(): Promise<PushStatus> {
  if (!isPushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'permission-denied';

  const reg = await registerServiceWorker();
  if (!reg) return 'error';

  if (Notification.permission === 'default') {
    const result = await Notification.requestPermission();
    if (result !== 'granted') {
      return result === 'denied' ? 'permission-denied' : 'permission-default';
    }
  }

  try {
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const r = await fetch('/api/push/vapid-public-key', { headers: authHeaders() });
      if (!r.ok) return 'not-configured';
      const j = await r.json();
      if (!j.ok || !j.publicKey) return 'not-configured';
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(j.publicKey),
      });
    }
    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    });
    if (!res.ok) return 'error';
    return 'subscribed';
  } catch (err) {
    console.warn('[push] ensurePushSubscription fail:', err);
    return 'error';
  }
}

export async function getPushStatus(): Promise<{
  supported: boolean;
  permission: 'granted' | 'denied' | 'default' | 'unsupported';
  subscribed: boolean;
}> {
  if (!isPushSupported()) return { supported: false, permission: 'unsupported', subscribed: false };
  const permission = Notification.permission as 'granted' | 'denied' | 'default';
  let subscribed = false;
  const reg = await navigator.serviceWorker.getRegistration(SW_URL);
  if (reg) {
    const sub = await reg.pushManager.getSubscription();
    subscribed = !!sub;
  }
  return { supported: true, permission, subscribed };
}

export async function unsubscribePushDevice(): Promise<boolean> {
  if (!isPushSupported()) return false;
  const reg = await navigator.serviceWorker.getRegistration(SW_URL);
  if (!reg) return false;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return true;
  try {
    await fetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
  } catch { /* ignore */ }
  await sub.unsubscribe();
  return true;
}
