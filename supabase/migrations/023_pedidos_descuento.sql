-- Migration 023 — Descuento porcentual por renglón (27/08/2026). Idempotente.
--
-- Pedido de Mati: los vendedores necesitan poder hacer un descuento en % sobre un renglón
-- puntual, además de elegir la lista. InfoManager ya lo soporta nativamente: el item de
-- VentasItemsPresupuestosCrear acepta `descuento_porc`, así que el comprobante muestra el
-- descuento por separado y facturación lo ve — mejor que mandar el precio ya rebajado, que
-- escondería el dato.
--
-- ⏳ Falta la parametrización de qué descuentos son válidos (Mati la va a pasar). Hasta
-- entonces el campo se guarda y se empuja a IM, pero NO se valida: el control de listas
-- sigue mirando sólo la lista elegida.

alter table pedidos_vendedor_items
  add column if not exists descuento_porc numeric(5,2) not null default 0
    check (descuento_porc >= 0 and descuento_porc <= 100);

comment on column pedidos_vendedor_items.descuento_porc is
  'Descuento porcentual aplicado a ESTE renglón, 0 a 100. Se manda a InfoManager como descuento_porc del item. El subtotal guardado ya lo tiene aplicado.';
