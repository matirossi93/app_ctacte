-- 029 — Contador de visitas por sección (Mati 29/08/2026)
--
-- Para qué: decidir con datos qué secciones de la app de vendedores sobran. Hoy sólo se puede
-- medir lo que la gente CARGA (cobranzas, pedidos, actividad); las secciones de consulta —Hoy,
-- Objetivos, Comisiones, Rebotes— no dejan ninguna huella, así que no hay forma de saber si
-- alguien las mira. Se midió el 29/08 y quedó a la vista: Actividad tenía 6 registros en toda
-- su historia (se sacó), pero de Rebotes y Objetivos no se puede afirmar nada.
--
-- Una fila por vez que un vendedor abre una sección. Con ~10 usuarios son unos cientos de
-- filas por día: nada. Se mira a las 2 semanas y se decide.
--
-- 🔑 No lleva `id` ni PK: es una tabla de conteo, sólo se inserta y se agrupa. Tampoco lleva
-- FK a usuarios — si mañana se borra un usuario, no queremos que falle el borrado ni perder
-- el histórico de uso.

create table if not exists section_views (
  tenant_id    uuid        not null,
  seccion      text        not null,
  cod_vendedor int,
  created_at   timestamptz not null default now()
);

-- El único acceso que va a tener: "cuántas visitas por sección en tal período".
create index if not exists section_views_tenant_seccion_fecha
  on section_views (tenant_id, seccion, created_at desc);

comment on table section_views is
  'Una fila por apertura de sección en la app de vendedores. Sirve para decidir qué sacar del menú; se puede vaciar cuando ya no haga falta.';
