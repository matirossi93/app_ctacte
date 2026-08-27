-- Migration 026 — Usuario de InfoManager por vendedor (27/08/2026). Idempotente.
--
-- Los presupuestos que crea la app salen en IM con el usuario de la variable de entorno
-- IM_USUARIO_PEDIDOS, que es uno solo para toda la app (hoy "susana"). Mati, 27/08: los
-- vendedores SÍ tienen usuario propio en InfoManager, así que se puede sincronizar.
--
-- Ojo con qué es este campo: en IM `usuario` NO es el vendedor, es el OPERADOR que carga el
-- comprobante. Se verificó sobre los 1.052 comprobantes de Casa Central del 15/07 al 06/08:
-- jorgelina cargó 879 y susana 143, y cada una carga facturas de 6 o 7 vendedores distintos.
-- El vendedor viaja aparte, en `cod_vendedor`, y eso la app ya lo manda bien. Lo que cambia
-- acá es la columna de auditoría de carga: quién armó el pedido.
--
-- La columna es un OVERRIDE opcional. Si está vacía se sigue usando la variable de entorno,
-- así que aplicar esta migración sola no cambia el comportamiento de nada.
--
-- ⚠️ El valor tiene que ser el login EXACTO como existe en InfoManager. Un usuario que IM no
-- reconozca puede hacer que rechace el presupuesto entero, así que no adivinar: copiarlo de
-- IM. Para llenarla:
--
--   update usuarios set im_usuario = 'sebastian' where cod_vendedor = 2;   -- Sebastián
--   update usuarios set im_usuario = 'marcelo'   where cod_vendedor = 3;   -- Marcelo
--   update usuarios set im_usuario = 'julio'     where cod_vendedor = 4;   -- Julio
--   update usuarios set im_usuario = 'brian'     where cod_vendedor = 12;  -- Brian
--
-- (los nombres de arriba son EJEMPLOS: poner los logins reales de IM)
--
-- Para ver qué usuarios/campos devuelve IM sin adivinar, hay un endpoint de sólo lectura:
--   GET /api/debug/im-vendedores   (requiere rol admin o gerente)

alter table usuarios add column if not exists im_usuario text;

comment on column usuarios.im_usuario is
  'Login del usuario en InfoManager con el que se crean los presupuestos de este vendedor. NULL = se usa IM_USUARIO_PEDIDOS (el usuario unico de la app). Tiene que existir en IM y tener punto de venta vinculado.';
