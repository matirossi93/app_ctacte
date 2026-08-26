-- Migration 022 — Artículos excluidos del control de listas (26/08/2026). Idempotente.
--
-- Hay artículos que están adentro de un subrubro con regla, pero que NO participan del
-- circuito mayorista y por lo tanto no hay que controlarles la lista. Sin esto heredan
-- la condición de su línea y el validador opina sobre algo que no debería.
--
-- Los dos casos que aparecieron el 26/08:
--   · 13818 FORRAJES VARIOS — Mati: "lo usamos para facturar a consumidor final, se
--     excluye de todos los circuitos". Es el artículo MAS facturado de Casa Central
--     (308 renglones en 3 semanas, todos en L1).
--   · La planilla dice "LEGUMBRES (salvo polenta y harina de trigo)": esa excepción no
--     se puede expresar por subrubro porque en IM viven todos adentro de "Legumbres".
--
-- Una regla con condicion='excluido' hace que el artículo no se evalúe. Como las reglas
-- por artículo le ganan a las del subrubro, alcanza con una fila por código.

alter table listas_reglas drop constraint if exists listas_reglas_condicion_check;
alter table listas_reglas add constraint listas_reglas_condicion_check
  check (condicion in ('libre','promo_general','min','max','excluido'));

comment on column listas_reglas.condicion is
  'libre = habilita sin condicion de cantidad · promo_general = habilita si el pedido llega a 10 bultos · min/max = condicion por cantidad (las unicas que generan derecho) · excluido = el articulo no se controla.';
