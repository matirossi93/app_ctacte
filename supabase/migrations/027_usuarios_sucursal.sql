-- 027 — A qué unidad pertenece cada usuario (Mati 28/08/2026)
--
-- Hasta ahora el módulo de pedidos asumía CASA CENTRAL para todo el mundo: la empresa, el
-- depósito del buscador y el punto de venta salían de variables de entorno globales. Las
-- sucursales van a presupuestar a clientes mayoristas con las mismas listas, así que cada
-- usuario necesita decir de qué unidad es.
--
-- NULL = casa central. Los usuarios que ya existen no se tocan y siguen andando igual.
--
-- Los códigos (ver server-lib/sucursales.ts):
--   1 Casa Central (dep 1)  ·  2 BRS (dep 2)  ·  3 San Juan (dep 3)  ·  4 Jujuy (dep 6)
-- ⚠️ La empresa y el depósito NO son el mismo número: Jujuy es empresa 4 y depósito 6.

alter table usuarios
  add column if not exists cod_empresa int;

comment on column usuarios.cod_empresa is
  'Unidad del usuario en InfoManager: 1 Casa Central, 2 BRS, 3 San Juan, 4 Jujuy. NULL = casa central.';

-- Que no entre una empresa que no existe. El 6 es el DEPOSITO de Jujuy, no una empresa: es
-- justo el error que tenía la lista blanca del código.
alter table usuarios
  drop constraint if exists usuarios_cod_empresa_valida;
alter table usuarios
  add constraint usuarios_cod_empresa_valida
  check (cod_empresa is null or cod_empresa in (1, 2, 3, 4));
