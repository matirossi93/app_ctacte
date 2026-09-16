import { describe, it, expect, vi } from 'vitest';

// infomanager.ts corta el proceso al importarse si falta INFOMANAGER_CLIENT_SECRET.
vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });
const { parseArticuloCatalogo } = await import('./infomanager.js');

/**
 * 🔴 DE ACÁ SALE LA ALÍCUOTA DE IVA DE CUALQUIER ARTÍCULO QUE SE AGREGUE A UN COMPROBANTE.
 *
 * 16/09/2026: la app buscaba el campo `iva_por` y `/articulos` lo manda como `iva`. Resultado
 * medido en producción: **0 de 1874 artículos** traían alícuota. No se notaba porque el que no la
 * tiene cae al fallback por lista de precios — salvo COSTO DE DISTRIBUCION (13819), que no está
 * en ninguna lista y por eso no se podía agregar a ningún presupuesto.
 *
 * Fila real de `/articulos` (16/09/2026). Los campos son los que devolvió IM:
 * id, cod_articulo, descripcion, descripcion_corta, cod_afip_concepto, cod_cuenta,
 * cod_cuenta_venta, habilitado, iva, moneda, precio_compra, ..., cod_rubro, rubro, cod_subrubro,
 * subrubro, cod_barra, unidad_de_medida, equivalencia_um, ...
 */
const FILA = {
  id: 1, cod_articulo: 13819, descripcion: 'COSTO DE DISTRIBUCION', habilitado: 1,
  iva: 0, precio_venta: 0, cod_rubro: 11, subrubro: '', unidad_de_medida: 'unidades', equivalencia_um: 1,
};

describe('parseArticuloCatalogo — la alícuota viene en `iva`', () => {
  it('🔑 COSTO DE DISTRIBUCION: IVA 0 cargado en la ficha se lee como 0, no como "no sé"', () => {
    expect(parseArticuloCatalogo(FILA)?.iva_por).toBe(0);
  });

  it('🔑 una alícuota normal también', () => {
    expect(parseArticuloCatalogo({ ...FILA, iva: 21 })?.iva_por).toBe(21);
    expect(parseArticuloCatalogo({ ...FILA, iva: '10.5' })?.iva_por).toBe(10.5);
  });

  it('🔴 sin alícuota legible no se inventa un cero: es "no sé"', () => {
    for (const iva of [undefined, null, '', '   ', 'x', -1, 101, {}]) {
      expect(parseArticuloCatalogo({ ...FILA, iva }), JSON.stringify(iva)).toMatchObject({ iva_por: null });
    }
  });

  it('🔴 un artículo dado de baja no se vende: queda fuera del catálogo', () => {
    expect(parseArticuloCatalogo({ ...FILA, habilitado: 0 })).toBeNull();
    expect(parseArticuloCatalogo({ ...FILA, habilitado: 1 })).not.toBeNull();
    // Sin el campo no se descarta: IM no siempre lo manda.
    expect(parseArticuloCatalogo({ ...FILA, habilitado: undefined })).not.toBeNull();
  });

  it('🔴 y una fila sin código no entra: no hay a quién atribuirle nada', () => {
    expect(parseArticuloCatalogo({ ...FILA, cod_articulo: undefined })).toBeNull();
    expect(parseArticuloCatalogo({ ...FILA, cod_articulo: 'x' })).toBeNull();
  });

  it('conserva el resto de lo que usa el control de listas', () => {
    expect(parseArticuloCatalogo({ ...FILA, precio_venta: '1234.5', subrubro: ' Mezclas ' }))
      .toMatchObject({ cod_rubro: 11, descripcion: 'COSTO DE DISTRIBUCION', precio_venta: 1234.5, subrubro: 'Mezclas', equivalencia_um: 1 });
  });
});
