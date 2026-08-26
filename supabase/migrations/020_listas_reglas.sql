-- Migration 020 — Reglas de acceso a lista de precios (26/08/2026). Idempotente.
--
-- El problema: los vendedores eligen la lista 1/2/3/4 producto por producto según la
-- cantidad, se equivocan, y facturación tiene que controlar renglón por renglón antes
-- de facturar. Para que el sistema avise, las condiciones tienen que estar escritas.
-- Esta tabla ES la planilla "CONDICIONES LISTA SEMILLERO" de Mati, en forma consultable.
--
-- MODELO: una fila por (a qué aplica, qué lista). La celda de la planilla se traduce a
-- condicion + umbral + unidad + ambito:
--
--   celda de la planilla                        -> condicion      umbral unidad ambito
--   "LIBRE" / "1 bolsa" / "1 unidad"            -> libre            -      -      -
--   "10 bultos promo general"                   -> promo_general    10   bulto  pedido
--   "30 unidades del mismo producto"            -> min              30   bulto  articulo
--   "5 misma linea" / "30 surtidas de la linea" -> min               5   bulto  linea
--   "a partir de 20 kilos"                      -> min              20   kg     articulo
--   "menos de 20 kilos"                         -> max              20   kg     articulo
--   (celda vacía)                               -> NO se inserta fila = esa lista no aplica
--
-- 🔑 Dos reglas del audio de Mati (26/08) que NO están en la planilla:
--   1. Las promociones se SUPERPONEN: la promo general habilita L2 para todo el pedido,
--      y encima cada producto puede subir a L3/L4 si cumple su propia condición.
--   2. Un artículo a granel de 20 kg o más cuenta como UN bulto (uno solo, no acumula)
--      para llegar a los 10 de la promo general.
--
-- El universo es CASA CENTRAL: lo que no matchea ninguna regla queda sin validar
-- (son artículos de las sucursales minoristas y los espejos fraccionados "X KG").

create table if not exists listas_reglas (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  nombre text not null,                      -- la fila de la planilla: "LINEA GANAVE"
  match_tipo text not null check (match_tipo in ('subrubro','articulo')),
  match_valor text not null,                 -- 'Ganave' | '400'  (subrubro de IM o cod_articulo)
  cod_lista int not null check (cod_lista in (9,11,12,13,14,15)),
  condicion text not null check (condicion in ('libre','promo_general','min','max')),
  umbral numeric(12,3),                      -- null cuando condicion = 'libre'
  unidad text check (unidad in ('bulto','kg')),
  ambito text check (ambito in ('articulo','linea','pedido')),
  activo boolean not null default true,      -- false = cargada pero sin confirmar por Mati
  nota text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Una sola condición por (a qué aplica, qué lista): el seed re-corre sin duplicar.
create unique index if not exists listas_reglas_target_uidx
  on listas_reglas (tenant_id, match_tipo, match_valor, cod_lista);
create index if not exists listas_reglas_lookup_idx
  on listas_reglas (tenant_id, match_tipo, match_valor) where activo;

comment on table listas_reglas is
  'Condiciones para acceder a cada lista de precios. Origen: planilla CONDICIONES LISTA SEMILLERO + audio de Mati del 26/08/2026. Se recarga con scripts/seed-listas.mjs.';
comment on column listas_reglas.activo is
  'false = la regla está cargada pero Mati todavía no confirmó el mapeo contra IM: no se evalúa.';

-- RLS: igual que el resto del módulo, solo service_role (el scoping lo hace el server).
alter table listas_reglas enable row level security;
drop policy if exists listas_reglas_service_all on listas_reglas;
create policy listas_reglas_service_all on listas_reglas for all to service_role using (true) with check (true);

drop trigger if exists listas_reglas_updated_at on listas_reglas;
create trigger listas_reglas_updated_at before update on listas_reglas
  for each row execute function set_updated_at();

-- Qué se le avisó al vendedor en cada renglón y qué mandó igual. Sin esto no hay forma
-- de saber después si el aviso sirvió o si lo ignoran siempre.
alter table pedidos_vendedor_items
  add column if not exists lista_sugerida int,
  add column if not exists aviso_lista text;

comment on column pedidos_vendedor_items.lista_sugerida is
  'La mejor lista a la que este renglón tenía derecho al confirmar el pedido. NULL = sin regla aplicable.';
comment on column pedidos_vendedor_items.aviso_lista is
  'Texto del aviso mostrado al vendedor, si la lista elegida no coincidía con la sugerida. NULL = estaba bien.';
