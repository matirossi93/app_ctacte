-- ══════════════════════════════════════════════════════════════════════════════
-- 004_mp_verification.sql — Auto-verificación de comprobantes contra MercadoPago API
-- ══════════════════════════════════════════════════════════════════════════════
-- Agrega columnas para verificar que un comprobante MP subido por el vendedor
-- corresponda a un pago realmente acreditado en alguna de las 3 cuentas
-- (Principal, Recaudadora 1, Recaudadora 2). Resto de medios_pago queda `skipped`.
--
-- mp_status flow:
--   pending   → inicial, aún no se intentó buscar
--   verified  → 1 match exacto en API MP, se guardó payment_id + cuenta
--   not_found → lookup OK pero sin matches; cron reintenta hasta 24h
--   ambiguous → 2+ matches por mismo monto en ventana; admin debe elegir
--   skipped   → medio_pago != 'mercadopago', no aplica
--   error     → falla API (red/timeout/401); cron reintenta
-- ══════════════════════════════════════════════════════════════════════════════

alter table comprobantes_pago
  add column if not exists mp_payment_id text,
  add column if not exists mp_cuenta text
    check (mp_cuenta is null or mp_cuenta in ('principal','recaudadora_1','recaudadora_2')),
  add column if not exists mp_verified_at timestamptz,
  add column if not exists mp_lookup_attempts int not null default 0,
  add column if not exists mp_last_lookup_at timestamptz,
  add column if not exists mp_status text not null default 'pending'
    check (mp_status in ('pending','verified','not_found','ambiguous','skipped','error')),
  add column if not exists mp_candidates jsonb not null default '[]'::jsonb;

-- Para comprobantes previos que no son MP: marcarlos como 'skipped' para que el cron los ignore
update comprobantes_pago
set mp_status = 'skipped'
where medio_pago is distinct from 'mercadopago'
  and mp_status = 'pending';

-- Index parcial: cron levanta solo lo que necesita reintentar, sin scanear toda la tabla
create index if not exists comp_pago_mp_pending_idx
  on comprobantes_pago (created_at)
  where medio_pago = 'mercadopago'
    and mp_status in ('pending','not_found','ambiguous','error');
