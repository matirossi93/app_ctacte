-- Migration 017 — Pedidos de vendedor (22/07/2026). Idempotente.
--
-- OJO: las tablas se llaman pedidos_vendedor / pedidos_vendedor_items (NO
-- "pedidos" a secas) porque ya existe una tabla `pedidos` en esta base (el CRM
-- de Amira). Nombre propio = sin colisión.
--
-- El vendedor toma el pedido en la app; se guarda acá (historial + estados
-- propios) y se empuja a InfoManager como PRESUPUESTO NO CONFIRMADO (PR/NC): un
-- borrador que la oficina ve y luego factura. NO mueve stock, NO emite AFIP, NO
-- toca cuenta corriente hasta que la oficina lo factura. Ver memoria
-- project_app_pedidos_replica_im (receta + trampas del POST /presupuestos).
--
-- Estados:
--   borrador  → creado en la app, todavía NO empujado a IM
--   enviado   → creado en IM como presupuesto NC (im_presupuesto_id seteado)
--   facturado → la oficina lo facturó en IM (se marca a futuro / manual)
--   anulado   → anulado en IM (PUT /ventas/{id} anulada:S)
--   error     → IM rechazó el pedido (im_error con el detalle)
--   sin_respuesta → IM no respondió (timeout): resultado DESCONOCIDO, revisar a mano

create table if not exists pedidos_vendedor (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  cod_vendedor int not null,                 -- del JWT (scoping)
  cod_cliente int not null,
  cliente_nombre text,                       -- snapshot para la lista
  cod_empresa int not null default 1,
  cod_lista_precios int,                     -- lista del cliente al momento
  estado text not null default 'borrador'
    check (estado in ('borrador','enviado','facturado','anulado','error','sin_respuesta')),
  im_presupuesto_id text,                    -- id que devuelve IM
  im_numero int,                             -- numero visible del presupuesto en IM
  im_punto_de_venta int,                     -- para poder anular después (PUT /ventas)
  im_error text,                             -- detalle si IM rechazó
  total_estimado numeric(14,2) default 0,    -- informativo (IM recalcula al facturar)
  observaciones text,
  idempotency_key text,                      -- anti-duplicado (1 pedido por key)
  created_by uuid references usuarios(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists pedidos_vendedor_idempotency_uidx
  on pedidos_vendedor (tenant_id, idempotency_key) where idempotency_key is not null;
create index if not exists pedidos_vendedor_vend_idx on pedidos_vendedor (tenant_id, cod_vendedor, created_at desc);
create index if not exists pedidos_vendedor_cliente_idx on pedidos_vendedor (tenant_id, cod_cliente);

create table if not exists pedidos_vendedor_items (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid not null references pedidos_vendedor(id) on delete cascade,
  cod_articulo int not null,
  descripcion text,                          -- snapshot
  cantidad numeric(14,3) not null check (cantidad > 0),
  precio_unit numeric(14,4) not null default 0,  -- de la lista del cliente al momento
  cod_cuenta text,                           -- cuenta contable de venta (IM)
  iva_por numeric(6,2) default 21,
  subtotal numeric(14,2) not null default 0,
  orden int not null default 0
);

create index if not exists pedidos_vendedor_items_pedido_idx on pedidos_vendedor_items (pedido_id);

-- RLS: solo service_role (el backend usa service key; el scoping por vendedor lo
-- hace el server con el JWT, igual que el resto de la app).
alter table pedidos_vendedor enable row level security;
alter table pedidos_vendedor_items enable row level security;
drop policy if exists pedidos_vendedor_service_all on pedidos_vendedor;
create policy pedidos_vendedor_service_all on pedidos_vendedor for all to service_role using (true) with check (true);
drop policy if exists pedidos_vendedor_items_service_all on pedidos_vendedor_items;
create policy pedidos_vendedor_items_service_all on pedidos_vendedor_items for all to service_role using (true) with check (true);

-- Autocontenida: recrea el helper por si esta base no corrió la 001 completa.
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists pedidos_vendedor_updated_at on pedidos_vendedor;
create trigger pedidos_vendedor_updated_at before update on pedidos_vendedor
  for each row execute function set_updated_at();
