-- Migration 045 — Legumbres: el mejor precio desde 10 kg, y las avenas por bolsa (16/09/2026).
--
-- Mati: *"está habilitado el mejor precio en todas las legumbres a partir de 10 kg, salvo en las
-- avenas, donde el mejor precio se habilita por bolsa recién"*, y después: *"legumbres es L3 desde
-- los 10 kg, las bolsas de avena son de 30 kg"*.
--
-- ANTES:  L1 hasta 20 kg · L2 desde 20 kg · L3 sólo con la promo general de 10 bultos
-- AHORA:  L1 hasta 10 kg · L2 desde 10 kg · L3 desde 10 kg (y la promo general se conserva)
--
-- La promo general de L3 NO se toca: sigue habilitando L3 en un pedido de 10 bultos aunque de ese
-- artículo se lleve menos de 10 kg.
--
-- ── LAS AVENAS VAN POR BOLSA ───────────────────────────────────────────────────────────────────
-- Reglas propias por artículo, que reemplazan por completo a las del subrubro (ver `reglasDe`:
-- la regla por código le gana a la del subrubro). Bolsa de 30 kg, confirmado por Mati.
--
--   703 AVENA ARROLLADA   — 933 renglones en 30 días; la cantidad más repetida es 30 (157 veces)
--   704 AVENA INSTANTANEA — 1.014 renglones; la más repetida es 20 (270 veces), no 30
--
-- 🪤 El dato de la 704 NO coincide con la bolsa declarada. Se carga 30 porque es lo que confirmó
-- Mati, y queda anotado: si empieza a marcar de más, el umbral a revisar es éste.
--
-- ── LAS QUE NO LLEGAN A L3 ─────────────────────────────────────────────────────────────────────
-- 12 de las 31 legumbres NO tienen precio cargado en la Lista 3 de InfoManager (verificado contra
-- /listaprecios/items/14). Habilitarles L3 les daría un "derecho" que no se puede ejercer, y el
-- control empezaría a marcar como error cada venta en L2 — el mismo problema que tuvo el MAIZ
-- CUARENTIN en la migración 025. Les queda techo L2 con el umbral nuevo de 10 kg.
-- Si algún día les cargan el precio en L3, se borra su excepción y heredan el subrubro.
--
-- No se tocan 700 ARROZ, 716 HARINA DE MAIZ ni 722 POLENTA: ya tienen regla propia.

-- ── 1. El subrubro: de 20 a 10 kg ──────────────────────────────────────────────────────────────
update listas_reglas set umbral = 10, updated_at = now()
 where tenant_id = '00000000-0000-0000-0000-000000000001'
   and match_tipo = 'subrubro' and match_valor = 'Legumbres'
   and cod_lista in (12, 13) and condicion in ('max', 'min') and unidad = 'kg';

-- ── 2. L3 por cantidad, que antes sólo salía con la promo general ──────────────────────────────
insert into listas_reglas (nombre, match_tipo, match_valor, cod_lista, condicion, umbral, unidad, ambito, activo, nota)
select 'LEGUMBRES (salvo polenta y harina de trigo)', 'subrubro', 'Legumbres', 14, 'min', 10, 'kg', 'articulo', true,
       'Mati 16/09/2026: "legumbres es L3 desde los 10 kg". Antes L3 sólo salía con la promo general de 10 bultos.'
 where not exists (
   select 1 from listas_reglas where tenant_id = '00000000-0000-0000-0000-000000000001'
     and match_tipo = 'subrubro' and match_valor = 'Legumbres' and cod_lista = 14 and condicion = 'min');

-- ── 3. Las avenas, por bolsa de 30 kg ──────────────────────────────────────────────────────────
insert into listas_reglas (nombre, match_tipo, match_valor, cod_lista, condicion, umbral, unidad, ambito, activo, nota)
select * from (values
  ('AVENA ARROLLADA (bolsa 30 kg)',   'articulo', '703', 12, 'max',           30, 'kg',    'articulo', true,  'Mati 16/09/2026: "las bolsas de avena son de 30 kg". 30 es la cantidad mas repetida en 30 dias (157 de 933 renglones).'),
  ('AVENA ARROLLADA (bolsa 30 kg)',   'articulo', '703', 13, 'min',           30, 'kg',    'articulo', true,  'Mati 16/09/2026: el mejor precio se habilita por bolsa recien.'),
  ('AVENA ARROLLADA (bolsa 30 kg)',   'articulo', '703', 14, 'min',           30, 'kg',    'articulo', true,  'Mati 16/09/2026: el mejor precio se habilita por bolsa recien. Tiene precio cargado en L3 (1626,96).'),
  ('AVENA ARROLLADA (bolsa 30 kg)',   'articulo', '703', 14, 'promo_general', 10, 'bulto', 'pedido',   true,  'Se conserva la promo general del subrubro: la regla por articulo reemplaza TODAS las del subrubro.'),
  ('AVENA INSTANTANEA (bolsa 30 kg)', 'articulo', '704', 12, 'max',           30, 'kg',    'articulo', true,  'Mati 16/09/2026: "las bolsas de avena son de 30 kg". OJO: la cantidad mas repetida en 30 dias es 20 (270 de 1014 renglones), no 30. Si marca de mas, revisar este umbral.'),
  ('AVENA INSTANTANEA (bolsa 30 kg)', 'articulo', '704', 13, 'min',           30, 'kg',    'articulo', true,  'Mati 16/09/2026: el mejor precio se habilita por bolsa recien.'),
  ('AVENA INSTANTANEA (bolsa 30 kg)', 'articulo', '704', 14, 'min',           30, 'kg',    'articulo', true,  'Mati 16/09/2026: el mejor precio se habilita por bolsa recien. Tiene precio cargado en L3 (1684,74).'),
  ('AVENA INSTANTANEA (bolsa 30 kg)', 'articulo', '704', 14, 'promo_general', 10, 'bulto', 'pedido',   true,  'Se conserva la promo general del subrubro: la regla por articulo reemplaza TODAS las del subrubro.')
) as v(nombre, match_tipo, match_valor, cod_lista, condicion, umbral, unidad, ambito, activo, nota)
 where not exists (
   select 1 from listas_reglas r where r.tenant_id = '00000000-0000-0000-0000-000000000001'
     and r.match_tipo = 'articulo' and r.match_valor = v.match_valor
     and r.cod_lista = v.cod_lista and r.condicion = v.condicion);

-- ── 4. Las 12 sin precio en L3: techo L2, con el umbral nuevo ──────────────────────────────────
insert into listas_reglas (nombre, match_tipo, match_valor, cod_lista, condicion, umbral, unidad, ambito, activo, nota)
select 'LEGUMBRES SIN PRECIO EN L3', 'articulo', v.cod, l.cod_lista, l.condicion, 10, 'kg', 'articulo', true,
       'Sin precio cargado en la Lista 3 de IM (verificado 16/09/2026 contra /listaprecios/items/14): habilitarle L3 marcaria como error cada venta en L2. Si le cargan el precio, borrar estas dos filas y hereda el subrubro.'
  from (values ('706'),('707'),('711'),('712'),('713'),('714'),('715'),('726'),('729'),('10471'),('10472'),('10700')) as v(cod)
 cross join (values (12, 'max'), (13, 'min')) as l(cod_lista, condicion)
 where not exists (
   select 1 from listas_reglas r where r.tenant_id = '00000000-0000-0000-0000-000000000001'
     and r.match_tipo = 'articulo' and r.match_valor = v.cod and r.cod_lista = l.cod_lista);
