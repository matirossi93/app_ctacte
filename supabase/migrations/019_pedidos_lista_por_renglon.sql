-- Migration 018 — la lista de precios se guarda POR RENGLON (26/08/2026). Idempotente.
--
-- La 017 asumia una sola lista por pedido (la que el cliente tiene asignada en
-- InfoManager). Pero los vendedores NO trabajan asi: eligen la lista producto por
-- producto segun la cantidad — el mismo pedido puede tener un renglon en Lista 2
-- y otro en Lista 3. Sin esta columna no se puede saber con que lista se cotizo
-- cada item, que es justo lo que despues hay que controlar.
--
-- Listas de IM: 9=MINORISTA, 11=SUCURSALES, 12=LISTA1, 13=LISTA2, 14=LISTA3, 15=LISTA4.
-- Se deja NULL para los pedidos viejos (usaban la lista de la cabecera).

alter table pedidos_vendedor_items
  add column if not exists cod_lista_precios int;

comment on column pedidos_vendedor_items.cod_lista_precios is
  'Lista con la que se cotizo ESTE renglon (12=L1 13=L2 14=L3 15=L4). NULL = pedido anterior a 26/08/2026, se uso la lista de la cabecera.';

-- Para el control de listas: buscar renglones por lista sin escanear toda la tabla.
create index if not exists pedidos_vendedor_items_lista_idx
  on pedidos_vendedor_items (cod_lista_precios);
