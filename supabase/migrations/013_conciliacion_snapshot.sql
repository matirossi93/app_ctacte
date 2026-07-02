-- Migration 013 — Conciliación: snapshot diario de la cta cte de clientes IM.
-- Idempotente.
--
-- El reporte comprob_pendientes_clientes de InfoManager es una foto de HOY:
-- un corte al 30/06 corrido el 05/07 no se puede reconstruir (los pagos
-- posteriores ya bajaron los saldos). Un cron diario (~23:50 ART) guarda acá
-- las filas crudas del reporte por empresa, para que el "Cruce carpeta" del
-- panel Conciliación pueda cruzar contra un corte EXACTO a esa fecha.
-- Tamaño: ~300KB/día por empresa (637 filas jsonb) — aceptable.

create table if not exists conciliacion_snapshot (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  cod_empresa int not null,
  fecha date not null,
  rows jsonb not null,             -- filas crudas del reporte IM (tal cual)
  -- Maestro cliente→vendedor DEL MOMENTO de la foto: {cod: {cod_vendedor, nombre}}.
  -- Sin esto, un cliente reasignado de vendedor entre el corte y la corrida del
  -- cruce aparecería como faltante falso en un vendedor y sobrante en otro.
  maestro jsonb,
  n_rows int not null default 0,
  created_at timestamptz not null default now(),
  unique (tenant_id, cod_empresa, fecha)
);

create index if not exists conciliacion_snapshot_fecha_idx
  on conciliacion_snapshot (cod_empresa, fecha desc);

alter table conciliacion_snapshot enable row level security;
drop policy if exists conciliacion_snapshot_service_all on conciliacion_snapshot;
create policy conciliacion_snapshot_service_all on conciliacion_snapshot
  for all to service_role using (true) with check (true);
