-- 018 — un solo usuario por cod_vendedor
--
-- Incidente 10/08/2026: `usuarios` sólo tenía un índice COMÚN sobre cod_vendedor
-- (001_panel_vendedor.sql:25). El 31/07 un script de diagnóstico dejó
-- diag.vendedor@semillero.test con cod_vendedor 12 (el de Brian) y activo=true, y el
-- Ranking del panel pasó a mostrar "DIAG vendedor" en el puesto de Brian.
--
-- El código ya no depende de esto (server-lib/usuariosPorCod.ts elige la fila canónica),
-- pero el índice evita que el dato se vuelva a ensuciar en origen.
--
-- ⚠️ ORDEN OBLIGATORIO: primero limpiar los duplicados, después correr esto. Si queda
-- un cod repetido, la creación del índice FALLA (y no rompe nada, simplemente no se crea).
-- Para ver qué habría que limpiar antes:
--
--   select cod_vendedor, count(*), array_agg(email order by created_at)
--   from usuarios where cod_vendedor is not null
--   group by tenant_id, cod_vendedor having count(*) > 1;
--
-- ⚠️ CONSECUENCIA OPERATIVA: el día que un vendedor se va y otro hereda su cod, hay que
-- nulear primero el cod del que se fue. Además createUsuario (server-lib/usuarios.ts:57)
-- mapea el error 23505 a "Email ya existe", así que un choque por cod mostraría ese
-- mensaje equivocado en el panel de admin.

create unique index if not exists usuarios_tenant_cod_vendedor_uidx
  on usuarios (tenant_id, cod_vendedor)
  where cod_vendedor is not null;
