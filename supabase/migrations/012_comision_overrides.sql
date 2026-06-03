-- Migration 012 — Override manual de vendedor por comprobante. Idempotente.
--
-- Caso real (03/06/2026): una factura se emite en InfoManager con el vendedor
-- equivocado (ej. FA 57546720 de ADRIAN GALVAN quedó con Marcelo=3 pero el
-- cliente es de Brian=12). IM bloquea editar el vendedor de una factura ya
-- emitida, y la app es solo-lectura sobre /ventas. Este override reasigna el
-- comprobante al vendedor correcto SOLO a efectos internos de comisiones/avance
-- (no toca IM ni la cta cte). Se aplica en los 3 puntos que leen el vendedor de
-- la cabecera: comisiones.ts, syncVentas.ts y goals.ts (getGoalsSnapshot).

create table if not exists comision_vendedor_override (
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  id_comprobante bigint not null,
  cod_vendedor int not null,
  cod_vendedor_original int,
  motivo text,
  created_by uuid references usuarios(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id_comprobante)
);

alter table comision_vendedor_override enable row level security;
drop policy if exists comision_override_service_all on comision_vendedor_override;
create policy comision_override_service_all on comision_vendedor_override
  for all to service_role using (true) with check (true);
