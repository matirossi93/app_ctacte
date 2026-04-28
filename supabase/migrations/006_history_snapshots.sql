-- Migration 006 — Snapshots históricos de objetivos por cliente.
-- Idempotente.
--
-- Razón: client_operational guarda objetivos del MES EN CURSO únicamente.
-- Cuando se re-importa el Maestro del mes siguiente, los objetivos del mes
-- anterior se sobrescriben → no se puede consultar "¿cuál era el objetivo
-- de cli-X en marzo?" cuando estamos en mayo. Esta tabla preserva un
-- snapshot por (cliente, año, mes) cada vez que se importa Maestro.

create table if not exists client_objectives_history (
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  cod_cliente int not null,
  year int not null,
  month int not null check (month between 1 and 12),
  cod_vendedor int,
  objetivo_mes numeric(14,2),
  objetivo_source text check (objetivo_source in ('sheet','manual','formula')),
  fact_mes_pasado numeric(14,2),
  fact_prom_3m numeric(14,2),
  tipo_abc text,
  imported_by uuid references usuarios(id),
  created_at timestamptz not null default now(),
  primary key (tenant_id, cod_cliente, year, month)
);

create index if not exists client_objectives_history_year_month_idx
  on client_objectives_history (tenant_id, year, month);

alter table client_objectives_history enable row level security;
drop policy if exists client_objectives_history_service_all on client_objectives_history;
create policy client_objectives_history_service_all on client_objectives_history
  for all to service_role using (true) with check (true);
