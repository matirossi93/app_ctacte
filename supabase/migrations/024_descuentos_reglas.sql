-- Migration 024 — Qué descuentos se pueden aplicar (27/08/2026). Idempotente.
--
-- Las reglas las dio Mati el 27/08. Son TOPES: poner menos está bien, pasarse no.
--
--   · CEREALES PARA DESAYUNO — 25% desde 1 unidad · 30% desde 5 · 35% desde 10 · 40% desde 30.
--     Los escalones cuentan el SURTIDO de la línea (2 anillos + 3 almohaditas = 5), y el
--     descuento vale ÚNICAMENTE en Lista 1: en las otras listas no se puede aplicar.
--   · LINEA FLECKY y LINEA GRAN CAMPEON — 2% sobre el mejor precio, o sea sólo si el
--     renglón YA está en la mejor lista a la que llega. Sólo con pago de contado; como el
--     sistema no sabe la condición de pago, se le avisa al vendedor.
--   · El resto de los artículos NO tiene descuentos habilitados (cualquier % se marca).
--
-- Mismo criterio que listas_reglas: la regla por artículo le gana a la del subrubro, y esto
-- es dato de negocio que cambia sin que cambie el código.

create table if not exists descuentos_reglas (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  nombre text not null,
  match_tipo text not null check (match_tipo in ('subrubro','articulo')),
  match_valor text not null,
  -- Desde qué cantidad aplica este tope.
  desde_cantidad numeric(12,3) not null default 1,
  -- 'linea' suma todos los renglones de la línea; 'articulo' mira sólo este renglón.
  ambito text not null default 'articulo' check (ambito in ('articulo','linea')),
  porcentaje_max numeric(5,2) not null check (porcentaje_max >= 0 and porcentaje_max <= 100),
  -- Si está, el descuento SÓLO vale en esa lista (los cereales, únicamente L1).
  requiere_lista int check (requiere_lista in (9,11,12,13,14,15)),
  -- Si es true, sólo vale cuando el renglón ya está en la mejor lista a la que llega.
  requiere_mejor_lista boolean not null default false,
  -- Condición que el sistema no puede verificar solo. Se le muestra al vendedor.
  aviso text,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Un tope por (a qué aplica, desde qué cantidad, en qué lista): el seed re-corre sin duplicar.
create unique index if not exists descuentos_reglas_target_uidx
  on descuentos_reglas (tenant_id, match_tipo, match_valor, desde_cantidad, coalesce(requiere_lista, -1));
create index if not exists descuentos_reglas_lookup_idx
  on descuentos_reglas (tenant_id, match_tipo, match_valor) where activo;

alter table descuentos_reglas enable row level security;
drop policy if exists descuentos_reglas_service_all on descuentos_reglas;
create policy descuentos_reglas_service_all on descuentos_reglas for all to service_role using (true) with check (true);

drop trigger if exists descuentos_reglas_updated_at on descuentos_reglas;
create trigger descuentos_reglas_updated_at before update on descuentos_reglas
  for each row execute function set_updated_at();

insert into descuentos_reglas
  (nombre, match_tipo, match_valor, desde_cantidad, ambito, porcentaje_max, requiere_lista, requiere_mejor_lista, aviso) values
  ('CEREALES PARA DESAYUNO', 'subrubro', 'Cereales para desayuno',  1, 'linea', 25, 12, false, null),
  ('CEREALES PARA DESAYUNO', 'subrubro', 'Cereales para desayuno',  5, 'linea', 30, 12, false, null),
  ('CEREALES PARA DESAYUNO', 'subrubro', 'Cereales para desayuno', 10, 'linea', 35, 12, false, null),
  ('CEREALES PARA DESAYUNO', 'subrubro', 'Cereales para desayuno', 30, 'linea', 40, 12, false, null),
  ('LINEA FLECKY',        'subrubro', 'Flecky',       1, 'articulo', 2, null, true, 'Este 2% sólo vale si el pedido se paga de CONTADO.'),
  ('LINEA GRAN CAMPEON',  'subrubro', 'Gran Campeon', 1, 'articulo', 2, null, true, 'Este 2% sólo vale si el pedido se paga de CONTADO.')
on conflict (tenant_id, match_tipo, match_valor, desde_cantidad, coalesce(requiere_lista, -1)) do update set
  nombre = excluded.nombre, ambito = excluded.ambito, porcentaje_max = excluded.porcentaje_max,
  requiere_mejor_lista = excluded.requiere_mejor_lista, aviso = excluded.aviso,
  activo = true, updated_at = now();
