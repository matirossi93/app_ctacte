-- Migration 048 — El kilaje de la bolsa se carga desde la pantalla (18/09/2026). Idempotente.
--
-- Mati (17/09/2026): *"el tema del camino A es que van cambiando los kilajes de las bolsas, no
-- son siempre iguales... como hacemos ahí? instantánea ahora tiene 20, arrollada por 30 y el
-- sorgo por 40"*.
--
-- Hasta hoy el kilaje vivía en DOS lugares y ninguno servía para esto:
--
--   1. `FORMATOS_CONOCIDOS`, una constante en server-lib/formatosBolsa.ts. Cambiar un número
--      pedía un deploy, y envejecía en silencio: el 16/09 decía que la AVENA INSTANTANEA venía
--      por 30 y venía por 20, y el SORGO directamente no estaba.
--   2. La deducción desde 30 días de pedidos, que necesita 20 renglones del artículo para
--      animarse. Un producto que se vende poco no llega nunca a esa muestra.
--
-- Acá vive el kilaje CARGADO A MANO, que le gana a los dos: es el dato de quien abrió la bolsa.
-- La constante del código se retira con esta migración — los ocho valores que tenía se siembran
-- abajo, así que la tabla arranca sabiendo lo mismo que sabía el código, y desde ahora se
-- corrige sin tocar el repositorio.
--
-- 🪤 `kg` es numeric y no int: nada impide que mañana una bolsa venga por 22,5.
-- 🪤 Sin fila para un artículo NO se asume nada: el fraccionado deja la cantidad como vino y la
--    pantalla pide que le carguen el kilaje (ver `paquetesDelRenglon`). Poner un 0 por defecto
--    sería lo mismo que el problema viejo, con otra cara.
begin;

create table if not exists formatos_bolsa (
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  cod_articulo int not null,
  -- Cuántos kilos trae la bolsa cerrada de este producto.
  kg numeric(10,2) not null check (kg > 0 and kg <= 2000),
  -- Quién lo cargó y cuándo: si un número queda raro, se puede preguntar.
  actualizado_por uuid references usuarios(id),
  actualizado_at timestamptz not null default now(),
  primary key (tenant_id, cod_articulo)
);

comment on table formatos_bolsa is
  'Kilos por bolsa cerrada de cada producto a granel, cargados a mano desde la pantalla de fraccionado. InfoManager no tiene el dato: un granel sale con unidad_de_medida=Kilos y equivalencia_um=1. Le gana a lo deducido de los pedidos (server-lib/formatosBolsa.ts).';

-- El schema public es accesible con la anon key, que es pública por diseño. El server entra con
-- la service key: la policy le deja todo a él y a nadie más.
alter table formatos_bolsa enable row level security;
drop policy if exists formatos_bolsa_service on formatos_bolsa;
create policy formatos_bolsa_service on formatos_bolsa for all to service_role using (true) with check (true);

-- ── Los ocho que estaban en el código ──────────────────────────────────────────────────────────
-- Vienen de FORMATOS_CONOCIDOS tal como estaba al 18/09/2026. `on conflict do nothing`: si la
-- migración se corre de nuevo, NO pisa lo que la oficina haya corregido mientras tanto.
insert into formatos_bolsa (cod_articulo, kg) values
  (459, 25),   -- GIRASOL PELADO
  (400, 25),   -- ALPISTE
  (402, 25),   -- MIJO
  (401, 40),   -- LINO
  (723, 30),   -- POROTO ALUBIA
  (703, 30),   -- AVENA ARROLLADA
  (704, 20),   -- AVENA INSTANTANEA
  (403, 40)    -- SORGO
on conflict (tenant_id, cod_articulo) do nothing;

commit;
