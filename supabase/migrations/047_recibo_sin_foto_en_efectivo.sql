-- Migration 047 — El recibo en efectivo puede no tener foto (16/09/2026). Idempotente.
--
-- Mati pidió que el recibo en PDF que emite la app reemplace al talonario de papel que hoy
-- escriben los vendedores, fotografían y suben. Pero `foto_url` era NOT NULL: si el vendedor
-- deja de escribir el papel, no tiene qué fotografiar y el circuito se traba justo en el paso
-- que se quería eliminar.
--
-- La regla que eligió Mati (ver server-lib/mediosPago.ts, campo `exige_foto`): la foto sigue
-- siendo obligatoria donde ES la prueba del pago —transferencias, MercadoPago, cheque— y deja
-- de serlo en EFECTIVO, donde el comprobante lo emite la empresa.
--
-- 🔑 La validación queda en la aplicación y no en un CHECK de la tabla: el medio de pago se
-- puede corregir después (la oficina reclasifica un recibo mal cargado), y un CHECK que mire
-- las dos columnas convertiría esa corrección en un error de base.

alter table comprobantes_pago alter column foto_url drop not null;

comment on column comprobantes_pago.foto_url is
  'Path del comprobante en Storage. NULL cuando el recibo se emitió desde la app y el medio de pago no exige foto (efectivo): ahí el comprobante es el PDF que se le entrega al cliente.';
