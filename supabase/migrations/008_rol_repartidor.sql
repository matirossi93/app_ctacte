-- Panel Vendedor — Migration 008
-- Agrega el rol 'repartidor' a la tabla usuarios.
-- Idempotente: se puede correr varias veces sin romper.
--
-- Contexto: los repartidores también reciben transferencias de clientes al
-- entregar mercadería, así que necesitan cargar comprobantes en la app y
-- consultar los cargados por los vendedores (para saber si el cliente ya pagó).
-- No hacen ventas ni siguen cuenta corriente.

-- Recrear el CHECK de rol incluyendo 'repartidor'. El constraint original lo
-- nombró Postgres como usuarios_rol_check (ver migration 001).
alter table usuarios drop constraint if exists usuarios_rol_check;
alter table usuarios add constraint usuarios_rol_check
  check (rol in ('admin','gerente','vendedor','repartidor'));
