-- Migration 010 — hora_promesa opcional en vendor_activity.
-- Idempotente.
--
-- Motivación: hoy `fecha_promesa DATE` solo guarda el día. El vendedor o el
-- admin quieren poder cargar "recordame el viernes a las 14:30" para llamadas
-- y visitas pautadas. Agregamos una columna nueva en lugar de migrar el tipo
-- de fecha_promesa para no romper:
--   - el backend de /api/notificaciones que parsea `fp + 'T00:00:00Z'`
--   - las promesas históricas (siguen siendo válidas, hora_promesa NULL = sin
--     hora específica, ordenamos al final del día como veníamos haciendo)

alter table vendor_activity
  add column if not exists hora_promesa time;
