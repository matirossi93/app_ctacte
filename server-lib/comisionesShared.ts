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
