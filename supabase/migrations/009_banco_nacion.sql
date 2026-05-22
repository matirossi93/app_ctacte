-- Suma 'banco_nacion' como medio de pago válido.
-- Banco Nación es una cuenta bancaria propia que ahora se puede elegir al
-- cargar/aprobar un recibo (transferencias recibidas en esa cuenta).
-- El frontend (mediosPago.ts) y el resolver de cuentas ya lo contemplan.

alter table comprobantes_pago drop constraint if exists comprobantes_pago_medio_pago_check;

alter table comprobantes_pago add constraint comprobantes_pago_medio_pago_check
  check (medio_pago in (
    'mercadopago',
    'recaudadora_1',
    'recaudadora_2',
    'banco_nacion',
    'efectivo',
    'cheque',
    'transferencia',  -- legacy: registros previos al rebrand de cuentas
    'otro'            -- legacy
  ));
