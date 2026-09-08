-- Migration 036 — Lo que se ajusta cuando vuelve el repartidor (08/09/2026). Idempotente.
--
-- Mati: *"una vez que vuelve el repartidor se hacen NC o facturas por dif de mercadería y eso
-- impacta en el num final de la hoja... la HR siempre tiene que estar actualizada, porque
-- también la analizamos luego"*. Y ese número final es la base del pago al chofer.
--
-- 🔴 POR QUÉ ESTA TABLA EXISTE: la API de InfoManager **no expone la relación entre una nota de
-- crédito y su factura**. Verificado el 08/09/2026 por tres caminos: el detalle de la NC no trae
-- ningún campo de referencia entre sus 47 claves, los endpoints de comprobantes relacionados dan
-- 404, y el filtro por tipo de comprobante ni siquiera filtra. Así que el vínculo lo guardamos
-- nosotros, igual que el de la factura con el presupuesto.
--
-- 📌 Lo que la oficina hace hoy: escribir "SEGUN HR 3210" en las observaciones de la NC. De 724
-- notas de crédito de Casa Central en 90 días, 287 lo tienen. Se respeta esa convención al
-- emitir desde el panel —así se sigue leyendo igual desde IM— y además queda el vínculo exacto.

create table if not exists hojas_ruta_ajustes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  hoja_id uuid not null references hojas_ruta(id) on delete cascade,
  -- El pedido de la hoja al que corresponde el ajuste (el presupuesto de origen).
  im_comprobante_id text not null,
  cod_cliente int not null,
  cliente_nombre text,

  -- 'nc' = se le devuelve al cliente lo que no se entregó · 'nd' = se le cobra de más.
  tipo text not null default 'nc' check (tipo in ('nc','nd')),
  -- Por qué. Los reales, tomados de las NC de la oficina: NO PIDIO, SIN STOCK, CERRADO,
  -- PROBLEMA DE LOGISTICA, DIF LISTAS.
  motivo text not null,
  -- Lo que se acredita (siempre positivo; el signo lo da `tipo`).
  importe numeric(14,2) not null check (importe > 0),
  -- 🔑 Qué se acreditó, renglón por renglón: `[{cod_articulo, cantidad, precio}]`. Sin esto no
  -- se puede controlar que entre varias notas de crédito no se termine acreditando MÁS de lo
  -- que se entregó — que es como un cliente queda con saldo a favor de la nada.
  items jsonb not null default '[]'::jsonb,

  -- El comprobante emitido en InfoManager.
  im_ajuste_id text,
  im_ajuste_numero int,
  im_ajuste_tipo text,                        -- 'NC A' / 'NC B'
  emitido_at timestamptz,
  -- Mismo patrón que la facturación: la fila se escribe ANTES de emitir, así dos personas no
  -- emiten la misma nota de crédito dos veces.
  reclamado_at timestamptz,

  created_by uuid references usuarios(id),
  created_at timestamptz not null default now()
);

-- El análisis y el impreso van por hoja; la liquidación del chofer, por hoja también.
create index if not exists hojas_ruta_ajustes_hoja_idx on hojas_ruta_ajustes (hoja_id);
create index if not exists hojas_ruta_ajustes_comp_idx on hojas_ruta_ajustes (im_comprobante_id);
-- 🪤 Un pedido puede tener VARIOS ajustes emitidos (dos motivos distintos), pero UNO SOLO a
-- medias: la fila sin emitir es el "reclamo", y este índice es lo que hace que dos personas no
-- emitan la misma nota de crédito a la vez. Sin él, el select-antes-del-insert no frena nada.
create unique index if not exists hojas_ruta_ajustes_reclamo_uidx
  on hojas_ruta_ajustes (tenant_id, im_comprobante_id) where emitido_at is null;

-- Dos ajustes no pueden compartir el mismo número de comprobante DEL MISMO TALONARIO.
-- 🪤 NC A y NC B son talonarios independientes y pueden repetir número: sin el tipo, el segundo
-- update fallaría DESPUÉS de que la nota ya salió en InfoManager.
create unique index if not exists hojas_ruta_ajustes_numero_uidx
  on hojas_ruta_ajustes (tenant_id, im_ajuste_tipo, im_ajuste_numero) where im_ajuste_numero is not null;

-- Una nota de crédito de InfoManager se vincula a UN pedido: si se atara a dos, se descontaría
-- dos veces del número final y el chofer cobraría de menos.
create unique index if not exists hojas_ruta_ajustes_im_uidx
  on hojas_ruta_ajustes (tenant_id, im_ajuste_id) where im_ajuste_id is not null;

-- ── Row Level Security ───────────────────────────────────────────────────────
alter table hojas_ruta_ajustes enable row level security;
drop policy if exists hojas_ruta_ajustes_service on hojas_ruta_ajustes;
create policy hojas_ruta_ajustes_service on hojas_ruta_ajustes for all to service_role using (true) with check (true);
