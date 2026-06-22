/**
 * Constantes compartidas por los tres lugares donde se computa el avance /
 * facturado neto de los vendedores Casa Central:
 *
 *   - `comisiones.ts`     → endpoint /api/comisiones (cálculo en tiempo real)
 *   - `syncVentas.ts`     → cron + backfill que persiste a vendor_sales_monthly
 *   - `goals.ts`          → endpoint /api/goals/snapshot (corte intra-mes)
 *
 * Si los tres lugares no usan los mismos sets, los paneles de Objetivos y
 * Comisiones divergen — perdimos varios commits del 07/05/2026 chocando con
 * exactamente eso. Centralizar acá evita que pase de nuevo.
 */

/** Casa Central. Las sucursales tienen su propia estructura de comisión. */
export const COD_EMPRESA_CASA_CENTRAL = 1;

/**
 * Clientes internos = sucursales propias. Las "ventas" a estos clientes son
 * transferencias entre depósitos, NO ventas comerciales. No suman al avance
 * ni pagan comisión.
 *
 *   1   = Casa Central
 *   652 = San Martín (sucursal)
 *   666 = Santo Cristo (sucursal)
 *   861 = sucursal adicional
 *
 * Lista alineada con `semillero-existencias/src/lib/infomanager.ts`.
 */
export const COD_CLIENTES_INTERNOS = new Set<number>([1, 652, 666, 861]);

/**
 * Vendedores comerciales visibles en los paneles. Mati confirmó 06/05/2026:
 *   2  = Sebastián
 *   3  = Marcelo
 *   4  = Julio
 *   12 = Brian
 *
 * Andrea (cod=6, backoffice) NO entra aunque tenga ventas asignadas. Si en
 * algún momento se incorpora un vendedor nuevo, agregar acá.
 */
export const COD_VENDEDORES_VISIBLES = new Set<number>([2, 3, 4, 12]);

/**
 * Sucursales con vista de comisión SEPARADA (solo-admin). El cálculo de Casa
 * Central paga al vendedor por sus clientes que retiran en la sucursal: las
 * facturas de la sucursal traen el cod_vendedor del cliente (InfoManager lo
 * hereda), así que se reusa exactamente la misma matemática que Casa Central.
 */
export const COD_EMPRESA_SAN_MARTIN = 2;
export const NOMBRE_EMPRESA: Record<number, string> = {
  1: 'Casa Central',
  2: 'San Martín (BRS)',
  3: 'San Juan',
  4: 'Av. Jujuy',
};

/**
 * Clientes EXCLUIDOS del cálculo de comisión de sucursal, por periodo 'YYYY-MM'.
 *
 * Decisión de negocio (Mati, 16/06/2026): el cliente 17 (BRUNO, Mayra —
 * Alderetes) compra de forma directa y recurrente en el mostrador de San Martín
 * (31 retiros en mayo, varios el mismo día) SIN intervención del vendedor → esas
 * ventas NO le corresponden a Julio. Se excluye SOLO en mayo 2026; en abril no
 * tuvo compras en San Martín. Si cambia el criterio, editar acá.
 */
export const EXCLUIR_CLIENTES_COMISION_SUCURSAL: Record<string, number[]> = {
  '2026-05': [17],
};

/** Devuelve el Set de cod_cliente a excluir para un periodo 'YYYY-MM'. */
export function excluirClientesDe(periodo: string): Set<number> {
  return new Set(EXCLUIR_CLIENTES_COMISION_SUCURSAL[periodo] ?? []);
}
