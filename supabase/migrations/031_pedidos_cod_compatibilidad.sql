-- Migration 031 — guardar el cod_compatibilidad con el que se creó el presupuesto (03/09/2026).
-- Idempotente.
--
-- Para qué: cuando IM tarda más de 25 s y la app corta por timeout, NO sabemos si el
-- presupuesto entró. Hoy el pedido queda congelado en `sin_respuesta` y, si el presupuesto
-- SÍ había entrado, quedan DOS vivos del mismo cliente y nadie los reconcilia (pasó el
-- 02/09/2026 con PARRILLA 58067/58068 y DIAZ 58071/58072, limpiados a mano).
--
-- 🔑 `cod_compatibilidad` es único POR INTENTO, lo generamos nosotros y —lo importante—
-- InfoManager lo DEVUELVE en la cabecera y también en el listado `/ventas`. Guardándolo
-- ANTES de llamar a IM, después del timeout se puede preguntar "¿existe un presupuesto con
-- este código?" y resolver solo: si está, se adopta y se anula el viejo; si no está, el
-- pedido nunca entró.
--
-- En `crearPedido` el código ya era determinista (`pedido.id.slice(0,8)`), así que para ese
-- caso la columna es sólo comodidad. En `editarPedido` es `randomUUID().slice(0,8)` —
-- aleatorio a propósito, porque uno determinista colisiona en cada reintento (bug del
-- 28/08) — y sin esta columna se perdía apenas fallaba la llamada.

alter table pedidos_vendedor
  add column if not exists im_cod_compatibilidad text;

comment on column pedidos_vendedor.im_cod_compatibilidad is
  'cod_compatibilidad del ULTIMO intento de crear el presupuesto en IM (8 chars). Se escribe ANTES de llamar a IM para poder reconciliar despues de un timeout. NULL = pedido anterior al 03/09/2026.';

-- La reconciliación busca por este código entre las ventas del rango; el índice es para
-- encontrar rápido el pedido a partir del código, no al revés.
create index if not exists pedidos_vendedor_cod_compat_idx
  on pedidos_vendedor (tenant_id, im_cod_compatibilidad)
  where im_cod_compatibilidad is not null;
