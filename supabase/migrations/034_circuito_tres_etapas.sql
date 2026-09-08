-- Migration 034 — El circuito en TRES etapas (08/09/2026). Idempotente.
--
-- Mati, después de probar el panel con la oficina: el orden real no es el que teníamos.
--
--   1. PRESUPUESTOS  — Jorgelina hace el primer filtrado: listas, stock, cantidades. De acá
--                      sale también el listado de FRACCIONADO ("también se hace antes que el
--                      armado de la hoja").
--   2. FACTURACIÓN   — recién con los presupuestos OK se emite factura + remito.
--   3. HOJA DE RUTA  — "es el último paso", y se arma con los REMITOS ya emitidos.
--
-- 🔑 La hoja ya sabía llevar el remito al lado del presupuesto (migración 033), así que ese
-- cambio de orden no necesita tocar `hojas_ruta_pedidos`. Lo que falta es todo lo demás.

-- ── 1) La revisión del presupuesto (etapa 1) ─────────────────────────────────
--
-- Sin esto, Jorgelina no puede saber qué ya miró: hoy revisa 50 pedidos por día y el panel
-- los muestra todos iguales cada vez que entra. Y la facturación (etapa 2) necesita saber
-- QUÉ está aprobado para poder ofrecerlo.
--
-- 🔑 La unidad es el COMPROBANTE DE IM, igual que en las hojas: conviven presupuestos de la
-- app con otros cargados directo en InfoManager, y los dos hay que revisarlos.
create table if not exists presupuestos_revision (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  im_comprobante_id text not null,
  im_numero int,
  cod_cliente int,
  -- `aprobado` = listo para facturar · `observado` = no pasa todavía, y la nota dice por qué
  -- (falta stock, hay que llamar al cliente, precio a confirmar).
  estado text not null default 'aprobado' check (estado in ('aprobado','observado')),
  observacion text,
  revisado_por uuid references usuarios(id),
  revisado_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Un presupuesto tiene UNA revisión: al volver a tocarlo se pisa la anterior.
create unique index if not exists presupuestos_revision_comp_uidx
  on presupuestos_revision (tenant_id, im_comprobante_id);
create index if not exists presupuestos_revision_estado_idx
  on presupuestos_revision (tenant_id, estado);

-- ── 2) Los choferes (etapa 3) ────────────────────────────────────────────────
--
-- Mati (08/09/2026): *"es el mismo dato: chofer y transportista"*, y **se les paga por el
-- importe entregado** ⇒ el número final de cada hoja es la base de un pago, no un dato de
-- color.
-- 🪤 En InfoManager no están: `cod_transporte` es 0 en los 1.332 clientes. La lista es nuestra.
create table if not exists choferes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  nombre text not null,
  activo boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists choferes_nombre_uidx on choferes (tenant_id, upper(nombre));

insert into choferes (nombre)
select v.nombre from (values ('NIÑO'), ('VICTOR'), ('DANIEL'), ('MARIO'), ('ELVIO'), ('EDUARDO')) as v(nombre)
where not exists (
  select 1 from choferes c
  where c.tenant_id = '00000000-0000-0000-0000-000000000001' and upper(c.nombre) = upper(v.nombre)
);

alter table hojas_ruta
  add column if not exists chofer_id uuid references choferes(id);

comment on column hojas_ruta.chofer_id is
  'Quien maneja. Se le paga por el importe entregado de sus hojas, asi que el dato es de cobro.';

-- ── 3) Cerrar y archivar la hoja (etapa 3) ───────────────────────────────────
-- El `estado` ('abierta','cerrada','anulada') ya existía sin usarse. Falta saber CUÁNDO y
-- QUIÉN la cerró: una hoja cerrada es la que ya volvió del reparto y se puede liquidar.
alter table hojas_ruta
  add column if not exists cerrada_at timestamptz,
  add column if not exists cerrada_por uuid references usuarios(id);

create index if not exists hojas_ruta_estado_idx on hojas_ruta (tenant_id, estado, fecha desc);

-- ── 4) Retiro en sucursal (etapa 3) ──────────────────────────────────────────
--
-- Mati: *"hay algunos pedidos que no van por hoja de ruta sino que los clientes pasan a
-- retirar (son pocos)... debería ir acumulándose los de todo el mes para poder analizarlo"*.
--
-- 🔑 Tabla propia y NO una hoja de ruta con un flag: no tiene camión, ni chofer, ni capacidad,
-- ni se imprime hoja, y lo que se quiere de esto es el acumulado del mes. Se factura igual que
-- todo lo demás (factura + remito): lo único distinto es que no sube al camión.
create table if not exists retiros_sucursal (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  -- El comprobante que retira el cliente (el remito, o el presupuesto si todavía no se facturó).
  im_comprobante_id text not null,
  im_numero int,
  cod_cliente int not null,
  cliente_nombre text,
  -- Snapshot, mismo criterio que la hoja: es lo que se entregó ese día.
  fecha date not null,
  total numeric(14,2),
  bultos numeric(14,3),
  kg numeric(14,3),
  im_factura_id text,
  im_factura_numero int,
  im_remito_id text,
  im_remito_numero int,
  -- Cuándo pasó a buscarlo. NULL = está avisado pero todavía no lo retiró.
  retirado_at timestamptz,
  created_by uuid references usuarios(id),
  created_at timestamptz not null default now()
);

-- Un comprobante se retira una sola vez.
create unique index if not exists retiros_sucursal_comp_uidx on retiros_sucursal (tenant_id, im_comprobante_id);
-- El análisis es por mes: este índice es el que lo hace barato.
create index if not exists retiros_sucursal_fecha_idx on retiros_sucursal (tenant_id, fecha desc);

-- ── Row Level Security ───────────────────────────────────────────────────────
-- Igual que el resto de las tablas del proyecto (ver 032). Sin esto, en Supabase una tabla del
-- schema `public` queda accesible con la anon key, que es pública por diseño: cualquiera podría
-- leer —o borrar— la revisión de los presupuestos y los retiros. El server entra con la service
-- key, así que la policy le deja todo a él y a nadie más.
alter table presupuestos_revision enable row level security;
alter table choferes enable row level security;
alter table retiros_sucursal enable row level security;
drop policy if exists presupuestos_revision_service on presupuestos_revision;
create policy presupuestos_revision_service on presupuestos_revision for all to service_role using (true) with check (true);
drop policy if exists choferes_service on choferes;
create policy choferes_service on choferes for all to service_role using (true) with check (true);
drop policy if exists retiros_sucursal_service on retiros_sucursal;
create policy retiros_sucursal_service on retiros_sucursal for all to service_role using (true) with check (true);
