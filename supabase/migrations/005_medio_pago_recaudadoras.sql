-- Drop el CHECK viejo (legacy values: transferencia, otro) y agrega recaudadora_1/2.
-- El frontend (mediosPago.ts) ya usa los valores nuevos como fuente de verdad;
-- 'transferencia' y 'otro' se mantienen aceptados solo para historial preexistente.

alter table comprobantes_pago drop constraint if exists comprobantes_pago_medio_pago_check;

alter table comprobantes_pago add constraint comprobantes_pago_medio_pago_check
  check (medio_pago in (
    'mercadopago',
    'recaudadora_1',
    'recaudadora_2',
    'efectivo',
    'cheque',
    'transferencia',  -- legacy: registros previos al rebrand de cuentas
    'otro'            -- legacy
  ));
