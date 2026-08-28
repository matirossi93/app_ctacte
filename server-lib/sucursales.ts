/**
 * Las cuatro unidades de Semillero, con los códigos que InfoManager necesita para crear un
 * presupuesto en cada una. Todo verificado el 28/08/2026 contra IM, no copiado de memoria.
 *
 * 🪤 `cod_empresa` y `cod_deposito` NO son el mismo número y no se pueden inferir uno del otro:
 * Jujuy es empresa 4 pero depósito 6. En el código había un `EMPRESAS_VALIDAS = {1,2,3,6}` que
 * era en realidad la lista de DEPÓSITOS: aceptaba una empresa 6 que no existe y rechazaba la 4,
 * que es Jujuy de verdad.
 *
 * El PUNTO DE VENTA se dedujo así: casa central emite sus 772 presupuestos de agosto por el
 * pv 1, y ese pv tiene habilitados los tipos de comprobante {10, 30}. El 10 es el que manda —
 * el pv 7, que hace remitos, tiene el 30 pero no el 10. De los puntos de venta de cada
 * sucursal, sólo estos tienen el 10:
 *   · BRS  → pv 14 {10,30}  y pv 888 {1,2,10,30,41,42,135}     (el 1414 NO puede)
 *   · SJ   → pv 14 {2,10,30,135} y pv 888 {1,2,10,30,41,...}   (el 8 NO puede)
 *   · Jujuy→ pv 888 {3,10,30,43,53,135} — ÚNICO, su pv 14 es {3,43,53}
 * Se eligió el 14 en BRS y SJ porque replica lo que ya hace casa central (presupuestos en un
 * punto de venta propio, separado del de facturación) — el 14 de BRS tiene exactamente la
 * misma firma que el pv 1 de CC. Jujuy va por 888 porque no tiene alternativa.
 *
 * ⚠️ Jujuy es OTRA entidad fiscal: CUIT 20213284372 y categoría RM, contra el 30702378490 / RI
 * de las otras tres. Para presupuestar da igual, pero si algún día se factura desde la app es
 * un circuito aparte.
 */
export interface Sucursal {
  cod_empresa: number;
  nombre: string;
  /** Depósito del que sale el stock. Acota el buscador de productos. */
  cod_deposito: number;
  /** Punto de venta con el que se emiten los PRESUPUESTOS de esta unidad. */
  punto_de_venta: number;
}

export const CASA_CENTRAL = 1;

export const SUCURSALES: Record<number, Sucursal> = {
  1: { cod_empresa: 1, nombre: 'Casa Central', cod_deposito: 1, punto_de_venta: 1 },
  2: { cod_empresa: 2, nombre: 'BRS', cod_deposito: 2, punto_de_venta: 14 },
  3: { cod_empresa: 3, nombre: 'San Juan', cod_deposito: 3, punto_de_venta: 14 },
  4: { cod_empresa: 4, nombre: 'Jujuy', cod_deposito: 6, punto_de_venta: 888 },
};

/**
 * La unidad de un `cod_empresa`. Un valor desconocido, nulo o basura cae en CASA CENTRAL: es
 * el comportamiento que había antes de que existieran las sucursales, así que un usuario sin
 * `cod_empresa` cargado sigue funcionando exactamente igual que hoy.
 */
export function sucursalDe(codEmpresa: unknown): Sucursal {
  const n = Number(codEmpresa);
  return SUCURSALES[n] ?? SUCURSALES[CASA_CENTRAL];
}

/** Si ese `cod_empresa` es una unidad real. Para validar lo que llega de afuera. */
export function esEmpresaValida(codEmpresa: unknown): boolean {
  return Object.prototype.hasOwnProperty.call(SUCURSALES, Number(codEmpresa));
}
