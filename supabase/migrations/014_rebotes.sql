-- Migration 014 — Rebotes de reparto (mercadería que vuelve de la hoja de ruta).
-- Idempotente.
--
-- Fuente: Google Sheet "Faltantes de mercaderia 2026" (una pestaña por mes,
-- cargada a mano por administración día a día). El server la baja como XLSX
-- (cron) y hace FULL-REPLACE del mes: el sheet es la fuente de verdad, esta
-- tabla es la proyección consultable (motivo normalizado + vendedor/cliente
-- matcheados contra InfoManager). Ver server-lib/rebotes.ts.
--
-- Decisiones de negocio (Mati, 10/07/2026):
--   · motivo mc_vendedor → descuenta 3% del total rebotado de la comisión del
--     vendedor, SIEMPRE (también en devoluciones parciales). Se aplica en fase 2.
--   · devolucion / sin_dinero / cerrado con pedido COMPLETO rebotado → recargo
--     3% al cliente (informativo; se factura a mano en IM). Se aplica en fase 3.

create table if not exists rebotes (
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  year int not null,
  month int not null check (month between 1 and 12),
  fila int not null,                 -- nro de fila dentro de la pestaña: clave estable del full-replace
  fecha date,                        -- corregida al mes de la pestaña (la pestaña manda); null si no parseable
  fecha_raw text,
  cliente_raw text not null,         -- texto libre del sheet
  cod_cliente int,                   -- match por nombre contra maestro IM; null = sin match (admin lo ve flaggeado)
  cliente_match_score numeric(4,3),
  vendedor_raw text,
  cod_vendedor int,                  -- null = no mapea a vendedor activo (ej. DARIO, ya no está en la empresa)
  cod_articulo int,
  articulo text,
  motivo_raw text,
  -- Canónico: mc_vendedor | mc_deposito | devolucion | sin_dinero | cerrado |
  -- falto | sin_stock | error_adm | logistica | error_sistema | sin_clasificar.
  -- Sin CHECK a propósito: en el sheet aparecen motivos nuevos cada tanto
  -- (SIN STOCK y LOGISTICA nacieron en abril/junio); lo no reconocido cae a
  -- sin_clasificar y no genera cargos hasta que se agregue al mapa.
  motivo text not null,
  cantidad numeric(12,2),
  precio numeric(14,2),
  total numeric(14,2),
  synced_at timestamptz not null default now(),
  primary key (tenant_id, year, month, fila)
);

create index if not exists rebotes_vendedor_idx on rebotes (tenant_id, cod_vendedor, year, month);
create index if not exists rebotes_cliente_idx on rebotes (tenant_id, cod_cliente, year, month);

alter table rebotes enable row level security;
drop policy if exists rebotes_service_all on rebotes;
create policy rebotes_service_all on rebotes
  for all to service_role using (true) with check (true);
