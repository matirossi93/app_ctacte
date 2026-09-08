-- Migration 037 — La fecha del comprobante que va en cada hoja (08/09/2026). Idempotente.
--
-- 🪤 POR QUÉ: el listado de FRACCIONADO que se imprime con la hoja pide a InfoManager los
-- renglones de "el día de la hoja", pero una hoja puede llevar comprobantes de días anteriores
-- (el arrastre: mercadería facturada que no salió). Los renglones de esos comprobantes no se
-- pedían nunca y **el galpón preparaba menos paquetes de los que salen en el camión**.
--
-- El dato ya se conoce al armar la hoja: `asignarPedidos` lo usa para pedir los pesos. Sólo
-- faltaba guardarlo.
--
-- 📌 El código funciona con y sin esta columna: si no está, el fraccionado se comporta como
-- antes (mira sólo la fecha de la hoja). Correrla lo mejora, no lo desbloquea.

alter table hojas_ruta_pedidos
  add column if not exists fecha date;

-- El fraccionado agrupa por día para pedirle a IM los renglones de cada fecha.
create index if not exists hojas_ruta_pedidos_fecha_idx on hojas_ruta_pedidos (fecha) where fecha is not null;
