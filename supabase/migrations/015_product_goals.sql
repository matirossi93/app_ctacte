-- Migration 015 — Objetivos por producto (Feature B, 10/07/2026). Idempotente.
--
-- Mati fija a cada vendedor cuántas UNIDADES (bolsas) de un producto estancado
-- tiene que vender en el mes (decisión 10/07: unidades × vendedor, no $).
-- Opcionalmente el producto lleva una comisión ESPECIAL ese mes (comision_pct)
-- que pisa la regla hardcodeada de comisionesRules.ts SOLO para ese artículo y
-- ese vendedor — incentivo para mover lo estancado. El avance (unidades
-- vendidas) NO se persiste: se calcula en vivo desde los renglones de venta de
-- InfoManager (snapshotCache), igual que las comisiones.

create table if not exists product_goals (
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  year int not null,
  month int not null check (month between 1 and 12),
  cod_vendedor int not null,
  cod_articulo int not null,
  target_unidades numeric(12,2) not null check (target_unidades > 0),
  -- % de comisión especial (fracción: 0.05 = 5%). NULL = rige la regla normal.
  -- Tope 20% como red de seguridad contra typos (0.5 tecleado como "50%").
  comision_pct numeric(6,4) check (comision_pct is null or (comision_pct > 0 and comision_pct <= 0.2)),
  -- Descripción del artículo al momento de crear el objetivo (display; la
  -- fuente de verdad sigue siendo el catálogo IM).
  descripcion text,
  set_by uuid references usuarios(id),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, year, month, cod_vendedor, cod_articulo)
);

create index if not exists product_goals_vendedor_idx on product_goals (tenant_id, cod_vendedor, year, month);

alter table product_goals enable row level security;
drop policy if exists product_goals_service_all on product_goals;
create policy product_goals_service_all on product_goals
  for all to service_role using (true) with check (true);

-- Autocontenida: recrea el helper por si esta base no corrió la migración 001
-- completa (create or replace = inofensivo si ya existe).
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists product_goals_updated_at on product_goals;
create trigger product_goals_updated_at before update on product_goals
  for each row execute function set_updated_at();
