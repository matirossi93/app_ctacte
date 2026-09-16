-- Migration 046 — Toda la línea EXACT con el mismo criterio (16/09/2026). Idempotente.
--
-- Mati: *"en el EXACT no se está contemplando el descuento que está habilitado"*, y después:
-- *"toda la línea exact tiene el mismo criterio"*.
--
-- Estaba cargada sólo la mitad: EXACT CRIADORES tiene L1/L2/L3 y su 5% de descuento con L3, y
-- EXACT PREMIUM tenía **sólo L1 y ningún descuento**. La regla de Premium está cargada además
-- con el nombre "EXCAT PREMIUM" —la c y la a cambiadas de lugar—, lo que sugiere que quedó a
-- medio hacer.
--
-- Medido sobre los 392 renglones de EXACT facturados del 01 al 16/09/2026:
--   · Exact Criadores · L3 + 5%  →  29 renglones (contemplados: tiene la regla)
--   · Exact Premium   · L3 + 5%  →  21 renglones (marcados como descuento no habilitado)
--   · Exact Premium   · L3 + 0%  →  22 renglones (marcados como margen perdido: sólo tenía L1)
--
-- Se le carga a Premium lo mismo que ya tiene Criadores: L2 y L3 libres, y el 5% de descuento
-- condicionado a la L3. No se toca ninguna regla de Criadores.

-- ── 1. Las listas que le faltaban a EXACT PREMIUM ──────────────────────────────────────────────
insert into listas_reglas (nombre, match_tipo, match_valor, cod_lista, condicion, umbral, unidad, ambito, activo, nota)
select 'EXACT PREMIUM', 'subrubro', 'Exact Premium', v.cod_lista, 'libre', null, null, null, true,
       'Mati 16/09/2026: "toda la linea exact tiene el mismo criterio". Copia lo que ya tenia Exact Criadores; antes Premium solo tenia L1 y sus 22 ventas en L3 se marcaban como margen perdido.'
  from (values (13), (14)) as v(cod_lista)
 where not exists (
   select 1 from listas_reglas r where r.tenant_id = '00000000-0000-0000-0000-000000000001'
     and r.match_tipo = 'subrubro' and r.match_valor = 'Exact Premium' and r.cod_lista = v.cod_lista);

-- ── 2. El 5% con L3, igual que Criadores ───────────────────────────────────────────────────────
-- 🪤 `descuentos_reglas` NO tiene columna `nota` (sí la tiene `listas_reglas`): el motivo del
-- cambio vive en este comentario. Y se resuelve con `on conflict` sobre el único que ya existe
-- —(tenant, tipo, valor, desde_cantidad, requiere_lista)— en vez de un `not exists`.
insert into descuentos_reglas (nombre, match_tipo, match_valor, desde_cantidad, ambito, porcentaje_max, requiere_lista, requiere_mejor_lista, activo)
values ('EXACT PREMIUM', 'subrubro', 'Exact Premium', 1, 'articulo', 5, 14, false, true)
on conflict do nothing;

-- ── 3. El nombre con el typo, para que las dos filas viejas queden junto a las nuevas ──────────
update listas_reglas set nombre = 'EXACT PREMIUM', updated_at = now()
 where tenant_id = '00000000-0000-0000-0000-000000000001'
   and match_tipo = 'subrubro' and match_valor = 'Exact Premium' and nombre = 'EXCAT PREMIUM';
