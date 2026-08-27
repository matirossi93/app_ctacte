-- Migration 026 — Usuario de InfoManager por vendedor (27/08/2026). Idempotente.
--
-- Los presupuestos que crea la app salen en IM con el usuario de la variable de entorno
-- IM_USUARIO_PEDIDOS, que es uno solo para toda la app (hoy "susana").
--
-- Ojo con qué es este campo: en IM `usuario` NO es el vendedor, es el OPERADOR que carga el
-- comprobante. Se verificó sobre los 1.052 comprobantes de Casa Central del 15/07 al 06/08:
-- jorgelina cargó 879 y susana 143, y cada una carga facturas de 6 o 7 vendedores distintos.
-- El vendedor viaja aparte, en `cod_vendedor`, y eso la app ya lo manda bien. Lo que cambia
-- es la columna de auditoría de carga: quién armó el pedido.
--
-- ⚠️ ESTA COLUMNA ES EL PLAN B, NO EL PRINCIPAL.
--
-- El lugar natural del login de cada vendedor es InfoManager: la ficha del vendedor tiene un
-- campo `usuario` (verificado el 27/08 con GET /vendedores — los 12 vendedores lo tienen,
-- todos en null porque nadie lo cargó todavía). Apenas lo carguen allá, la app lo toma sola
-- y no hay nada que mantener sincronizado de este lado.
--
-- El orden con el que resuelve `usuarioIM()` en server-lib/pedidos.ts es:
--   1. usuarios.im_usuario  ← esta columna. Override manual, gana siempre.
--   2. el campo `usuario` de la ficha del vendedor en IM.
--   3. IM_USUARIO_PEDIDOS, el usuario único de la app.
--
-- O sea que esta columna sirve para dos cosas: arreglar un caso puntual sin depender de que
-- alguien toque IM, y arrancar hoy si no se quiere esperar a cargarlo allá. Si queda vacía no
-- cambia el comportamiento de nada.
--
-- Para llenarla a mano (el valor tiene que ser el login EXACTO como existe en InfoManager: un
-- usuario que IM no reconozca puede hacer que rechace el presupuesto entero, así que copiarlo
-- de IM, no adivinarlo):
--
--   update usuarios set im_usuario = 'sebastian' where cod_vendedor = 2;   -- Sebastián
--   update usuarios set im_usuario = 'marcelo'   where cod_vendedor = 3;   -- Marcelo
--   update usuarios set im_usuario = 'julio'     where cod_vendedor = 4;   -- Julio
--   update usuarios set im_usuario = 'brian'     where cod_vendedor = 12;  -- Brian
--
-- (los logins de arriba son EJEMPLOS)
--
-- Para ver la ficha de los vendedores tal como la devuelve IM: GET /api/debug/im-vendedores
-- (requiere rol admin o gerente).

alter table usuarios add column if not exists im_usuario text;

comment on column usuarios.im_usuario is
  'Override del login de InfoManager con el que se crean los presupuestos de este vendedor. NULL = se toma el campo usuario de la ficha del vendedor en IM y, si tambien esta vacio, IM_USUARIO_PEDIDOS. Tiene que existir en IM y tener punto de venta vinculado.';
