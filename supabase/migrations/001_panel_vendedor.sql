-- Panel Vendedor — Migration 001
-- Aplica en tenant Semillero (00000000-0000-0000-0000-000000000001)
-- Idempotente: se puede correr varias veces sin romper.

-- ══════════════════════════════════════════════════════════════════════════════
-- 1. TABLA usuarios (del RBAC 17/04 si no se aplicó) + cod_vendedor
-- ══════════════════════════════════════════════════════════════════════════════
create extension if not exists pgcrypto;

create table if not exists usuarios (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  email text not null,
  password_hash text not null,      -- sha256 hex (consistente con CRM)
  rol text not null check (rol in ('admin','gerente','vendedor')),
  vendedor_key text,                -- slug ('brian','marcelo',...) compat CRM
  cod_vendedor int,                 -- mapeo a InfoManager
  nombre text,
  activo boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index if not exists usuarios_tenant_email_uidx
  on usuarios (tenant_id, lower(email));
create index if not exists usuarios_cod_vendedor_idx
  on usuarios (cod_vendedor) where cod_vendedor is not null;

alter table usuarios enable row level security;
drop policy if exists usuarios_service_all on usuarios;
create policy usuarios_service_all on usuarios
  for all to service_role using (true) with check (true);

-- Seed 6 usuarios Semillero — passwords temporales sha256('Semillero2026!')
-- (cambiar con UPDATE después; hash abajo corresponde a 'Semillero2026!')
insert into usuarios (tenant_id, email, password_hash, rol, vendedor_key, cod_vendedor, nombre)
values
  ('00000000-0000-0000-0000-000000000001','matias@semillero',
   encode(digest('Semillero2026!','sha256'),'hex'),'admin',null,null,'Matías Rossi'),
  ('00000000-0000-0000-0000-000000000001','manolo@semillero',
   encode(digest('Semillero2026!','sha256'),'hex'),'gerente',null,null,'Manolo'),
  ('00000000-0000-0000-0000-000000000001','brian@semillero',
   encode(digest('Semillero2026!','sha256'),'hex'),'vendedor','brian',null,'Brian'),
  ('00000000-0000-0000-0000-000000000001','marcelo@semillero',
   encode(digest('Semillero2026!','sha256'),'hex'),'vendedor','marcelo',null,'Marcelo'),
  ('00000000-0000-0000-0000-000000000001','julio@semillero',
   encode(digest('Semillero2026!','sha256'),'hex'),'vendedor','julio',null,'Julio'),
  ('00000000-0000-0000-0000-000000000001','sebastian@semillero',
   encode(digest('Semillero2026!','sha256'),'hex'),'vendedor','sebastian',null,'Sebastián')
on conflict (tenant_id, lower(email)) do nothing;

-- TODO post-deploy: UPDATE usuarios SET cod_vendedor=X WHERE email='brian@semillero';
--   (buscar cod_vendedor desde InfoManager /vendedores — script: scripts/sync_vendedores.ts)

-- ══════════════════════════════════════════════════════════════════════════════
-- 2. vendor_goals — target manual por vendedor y mes
-- ══════════════════════════════════════════════════════════════════════════════
create table if not exists vendor_goals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  cod_vendedor int not null,
  year int not null check (year between 2024 and 2100),
  month int not null check (month between 1 and 12),
  target_neto numeric(14,2) not null check (target_neto >= 0),
  set_by uuid references usuarios(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, cod_vendedor, year, month)
);
alter table vendor_goals enable row level security;
drop policy if exists vendor_goals_service_all on vendor_goals;
create policy vendor_goals_service_all on vendor_goals
  for all to service_role using (true) with check (true);

-- ══════════════════════════════════════════════════════════════════════════════
-- 3. vendor_activity — timeline libre (notas, llamadas, WA, promesas, pagos, visitas)
-- ══════════════════════════════════════════════════════════════════════════════
create table if not exists vendor_activity (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  cod_vendedor int not null,
  cod_cliente int,                -- null = actividad general del vendedor
  tipo text not null check (tipo in ('nota','llamada','wa','promesa','pago','visita')),
  contenido text,
  monto numeric(14,2),            -- promesa/pago
  fecha_promesa date,             -- promesa
  created_by uuid references usuarios(id),
  created_at timestamptz not null default now()
);
create index if not exists vendor_activity_cv_idx on vendor_activity (cod_vendedor, created_at desc);
create index if not exists vendor_activity_cc_idx on vendor_activity (cod_cliente, created_at desc);
alter table vendor_activity enable row level security;
drop policy if exists vendor_activity_service_all on vendor_activity;
create policy vendor_activity_service_all on vendor_activity
  for all to service_role using (true) with check (true);

-- ══════════════════════════════════════════════════════════════════════════════
-- 4. client_sales_monthly — cache agregado por cliente+mes (cron)
-- ══════════════════════════════════════════════════════════════════════════════
create table if not exists client_sales_monthly (
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  cod_cliente int not null,
  year int not null,
  month int not null,
  neto numeric(14,2) not null default 0,
  num_comprobantes int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, cod_cliente, year, month)
);
alter table client_sales_monthly enable row level security;
drop policy if exists csm_service_all on client_sales_monthly;
create policy csm_service_all on client_sales_monthly
  for all to service_role using (true) with check (true);

-- ══════════════════════════════════════════════════════════════════════════════
-- 5. vendor_sales_monthly — cache agregado por vendedor+mes (cron)
-- ══════════════════════════════════════════════════════════════════════════════
create table if not exists vendor_sales_monthly (
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  cod_vendedor int not null,
  year int not null,
  month int not null,
  neto numeric(14,2) not null default 0,
  num_comprobantes int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, cod_vendedor, year, month)
);
alter table vendor_sales_monthly enable row level security;
drop policy if exists vsm_service_all on vendor_sales_monthly;
create policy vsm_service_all on vendor_sales_monthly
  for all to service_role using (true) with check (true);

-- ══════════════════════════════════════════════════════════════════════════════
-- 6. client_operational — metadata del sheet Maestro Clientes
-- ══════════════════════════════════════════════════════════════════════════════
create table if not exists client_operational (
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  cod_cliente int not null,
  cod_vendedor int,
  razon_social text,
  direccion text,
  dia_visita text,
  visita text,                     -- 'SI'/'NO'
  frecuencia text,                 -- 'SEM','QUIN','MEN'
  localidad text,
  hoja_ruta text,
  repartidor text,
  dia_entrega text,
  cond_pago text,
  tipo_abc text,                   -- A/B/C
  notas text,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, cod_cliente)
);
create index if not exists client_op_cv_idx on client_operational (cod_vendedor);
create index if not exists client_op_localidad_idx on client_operational (localidad);
alter table client_operational enable row level security;
drop policy if exists client_op_service_all on client_operational;
create policy client_op_service_all on client_operational
  for all to service_role using (true) with check (true);

-- ══════════════════════════════════════════════════════════════════════════════
-- 7. comprobantes_pago — RECIBOS subidos desde la app por vendedores
-- ══════════════════════════════════════════════════════════════════════════════
create table if not exists comprobantes_pago (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  cod_cliente int not null,
  cod_vendedor int not null,
  monto numeric(14,2) not null check (monto > 0),
  fecha_comprobante date,
  medio_pago text check (medio_pago in ('transferencia','efectivo','cheque','mercadopago','otro')),
  banco_origen text,
  referencia text,                 -- nro operación / CBU últimos 4
  observaciones text,
  foto_url text not null,          -- path en Supabase Storage
  foto_mime text,
  ocr_raw jsonb,                   -- respuesta completa Claude Vision
  ocr_confidence numeric(4,2),     -- 0..1
  status text not null default 'pendiente_revision'
    check (status in ('pendiente_revision','aprobado','imputado','rechazado','error')),
  factura_asociada text,            -- ID compuesto (e.g. "FA-0003-00142847") o null hasta aprobar
  cod_empresa int,                  -- 1=CC, 2=SM, 3=SJ (cuando se aprueba)
  infomanager_recibo_id text,       -- id devuelto por POST /api/v1/recibo
  infomanager_response jsonb,       -- respuesta completa
  error_msg text,
  motivo_rechazo text,
  created_by uuid references usuarios(id),
  reviewed_by uuid references usuarios(id),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  imputado_at timestamptz
);

create index if not exists comp_pago_status_idx on comprobantes_pago (status, created_at desc);
create index if not exists comp_pago_cliente_idx on comprobantes_pago (cod_cliente, created_at desc);
create index if not exists comp_pago_vendedor_idx on comprobantes_pago (cod_vendedor, created_at desc);

alter table comprobantes_pago enable row level security;
drop policy if exists comp_pago_service_all on comprobantes_pago;
create policy comp_pago_service_all on comprobantes_pago
  for all to service_role using (true) with check (true);

-- ══════════════════════════════════════════════════════════════════════════════
-- 8. Supabase Storage — bucket 'recibos' (privado)
-- ══════════════════════════════════════════════════════════════════════════════
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('recibos', 'recibos', false, 10485760, array['image/jpeg','image/png','image/webp','image/heic','application/pdf'])
on conflict (id) do nothing;

-- Service role full access (las políticas se aplican por el backend con service key)
drop policy if exists "recibos_service_all" on storage.objects;
create policy "recibos_service_all" on storage.objects
  for all to service_role using (bucket_id = 'recibos') with check (bucket_id = 'recibos');

-- ══════════════════════════════════════════════════════════════════════════════
-- 9. updated_at trigger helper (reusable)
-- ══════════════════════════════════════════════════════════════════════════════
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists vendor_goals_updated_at on vendor_goals;
create trigger vendor_goals_updated_at before update on vendor_goals
  for each row execute function set_updated_at();

drop trigger if exists client_op_updated_at on client_operational;
create trigger client_op_updated_at before update on client_operational
  for each row execute function set_updated_at();
