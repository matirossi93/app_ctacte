-- 030 — Socios: cuáles son dueños de TODA la empresa (Mati 31/08/2026)
--
-- El rol `socio` junta dos cosas distintas que la app venía tratando como una sola:
--   · elvio y andrea  → dueños de TODA la empresa
--   · enzo y daniel   → dueños SÓLO de su sucursal (Jujuy y San Juan)
--
-- 🪤 NO se puede deducir de `cod_empresa`. Ese campo es la unidad desde la que el usuario
-- EMITE (depósito y punto de venta de InfoManager — ver sucursales.ts / perfilUsuario.ts), no
-- lo que puede MIRAR: elvio tiene cod_empresa=2 (BRS) y sin embargo ve toda la empresa.
-- Deducirlo fue exactamente el bug del 31/08: /api/cartera le servía la cartera entera de
-- Casa Central a los cuatro socios por igual, porque tomaba la empresa del query con default 1.
--
-- Va como flag explícito por el mismo motivo que `ve_todos_los_clientes` (migración 028):
-- que hoy enzo sea sólo de Jujuy no significa que mañana no pueda ser de todo, y al revés.
--
-- Por defecto FALSE: el que no está marcado ve su unidad y nada más.
-- Idempotente.

alter table usuarios
  add column if not exists ve_toda_la_empresa boolean not null default false;

comment on column usuarios.ve_toda_la_empresa is
  'true = ve los datos de todas las unidades (dueño de la empresa). false = sólo su cod_empresa. NO se deduce de cod_empresa, que es la unidad de emisión.';

-- Los dos dueños de toda la empresa, confirmados por Mati el 31/08/2026.
update usuarios
   set ve_toda_la_empresa = true
 where rol = 'socio'
   and email in ('elvio@semillero', 'andrea@semillero');
