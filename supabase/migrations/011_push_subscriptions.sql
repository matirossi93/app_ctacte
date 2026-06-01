-- Migration 011 — Web Push: suscripciones del navegador + flag de notificación.
-- Idempotente.

-- ─── push_subscriptions: una fila por device/navegador ───────────────────────
create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  user_id uuid not null references usuarios(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  unique (endpoint)
);

create index if not exists push_subscriptions_user_idx
  on push_subscriptions (user_id);

alter table push_subscriptions enable row level security;
drop policy if exists push_subs_service_all on push_subscriptions;
create policy push_subs_service_all on push_subscriptions
  for all to service_role using (true) with check (true);

-- ─── push_notificado_at en vendor_activity ──────────────────────────────────
-- Flag para que el cron de Web Push no re-envíe la misma promesa cada minuto.
-- Reset implícito: si el usuario edita fecha_promesa o hora_promesa, no
-- limpiamos esto desde SQL — confiamos en que actualizar la promesa cambia el
-- timing y el cron evalúa con el nuevo `fecha_promesa+hora_promesa`. Si querés
-- forzar reenvío manual: UPDATE vendor_activity SET push_notificado_at = NULL.
alter table vendor_activity
  add column if not exists push_notificado_at timestamptz;
