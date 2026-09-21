-- Migration 050 — CEREALES PARA DESAYUNO: el descuento sobre L1 baja en dos escalones
-- (21/09/2026). Idempotente.
--
-- Mati: *"hay que cambiar las condiciones para los cereales para desayuno: L1 por unidad y se le
-- puede hacer un 25% de desc... lista 2: a partir de 5 unidades, se puede hacer un 25% de desc
-- también sobre lista 1 (son iguales prácticamente)... más de 10 unidades: lista 3 o lista 1 con
-- un 30% de desc, y más de 30 unidades: lista 4 o lista 1 con un 40% de descuento"*.
--
-- 🔑 LAS REGLAS DE LISTA NO SE TOCAN: ya estaban así desde la 035 y coinciden con lo pedido
-- (L1 libre · L2 desde 5 unidades · L3 desde 10 · L4 desde 30, ámbito línea). Lo único que
-- cambiaba era el descuento equivalente sobre L1, y BAJA:
--
--   desde 1 unidad   25%  →  25%   (igual)
--   desde 5          30%  →  25%
--   desde 10         35%  →  30%
--   desde 30         40%  →  40%   (igual)
--
-- Así cada escalón vuelve a ser la alternativa exacta de su lista: o se va a L3, o se queda en
-- L1 con el 30% que da el mismo precio. Con 35% el camino del descuento salía más barato que la
-- lista, y era el mismo producto.
--
-- ⚠️ Es un cambio A LA BAJA: un renglón en L1 con 35% que hoy pasa el control, desde ahora sale
-- marcado. No se toca nada de lo ya vendido — el control mira el pedido que tiene delante.
--
-- 🪤 El subrubro es 'Cereales para desayuno' (41 artículos: almohaditas, anillos, granolas) y NO
-- 'Cereales', que son las semillas a granel (alpiste, lino, mijo). Son dos subrubros distintos
-- con nombres casi iguales.
begin;

update descuentos_reglas
   set porcentaje_max = 25, updated_at = now()
 where tenant_id = '00000000-0000-0000-0000-000000000001'
   and match_tipo = 'subrubro' and match_valor = 'Cereales para desayuno'
   and desde_cantidad = 5 and requiere_lista = 12;

update descuentos_reglas
   set porcentaje_max = 30, updated_at = now()
 where tenant_id = '00000000-0000-0000-0000-000000000001'
   and match_tipo = 'subrubro' and match_valor = 'Cereales para desayuno'
   and desde_cantidad = 10 and requiere_lista = 12;

commit;
