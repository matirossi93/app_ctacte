-- Migration 025 — Los 4 artículos que quedaban sin regla (27/08/2026). Idempotente.
--
-- Mati, por WhatsApp: "la vicia es lo mismo que la colza, que la vitamina y el cuarentin
-- igual", y mandó la foto de la fila de SOJA de la planilla (menos de 20 kilos / a partir
-- de 20 kilos / 10 bultos promo general). O sea: los cuatro siguen el patrón COLZA,
--   L1 = hasta 20 kg · L2 = desde 20 kg · L3 = promo general de 10 bultos
-- que es el mismo que ya tienen alpiste, mijo, sorgo, sésamo, cártamo y girasol.
--
-- Los códigos se verificaron uno por uno contra el catálogo crudo de IM y contra las ventas
-- reales de Casa Central (7.365 renglones facturados entre el 15/07 y el 06/08/2026,
-- descontando los renglones a sucursales, que son movimiento interno):
--
--   404 SOJA            Cereales · granel por kilo  ->  6 renglones mayoristas (L1=5, L2=1)
--   474 VICIA           Forrajes · granel por kilo  ->  8 renglones mayoristas (L1=2, L3=6)
--   475 VITAMINA        Forrajes · granel por kilo  -> 11 renglones mayoristas (L1=4, L2=2, L3=5)
--   461 MAIZ CUARENTIN  Maiz     · granel por kilo  -> 14 renglones mayoristas (L2=14)
--   456 COLZA (la referencia, ya sembrada)          -> 11 renglones mayoristas (L1=8, L2=1, L3=2)
--
-- Qué queda AFUERA y por qué (los otros artículos que traen la misma palabra en el nombre):
--   · 411 SOJA TEXTURIZADA X KG — es el espejo fraccionado de mostrador.
--   · 552 EXPELLER DE SOJA, 560 SOJA DESACTIVADA — subrubro Insumos: son insumos de la
--     planta, no reventa. 0 renglones facturados.
--   · 573 SOJA DESACTIVADA SAN JUAN — artículo de la sucursal (ni siquiera tiene stock en
--     el depósito 1). Mismo criterio que el 10460 MIX SEMILLAS SAN JUAN, ya excluido.
--   · 12602 ANTIVITAMINICO X KG, 12610 y 12611 VITAMINA LIQ — frascos de líquido para aves,
--     subrubro "Accesorios Aves", que YA tiene regla activa 'libre' en L1-L4. Ponerles regla
--     por artículo les sacaría ese 'libre' (la regla por código le gana a la del subrubro) y
--     empezaría a marcarles error a los vendedores. 0 renglones facturados los tres.
--   · 469 MEZCLA GALLO PREM C/CUARENTIN, 480 MEZCLA CON CUARENTIN — son mezclas, ya cubiertas
--     por la regla de subrubro "Mezclas".
--
-- ⚠️ PENDIENTE DE RESPUESTA — MAIZ CUARENTIN (461) Y LA LISTA 3:
-- Se sembró tal cual lo dijo Mati, pero el dato no lo acompaña y conviene mirarlo. En las
-- 3 semanas medidas el 461 se facturó 14 veces al mayorista y las 14 salieron en LISTA 2,
-- todas al mismo precio, con 5 vendedores distintos. Doce de esas 14 caen en facturas que
-- pasaban los 10 bultos, o sea que la promo general estaba disponible y facturación igual
-- no le dio L3 ni una vez. Comparado con sus hermanos en la misma situación: colza 2 de 2,
-- vitamina 4 de 5, vicia 3 de 4, mijo 22 de 25, alpiste 15 de 21. El cuarentín, 0 de 12.
-- La sospecha es que el 461 no tenga precio cargado en la Lista 3 de IM.
-- Si es así, la fila de L3 de abajo hay que desactivarla (un update de una línea). Mientras
-- tanto queda activa, porque el costo de equivocarse en ese sentido es que el validador se
-- quede callado, y en el otro sentido sería marcarle error a una venta legítima.

-- SOJA: las 3 filas ya existían con activo=false, esperando que Mati confirmara a cuál de
-- los 5 artículos con "SOJA" aplicaba. Ya está confirmado: solo al 404.
update listas_reglas
   set activo = true,
       nota = 'Mati 27/08: sigue el patron de la colza. De los 5 arts con SOJA solo el 404 se factura al mayorista (6 renglones en 3 semanas). El 411 es el espejo X KG, el 552 y el 560 son insumos de planta y el 573 es de la sucursal San Juan: 0 renglones los cuatro.',
       updated_at = now()
 where match_tipo = 'articulo' and match_valor = '404';

insert into listas_reglas (nombre, match_tipo, match_valor, cod_lista, condicion, umbral, unidad, ambito, activo, nota) values
  ('VICIA', 'articulo', '474', 12, 'max', 20, 'kg', 'articulo', true, 'Mati 27/08: "la vicia es lo mismo que la colza". Hay una sola vicia en el catalogo. 8 renglones mayoristas en 3 semanas (10 totales menos 2 a sucursal).'),
  ('VICIA', 'articulo', '474', 13, 'min', 20, 'kg', 'articulo', true, 'Mati 27/08: "la vicia es lo mismo que la colza". Hay una sola vicia en el catalogo. 8 renglones mayoristas en 3 semanas (10 totales menos 2 a sucursal).'),
  ('VICIA', 'articulo', '474', 14, 'promo_general', 10, 'bulto', 'pedido', true, 'Mati 27/08: "la vicia es lo mismo que la colza". Hay una sola vicia en el catalogo. 8 renglones mayoristas en 3 semanas (10 totales menos 2 a sucursal).'),

  ('VITAMINA', 'articulo', '475', 12, 'max', 20, 'kg', 'articulo', true, 'Mati 27/08: mismo patron que la colza. Es el granel por kilo del subrubro Forrajes. Las otras 3 vitaminas (12602 antivitaminico, 12610 y 12611 liquidas) son de Accesorios Aves y heredan el "libre" de ese subrubro: NO tocarlas.'),
  ('VITAMINA', 'articulo', '475', 13, 'min', 20, 'kg', 'articulo', true, 'Mati 27/08: mismo patron que la colza. Es el granel por kilo del subrubro Forrajes. Las otras 3 vitaminas (12602 antivitaminico, 12610 y 12611 liquidas) son de Accesorios Aves y heredan el "libre" de ese subrubro: NO tocarlas.'),
  ('VITAMINA', 'articulo', '475', 14, 'promo_general', 10, 'bulto', 'pedido', true, 'Mati 27/08: mismo patron que la colza. Es el granel por kilo del subrubro Forrajes. Las otras 3 vitaminas (12602 antivitaminico, 12610 y 12611 liquidas) son de Accesorios Aves y heredan el "libre" de ese subrubro: NO tocarlas.'),

  ('MAIZ CUARENTIN', 'articulo', '461', 12, 'max', 20, 'kg', 'articulo', true, 'Mati 27/08: mismo patron que la colza. Ojo: en 3 semanas no se facturo ni un renglon por debajo de 20 kg, asi que esta rama no la confirma el dato (tampoco la contradice).'),
  ('MAIZ CUARENTIN', 'articulo', '461', 13, 'min', 20, 'kg', 'articulo', true, 'Mati 27/08: mismo patron que la colza. Los 14 renglones mayoristas de 3 semanas salieron todos por aca (Lista 2), al mismo precio.'),
  ('MAIZ CUARENTIN', 'articulo', '461', 14, 'promo_general', 10, 'bulto', 'pedido', true, 'PENDIENTE DE CONFIRMAR (ver cabecera de la migracion 025): 0 de 12 facturas que pasaban los 10 bultos usaron L3, contra 2/2 de la colza y 4/5 de la vitamina. Puede que el 461 no tenga precio cargado en la Lista 3 de IM. Si es asi, poner activo=false.')
on conflict (tenant_id, match_tipo, match_valor, cod_lista) do update set
  nombre = excluded.nombre, condicion = excluded.condicion, umbral = excluded.umbral,
  unidad = excluded.unidad, ambito = excluded.ambito, activo = excluded.activo,
  nota = excluded.nota, updated_at = now();
