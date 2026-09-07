-- Migration 032 — Hojas de ruta (07/09/2026). Idempotente.
--
-- Para qué: hoy Jorgelina arma las hojas de ruta en el panel de InfoManager, agrupando remitos
-- a mano por zona. La API de IM **no expone nada de hojas de ruta** (85 endpoints revisados),
-- así que este concepto vive acá. Es justo la parte que más les duele y la que está más libre
-- para hacerla bien.
--
-- El circuito real (Mati, 07/09/2026): los vendedores cargan → Jorgelina revisa y corrige →
-- factura → agrupa los remitos en 1, 2 o 3 hojas por día según la ZONA del cliente → imprime
-- el listado de fraccionado y la hoja de ruta con el saldo anterior de cada cliente → todo eso
-- va al galpón y se carga el camión.
--
-- 🔑 EL PESO NO ES DECORATIVO: define en qué camión entra la mercadería. La flota es
-- 1×5.000 kg, 2×7.000 kg y 1×12.000 kg, así que la hoja tiene que avisar cuando se pasa.

create table if not exists hojas_ruta_camiones (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  nombre text not null,
  capacidad_kg numeric(10,2) not null check (capacidad_kg > 0),
  activo boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists hojas_ruta (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  fecha date not null,
  -- Número visible. Se lleva por tenant y arranca donde IM: la hoja del 07/09 era la 3394.
  numero int not null,
  -- "Mañana" / "Tarde". Texto y no enum: hoy son dos, mañana pueden ser tres.
  turno text,
  -- El transporte lo elige quien arma la hoja. 🪤 NO sale de IM: `cod_transporte` está en 0
  -- para los 1.332 clientes, así que no hay de dónde deducirlo.
  transporte text,
  camion_id uuid references hojas_ruta_camiones(id),
  -- Zona de IM que agrupa esta hoja (1=Simoca, 3=Banda, 4=Centro, 9=Lules, 13=Yerba Buena…).
  -- NULL = hoja mixta, armada a mano.
  cod_zona int,
  estado text not null default 'abierta'
    check (estado in ('abierta','cerrada','anulada')),
  observaciones text,
  created_by uuid references usuarios(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists hojas_ruta_numero_uidx on hojas_ruta (tenant_id, numero);
create index if not exists hojas_ruta_fecha_idx on hojas_ruta (tenant_id, fecha desc);

-- Qué pedidos van en cada hoja. Un pedido está en UNA hoja o en ninguna.
create table if not exists hojas_ruta_pedidos (
  id uuid primary key default gen_random_uuid(),
  hoja_id uuid not null references hojas_ruta(id) on delete cascade,
  pedido_id uuid not null references pedidos_vendedor(id) on delete cascade,
  orden int not null default 0,
  -- 📌 Snapshot al momento de armar la hoja, NO se recalcula al imprimir. El saldo del cliente
  -- cambia solo (entra un recibo, se factura otra cosa) y el papel que se llevó el repartidor
  -- tiene que poder explicarse después: si el número impreso no coincide con nada, la hoja no
  -- sirve para rendir. Se guarda lo que se imprimió.
  saldo_anterior numeric(14,2),
  bultos numeric(14,3),
  kg numeric(14,3),
  created_at timestamptz not null default now()
);

create unique index if not exists hojas_ruta_pedidos_uidx on hojas_ruta_pedidos (pedido_id);
create index if not exists hojas_ruta_pedidos_hoja_idx on hojas_ruta_pedidos (hoja_id, orden);

-- RLS: sólo service_role, igual que el resto de la app (el scoping lo hace el server con el JWT).
alter table hojas_ruta_camiones enable row level security;
alter table hojas_ruta enable row level security;
alter table hojas_ruta_pedidos enable row level security;
drop policy if exists hojas_ruta_camiones_service on hojas_ruta_camiones;
create policy hojas_ruta_camiones_service on hojas_ruta_camiones for all to service_role using (true) with check (true);
drop policy if exists hojas_ruta_service on hojas_ruta;
create policy hojas_ruta_service on hojas_ruta for all to service_role using (true) with check (true);
drop policy if exists hojas_ruta_pedidos_service on hojas_ruta_pedidos;
create policy hojas_ruta_pedidos_service on hojas_ruta_pedidos for all to service_role using (true) with check (true);

create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists hojas_ruta_updated_at on hojas_ruta;
create trigger hojas_ruta_updated_at before update on hojas_ruta
  for each row execute function set_updated_at();

-- La flota, al 07/09/2026. Se cargan acá y no en el código porque cambian sin que cambie la app.
insert into hojas_ruta_camiones (nombre, capacidad_kg)
select * from (values ('Camión 5.000', 5000), ('Camión 7.000 A', 7000), ('Camión 7.000 B', 7000), ('Camión 12.000', 12000)) as v(nombre, cap)
where not exists (select 1 from hojas_ruta_camiones);
