-- Migration 016 — Objetivos por producto: FAMILIAS (varios artículos → un objetivo).
--
-- La migración 015 modelaba 1 artículo = 1 objetivo. Mati necesita agrupar
-- variedades bajo una misma meta: "Barras Monkey" = 20 cajas que se cumplen
-- vendiendo CUALQUIERA de las 5 variedades (todas suman al mismo objetivo), o
-- los fraccionados de cereales (2 artículos de la misma familia). Ahora el
-- objetivo tiene nombre e id propios (cabecera) y los artículos son filas hijas
-- que suman al mismo target_unidades. La comisión especial, si la lleva, rige
-- para TODOS los artículos de la familia (decisión Mati 13/07).
--
-- Idempotente. Migra los objetivos de la 015 sin pérdida: cada uno → familia de
-- 1 artículo, con id determinístico para que re-correr esta migración no duplique.

create table if not exists product_goal_grupos (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  year int not null,
  month int not null check (month between 1 and 12),
  cod_vendedor int not null,
  nombre text not null,
  target_unidades numeric(12,2) not null check (target_unidades > 0),
  -- % de comisión especial (fracción: 0.05 = 5%). NULL = rige la regla normal.
  -- Tope 20% como red de seguridad contra typos (0.5 tecleado como "50%").
  comision_pct numeric(6,4) check (comision_pct is null or (comision_pct > 0 and comision_pct <= 0.2)),
  set_by uuid references usuarios(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists product_goal_grupos_vendedor_idx
  on product_goal_grupos (tenant_id, cod_vendedor, year, month);

create table if not exists product_goal_articulos (
  grupo_id uuid not null references product_goal_grupos(id) on delete cascade,
  cod_articulo int not null,
  -- Descripción del artículo al crear el objetivo (display; la fuente de verdad
  -- sigue siendo el catálogo IM).
  descripcion text,
  primary key (grupo_id, cod_articulo)
);

-- Un artículo no puede estar en 2 objetivos del mismo (vendedor, mes): contaría
-- su avance dos veces. Se valida en el endpoint (la restricción cruza las dos
-- tablas); este índice acelera esa verificación.
create index if not exists product_goal_articulos_cod_idx
  on product_goal_articulos (cod_articulo);

alter table product_goal_grupos enable row level security;
drop policy if exists product_goal_grupos_service_all on product_goal_grupos;
create policy product_goal_grupos_service_all on product_goal_grupos
  for all to service_role using (true) with check (true);

alter table product_goal_articulos enable row level security;
drop policy if exists product_goal_articulos_service_all on product_goal_articulos;
create policy product_goal_articulos_service_all on product_goal_articulos
  for all to service_role using (true) with check (true);

-- Autocontenida: recrea el helper por si esta base no corrió la migración 001
-- completa (create or replace = inofensivo si ya existe).
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists product_goal_grupos_updated_at on product_goal_grupos;
create trigger product_goal_grupos_updated_at before update on product_goal_grupos
  for each row execute function set_updated_at();

-- ── Migración de datos: objetivos de la 015 (1 artículo) → familias de 1 ──────
-- Id determinístico por (tenant,year,month,vendedor,artículo): re-correr la
-- migración es un no-op (ON CONFLICT no duplica). Solo corre si la 015 existe.
do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'product_goals') then

    insert into product_goal_grupos (id, tenant_id, year, month, cod_vendedor, nombre, target_unidades, comision_pct, set_by)
    select
      md5(tenant_id::text || '|' || year || '|' || month || '|' || cod_vendedor || '|' || cod_articulo)::uuid,
      tenant_id, year, month, cod_vendedor,
      coalesce(nullif(descripcion, ''), 'Artículo ' || cod_articulo),
      target_unidades, comision_pct, set_by
    from product_goals
    on conflict (id) do nothing;

    insert into product_goal_articulos (grupo_id, cod_articulo, descripcion)
    select
      md5(tenant_id::text || '|' || year || '|' || month || '|' || cod_vendedor || '|' || cod_articulo)::uuid,
      cod_articulo, descripcion
    from product_goals
    on conflict (grupo_id, cod_articulo) do nothing;

  end if;
end $$;

-- product_goals (mig 015) queda como respaldo de solo-lectura de esta tanda: el
-- código ya no la lee ni escribe. Se puede dropear en una migración futura una
-- vez confirmadas las familias en producción.
