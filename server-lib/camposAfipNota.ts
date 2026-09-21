/**
 * 🔴 LOS CAMPOS AFIP DE LA NOTA. Sin ellos IM la manda al CONTROLADOR FISCAL.
 *
 * Mati (10/09/2026): *"la NC se está generando en controlador fiscal, debería seguir la misma
 * suerte de todo el otro circuito, que no involucre a AFIP, es interno"*.
 *
 * Es el mismo problema que tuvieron las facturas el 09/09 y la misma solución: `emitirNota` no
 * mandaba ninguno de estos campos y quedaban en `null`. Leídas 45 notas de la oficina del 15/08
 * al 10/09/2026 —las que salen internas— el patrón es éste, y la única diferencia con las
 * nuestras eran justamente estos cinco campos.
 *
 * `conceptos_fe` es lo único que cambia entre las dos: 1 en las 35 NC leídas, 0 en las 4 ND.
 *
 * ⚠️ `talonario_manual` y `mueve_stock` NO son los que deciden: la factura A 1630 del panel los
 * tiene en `null` —IM los descarta al crear por API— y aun así sale interna.
 */
export function camposAfipNota(tipo: 'NC' | 'ND') {
  return {
    afip_comprobantes_fe: '',
    afip_conceptos_fe: tipo === 'NC' ? 1 : 0,
    afip_tipdoc_fe: 0,
    afip_cond_vta: 0,
    afip_cod_barra: '',
  };
}
