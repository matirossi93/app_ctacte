-- Migration 051 — Cuando se anula la factura y el remito queda vivo (22/09/2026). Idempotente.
--
-- EL CASO QUE LA MOTIVA, medido contra IM el 22/09/2026 (BUSTOS):
--
--   El vendedor cargó un pedido a BUSTOS, Rafael (522) y era de BUSTOS, Roberto (124). Se emitió
--   FA 50695 + RE 77809 al cliente equivocado. La oficina borró la factura en IM, rehizo el
--   pedido para Roberto (PR 58846 → FA 50742 + RE 77886) y ahí terminó lo que podía hacer.
--
--   Cuatro días después seguían vivos: el RE 77809 —descontando por segunda vez los mismos 9
--   artículos— y un presupuesto duplicado que cualquiera podía facturar. La app los había
--   detectado y decía *"conciliá también el remito antes de emitir otro pedido"*: un cartel, no
--   una salida. Lo único que podía hacer la oficina desde la app era rehacer el pedido, y
--   facturar ese pedido nuevo emite factura **y remito**, o sea un tercer remito por la misma
--   mercadería.
--
-- 🔑 SON DOS CASOS DISTINTOS Y LA APP NO PUEDE ADIVINAR CUÁL ES. Anulada la factura, el remito
--    que quedó vivo puede ser basura (el pedido estaba mal) o puede ser correcto (la mercadería
--    salió y lo que estaba mal era el importe). La única que lo sabe es la persona que tiene el
--    remito en la mano; lo que faltaba era que pudiera decirlo sin salir de la app.
--
-- Acá va lo que hace falta para el segundo caso: `factura_pendiente`, el espejo exacto de
-- `remito_pendiente`. Con el remito vivo y sin factura, apretar Facturar emite SÓLO la factura y
-- le engancha el remito que ya existe (ver facturarPresupuestos.ts, paso 2·bis).
begin;

-- Qué facturas tuvo antes este pedido. Es el espejo de `historial_remitos`: sin esto, rehacer la
-- factura sobre un remito vivo borra el número de la que se anuló y nadie puede rastrear después
-- por qué la hoja de ruta decía otra cosa.
alter table presupuestos_facturados
  add column if not exists historial_facturas jsonb not null default '[]';

comment on column presupuestos_facturados.historial_facturas is
  'Las facturas anuladas o borradas en IM que tuvo este pedido antes de la vigente.';

/**
 * El reclamo de la factura que falta. Espejo de `tomar_remito` (migración 039), y por el mismo
 * motivo: el rol administrativo lo tienen dos personas, y sin un reclamo que choque las dos leen
 * "falta la factura" y las dos emiten. El `update` condicionado es el que frena a la segunda.
 *
 * 🪤 `im_remito_id is not null` NO es decorativo: es lo que distingue este camino del alta
 * normal. Sin remito vivo esto no es "rehacer la factura", es facturar de cero, y ese camino
 * pasa por `reclamar()` con su índice único.
 */
create or replace function tomar_factura(p_tenant uuid, p_id text, p_token uuid)
returns boolean language plpgsql security invoker set search_path = public as $$
begin
  update presupuestos_facturados
     set estado_emision = 'factura_emitiendo', claim_token = p_token, reclamado_at = now()
   where tenant_id = p_tenant and im_comprobante_id = p_id
     and im_factura_id is null and facturado_at is null
     and im_remito_id is not null and estado_emision = 'factura_pendiente';
  return found;
end $$;

revoke all on function tomar_factura(uuid, text, uuid) from public, anon, authenticated;
grant execute on function tomar_factura(uuid, text, uuid) to service_role;

commit;
