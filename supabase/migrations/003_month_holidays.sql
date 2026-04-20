-- Migration 003 — Feriados por mes (calendario laboral argentino).
-- Idempotente.

alter table month_config
  add column if not exists holidays jsonb not null default '[]'::jsonb;

-- Validación: debe ser array de ints (días del mes 1..31)
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'month_config_holidays_chk'
  ) then
    alter table month_config add constraint month_config_holidays_chk
      check (jsonb_typeof(holidays) = 'array');
  end if;
end$$;
