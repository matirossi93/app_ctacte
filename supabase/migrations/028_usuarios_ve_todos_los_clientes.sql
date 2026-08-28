-- 028 — Usuarios de mostrador: ven todos los clientes (Mati 28/08/2026)
--
-- Un `rol = 'vendedor'` sólo ve los clientes cuyo cod_vendedor coincide con el suyo. Para los
-- usuarios de sucursal eso no sirve: atienden un MOSTRADOR, les entra cualquier cliente por la
-- puerta, y el filtro les esconde justo al que tienen enfrente.
--
-- Va como flag explícito y NO se deduce de tener `cod_empresa`: que BRS atienda por mostrador
-- hoy no significa que mañana no pueda tener vendedores con cartera propia.
--
-- Por defecto FALSE: los vendedores que ya existen siguen viendo sólo los suyos.

alter table usuarios
  add column if not exists ve_todos_los_clientes boolean not null default false;

comment on column usuarios.ve_todos_los_clientes is
  'true = ve el maestro completo de clientes (mostrador de sucursal). false = sólo su cartera.';
