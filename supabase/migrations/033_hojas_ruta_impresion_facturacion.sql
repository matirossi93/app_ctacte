-- Migration 033 — Lo que falta para imprimir, y el lugar para la facturación (07/09/2026).
-- Idempotente.
--
-- 1) IMPRESIÓN. La hoja de ruta impresa lleva el importe de cada comprobante y el total por
--    cliente (ver la hoja real nº 3394). Va al snapshot junto con el saldo, los bultos y los
--    kilos, por el mismo motivo: el papel que se llevó el repartidor tiene que poder
--    explicarse después, y el importe cambia si alguien edita el pedido.
--
-- 2) FACTURACIÓN. Todavía NO está hecha, pero el modelo la contempla desde ahora (Mati,
--    07/09/2026: *"tené en cuenta que todo el sistema y el front van a tener que contemplar
--    esa parte"*).
--    🔑 El circuito real es **presupuesto → facturar → remito → hoja de ruta**: la hoja 3394
--    agrupa comprobantes tipo RE, no PR. Hoy el panel arma las hojas con los PRESUPUESTOS,
--    que es lo que existe antes de facturar. Cuando se facture desde el panel, el comprobante
--    que viaja en el camión pasa a ser otro, con su propio id y número — y el presupuesto de
--    origen tiene que quedar registrado, o se pierde la trazabilidad de qué se facturó desde
--    dónde. Por eso los ids nuevos van AL LADO de `im_comprobante_id`, no lo reemplazan.

alter table hojas_ruta_pedidos
  add column if not exists total numeric(14,2);

comment on column hojas_ruta_pedidos.total is
  'Importe del comprobante al armar la hoja. Snapshot: es lo que sale impreso.';

-- ── Facturación (pendiente de implementar) ───────────────────────────────────
alter table hojas_ruta_pedidos
  add column if not exists im_remito_id text,
  add column if not exists im_remito_numero int,
  add column if not exists im_factura_id text,
  add column if not exists im_factura_numero int,
  add column if not exists facturado_at timestamptz;

comment on column hojas_ruta_pedidos.im_remito_id is
  'Remito emitido al facturar este pedido desde el panel. NULL = todavia no se facturo.';
comment on column hojas_ruta_pedidos.im_factura_id is
  'Factura emitida al facturar este pedido desde el panel. NULL = todavia no se facturo.';

-- Para encontrar rápido lo que falta facturar de una hoja.
create index if not exists hojas_ruta_pedidos_sin_facturar_idx
  on hojas_ruta_pedidos (hoja_id)
  where facturado_at is null;

-- La hoja sabe si ya se facturó entera. Se guarda en vez de recalcularlo cada vez porque es
-- lo que decide si todavía se le pueden agregar o sacar pedidos.
alter table hojas_ruta
  add column if not exists facturada_at timestamptz;

comment on column hojas_ruta.facturada_at is
  'Cuando se facturaron TODOS los pedidos de la hoja desde el panel. NULL = falta alguno.';
