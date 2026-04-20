-- Migration 002 — extensiones Objetivos (días hábiles + objetivo por cliente)
-- Idempotente.

-- ══════════════════════════════════════════════════════════════════════════════
-- 1. vendor_goals: agregar dias_habiles override manual
-- ══════════════════════════════════════════════════════════════════════════════
alter table vendor_goals add column if not exists dias_habiles int check (dias_habiles is null or (dias_habiles > 0 and dias_habiles <= 31));

-- ══════════════════════════════════════════════════════════════════════════════
-- 2. month_config — días hábiles globales por mes (compartido entre vendedores)
-- ══════════════════════════════════════════════════════════════════════════════
create table if not exists month_config (
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  year int not null,
  month int not null check (month between 1 and 12),
  dias_habiles int not null check (dias_habiles > 0 and dias_habiles <= 31),
  notas text,
  set_by uuid references usuarios(id),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, year, month)
);
alter table month_config enable row level security;
drop policy if exists month_config_service_all on month_config;
create policy month_config_service_all on month_config
  for all to service_role using (true) with check (true);

drop trigger if exists month_config_updated_at on month_config;
create trigger month_config_updated_at before update on month_config
  for each row execute function set_updated_at();

-- ══════════════════════════════════════════════════════════════════════════════
-- 3. client_operational — extender para objetivo por cliente del mes
-- ══════════════════════════════════════════════════════════════════════════════
alter table client_operational add column if not exists objetivo_mes numeric(14,2);
alter table client_operational add column if not exists fact_mes_pasado numeric(14,2);
alter table client_operational add column if not exists fact_prom_3m numeric(14,2);
alter table client_operational add column if not exists saldo_cta_cte numeric(14,2);
alter table client_operational add column if not exists objetivo_source text check (objetivo_source in ('sheet','manual','formula') or objetivo_source is null);
alter table client_operational add column if not exists objetivo_year int;
alter table client_operational add column if not exists objetivo_month int;

-- ══════════════════════════════════════════════════════════════════════════════
-- 4. sheet_import_log — historial de imports desde Google Sheets
-- ══════════════════════════════════════════════════════════════════════════════
create table if not exists sheet_import_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  sheet_id text not null,
  gid text,
  hoja text,
  year int,
  month int,
  rows_leidas int,
  rows_importadas int,
  rows_descartadas int,
  errores jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  imported_by uuid references usuarios(id)
);
create index if not exists sheet_import_log_idx on sheet_import_log (tenant_id, started_at desc);
alter table sheet_import_log enable row level security;
drop policy if exists sheet_import_log_service_all on sheet_import_log;
create policy sheet_import_log_service_all on sheet_import_log
  for all to service_role using (true) with check (true);
