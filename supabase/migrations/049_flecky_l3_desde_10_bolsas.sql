-- Migration 049 — FLECKY: L3 desde 10 bolsas y L4 desde 20 (21/09/2026). Idempotente.
--
-- Mati: *"necesito que cambiemos la proporción de flecky de nuevo... lista 3 por 10 bolsas y
-- lista 4 con 20 bolsas"*.
--
--   ANTES:  L3 desde 20 unidades · L4 desde 30 unidades
--   AHORA:  L3 desde 10 unidades · L4 desde 20 unidades
--
-- Los dos umbrales son de ÁMBITO LÍNEA y en UNIDADES: se suman las bolsas de toda la línea
-- FLECKY + FULLCAT (surtido), no las de un artículo ni sus kilos. Una bolsa de 15 kg y una de
-- 20 cuentan una cada una (ver `medirRenglon`: para un artículo por bulto, `unidades` es la
-- cantidad pedida).
--
-- 🔑 L1 y L2 no se tocan: L1 queda libre y L2 se sigue habilitando por la promo general de 10
-- bultos del PEDIDO. Con L3 a 10 bolsas de la línea, L2 le queda al que llega a 10 bultos
-- surtidos con menos de 10 Flecky — que es justo para lo que estaba.
--
-- 🪤 El UPDATE va por (match_valor, cod_lista, condicion) y NO por id: los ids salieron del
-- generador de la 035 y no son estables entre entornos.
begin;

update listas_reglas
   set umbral = 10,
       nota = 'Mati 21/09/2026: "lista 3 por 10 bolsas". Antes 20 (migracion 035).',
       updated_at = now()
 where tenant_id = '00000000-0000-0000-0000-000000000001'
   and match_tipo = 'subrubro' and match_valor = 'Flecky'
   and cod_lista = 14 and condicion = 'min' and unidad = 'unidad';

update listas_reglas
   set umbral = 20,
       nota = 'Mati 21/09/2026: "lista 4 con 20 bolsas". Antes 30 (migracion 035).',
       updated_at = now()
 where tenant_id = '00000000-0000-0000-0000-000000000001'
   and match_tipo = 'subrubro' and match_valor = 'Flecky'
   and cod_lista = 15 and condicion = 'min' and unidad = 'unidad';

commit;
