-- Migration 052 — CEREALES vuelve a 25/30/35/40 · FLECKY y ZIMPI: L3 desde 6 (23/09/2026). Idempotente.
--
-- Mati: *"Lista 1 25% 1 unidades · Lista 2 30% 5 unidades · Lista 3 35% 10 unidades · Lista 4 40%
-- 30 unidades, y el flecky: lista 3 ahora es a partir de las 6 unidades y lista 4 a partir de 20
-- unidades.. igual que el zimpy"*.
--
-- CEREALES PARA DESAYUNO — el descuento alternativo sobre L1:
--   ANTES (050, 21/09):  25% / 25% / 30% / 40%   desde 1 / 5 / 10 / 30 unidades
--   AHORA:               25% / 30% / 35% / 40%   desde 1 / 5 / 10 / 30 unidades
-- Las listas (L2/L3/L4 desde 5/10/30 unidades de la línea) no cambian.
--
-- FLECKY + FULLCAT:  L3 desde 10 → 6 unidades.  L4 sigue desde 20.
-- ZIMPI:             L3 desde  5 → 6 unidades.  L4 sigue desde 20.
--
-- 🪤 Zimpi NO estaba en 6 sino en 5. "Igual que el zimpy" deja a las dos líneas con los mismos
--    umbrales (6 y 20), que es lo que se pidió en cualquiera de las dos lecturas de la frase.
--    Consecuencia a la vista: quien lleva exactamente 5 bolsas de Zimpi pasa de L3 a L1.
-- 🪤 Zimpi está cargado DOS veces, una por cada grafía del subrubro en InfoManager ("Zimpi" y
--    "Zimpy"): van las dos filas, o la mitad de los artículos quedaría con el umbral viejo.
--
-- Aplicado el 23/09/2026 con UPDATE directo, controlando que cada uno tocara exactamente una
-- fila, y verificado simulando con `evaluarPedido` sobre artículos reales en cada borde.
begin;

update descuentos_reglas
   set porcentaje_max = 30, updated_at = now()
 where tenant_id = '00000000-0000-0000-0000-000000000001'
   and match_tipo = 'subrubro' and match_valor = 'Cereales para desayuno'
   and desde_cantidad = 5 and requiere_lista = 12;

update descuentos_reglas
   set porcentaje_max = 35, updated_at = now()
 where tenant_id = '00000000-0000-0000-0000-000000000001'
   and match_tipo = 'subrubro' and match_valor = 'Cereales para desayuno'
   and desde_cantidad = 10 and requiere_lista = 12;

update listas_reglas
   set umbral = 6,
       nota = 'Mati 23/09/2026: "lista 3 ahora es a partir de las 6 unidades". Antes 10 (migracion 049).',
       updated_at = now()
 where tenant_id = '00000000-0000-0000-0000-000000000001'
   and match_tipo = 'subrubro' and match_valor = 'Flecky'
   and cod_lista = 14 and condicion = 'min' and unidad = 'unidad';

update listas_reglas
   set umbral = 6,
       nota = 'Mati 23/09/2026: igual que Flecky, L3 desde 6. Antes 5.',
       updated_at = now()
 where tenant_id = '00000000-0000-0000-0000-000000000001'
   and match_tipo = 'subrubro' and match_valor in ('Zimpi', 'Zimpy')
   and cod_lista = 14 and condicion = 'min' and unidad = 'unidad';

commit;
