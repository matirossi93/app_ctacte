-- Migration 038 — Corregir una factura ya emitida (09/09/2026). Idempotente.
--
-- Mati: *"muchas veces en el reparto llaman los repartidores a facturación porque hay algún
-- problema con la facturación, ya sea que se puso mal una lista o hay un artículo mal cargado...
-- con InfoManager la nota de crédito es muy engorrosa y muchas veces ya está hecho el recibo,
-- entonces tampoco se puede editar. Que sea lo más rápido y ágil y simple posible"*.
--
-- 🔴 UNA FACTURA EMITIDA NO SE TOCA: es un comprobante fiscal y la API tampoco lo permite. Lo que
-- el panel hace es calcular la diferencia entre lo que dice la factura y lo que debería decir, y
-- emitirla como nota de crédito (lo que baja) y nota de débito (lo que sube).
--
-- 🪤 POR QUÉ ESTA TABLA: la API de InfoManager **no expone la relación entre una nota y su
-- factura** (verificado por tres caminos el 08/09/2026). El vínculo lo guardamos nosotros, igual
-- que el de la factura con el presupuesto. En las observaciones de la nota va además
-- "SEGUN FACTURA 50401", para que se lea igual desde las pantallas de IM.
--
-- 📌 Se separa de `hojas_ruta_ajustes` a propósito: aquélla ajusta lo que NO SE ENTREGÓ y cuelga
-- de una hoja de ruta (es la base del pago al chofer). Ésta corrige lo que se FACTURÓ MAL, existe
-- aunque el pedido nunca haya entrado en una hoja, y no tiene por qué tocar la liquidación.

create table if not exists facturas_correcciones (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',

  -- La factura que se está corrigiendo, tal como la conoce InfoManager.
  im_factura_id text not null,
  im_factura_numero int,
  cod_cliente int not null,

  -- 'NC A' / 'NC B' / 'ND A' / 'ND B', como lo devuelve la emisión.
  tipo text not null,
  -- El comprobante emitido en InfoManager.
  im_comprobante_id text not null,
  numero int,
  -- Siempre positivo: el signo lo da el tipo (NC baja, ND sube).
  total numeric(14,2) not null check (total > 0),

  motivo text,
  creado_por uuid references usuarios(id),
  created_at timestamptz not null default now()
);

-- Se consulta siempre por la factura: "qué correcciones tiene ésta".
create index if not exists facturas_correcciones_factura_idx
  on facturas_correcciones (tenant_id, im_factura_id);

-- 🪤 Un comprobante de InfoManager se vincula a UNA factura y una sola vez. Sin esto, un doble
-- click o un reintento después de un error de red dejaría la misma nota de crédito contada dos
-- veces, y el saldo del cliente saldría mal en los informes.
create unique index if not exists facturas_correcciones_im_uidx
  on facturas_correcciones (tenant_id, im_comprobante_id);

-- ── Row Level Security ───────────────────────────────────────────────────────
alter table facturas_correcciones enable row level security;
drop policy if exists facturas_correcciones_service on facturas_correcciones;
create policy facturas_correcciones_service on facturas_correcciones for all to service_role using (true) with check (true);
