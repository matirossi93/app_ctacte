-- Migration 007 — Índices de performance para queries por (year, month).
-- Idempotente.
--
-- Razón: vendor_sales_monthly y client_sales_monthly tienen PK
-- (tenant_id, cod_*, year, month). Las queries del Panel Vendedor son del
-- tipo `WHERE tenant_id=X AND year=Y AND month=M`, sin filtrar por cod_*.
-- Postgres NO usa el PK eficientemente porque cod_* está en el medio del
-- índice compuesto. Un índice dedicado por (tenant_id, year, month) hace
-- index-only scans para esas queries.

create index if not exists vendor_sales_monthly_year_month_idx
  on vendor_sales_monthly (tenant_id, year, month);

create index if not exists client_sales_monthly_year_month_idx
  on client_sales_monthly (tenant_id, year, month);
