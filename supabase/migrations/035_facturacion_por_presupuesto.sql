-- Migration 035 — La facturación deja de colgar de la hoja de ruta (08/09/2026). Idempotente.
--
-- El orden real del circuito (Mati, 08/09/2026) es PRESUPUESTOS → FACTURACIÓN → HOJA DE RUTA:
-- se factura lo aprobado, y **con la factura y el remito hechos** se arma la hoja. O sea que
-- cuando se emite todavía NO existe ninguna hoja donde guardar los comprobantes emitidos.
--
-- 🔑 Por eso lo emitido vive acá y no en `hojas_ruta_pedidos`. Y sigue siendo indispensable
-- guardarlo nosotros: facturar por API **no deja el vínculo con el presupuesto en InfoManager**
-- (probado el 07/09/2026), así que esta tabla es el único registro de qué factura salió de qué
-- presupuesto. La hoja, después, se arma leyendo de acá.

create table if not exists presupuestos_facturados (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  -- El presupuesto de origen (comprobante PR de IM).
  im_comprobante_id text not null,
  im_numero int,
  cod_cliente int not null,
  cliente_nombre text,
  cod_empresa int not null default 1,
  -- Fecha del presupuesto: es la que decide en qué día de reparto entra.
  fecha date,
  -- Snapshot del importe facturado. Lo que se emitió, aunque después cambie el comprobante.
  total numeric(14,2),
  bultos numeric(14,3),
  kg numeric(14,3),

  -- Lo emitido en InfoManager.
  im_factura_id text,
  im_factura_numero int,
  im_factura_tipo text,                       -- 'FA A' / 'FA B'
  im_remito_id text,
  im_remito_numero int,
  -- 🔑 Sólo cuando salieron LOS DOS. Con la factura emitida y el remito no, esto queda en NULL
  -- y el reintento hace únicamente el remito: volver a emitir la factura sería facturarle dos
  -- veces al mismo cliente.
  facturado_at timestamptz,
  facturado_por uuid references usuarios(id),
  -- 🔑 Cuándo se RECLAMÓ este presupuesto para facturarlo, antes de emitir nada. El rol
  -- `administrativo` lo tienen dos personas: si las dos aprietan Facturar sobre la misma
  -- selección, las dos leen "no está facturado" y emiten. La fila se inserta ANTES de llamar a
  -- InfoManager, así el índice único de abajo hace que la segunda choque en vez de duplicar.
  -- Un reclamo sin factura y viejo es un intento que se cortó: se puede retomar.
  reclamado_at timestamptz,
  created_at timestamptz not null default now()
);

-- Un presupuesto se factura UNA vez.
create unique index if not exists presupuestos_facturados_comp_uidx
  on presupuestos_facturados (tenant_id, im_comprobante_id);
-- Para encontrar rápido lo facturado que todavía no entró en ninguna hoja.
create index if not exists presupuestos_facturados_fecha_idx
  on presupuestos_facturados (tenant_id, fecha desc);
create index if not exists presupuestos_facturados_remito_idx
  on presupuestos_facturados (im_remito_numero) where im_remito_numero is not null;

comment on table presupuestos_facturados is
  'Que factura y remito salieron de cada presupuesto. En InfoManager ese vinculo no existe cuando se emite por API: este es el unico registro.';

-- ── Row Level Security ───────────────────────────────────────────────────────
-- 🔴 Esta tabla es el ÚNICO registro del vínculo factura↔presupuesto. Sin RLS quedaría legible
-- —y borrable— con la anon key, que es pública. Mismo patrón que el resto del proyecto (032).
alter table presupuestos_facturados enable row level security;
drop policy if exists presupuestos_facturados_service on presupuestos_facturados;
create policy presupuestos_facturados_service on presupuestos_facturados for all to service_role using (true) with check (true);
