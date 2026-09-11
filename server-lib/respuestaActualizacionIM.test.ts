import { describe, expect, it } from 'vitest';
import { interpretarActualizacionIM } from './respuestaActualizacionIM.js';
describe('confirmación explícita de PUT', () => {
  it.each([{}, '', '<html>Gateway timeout</html>', { mensaje: 'Servicio sin respuesta' }, { error: 1 }])('respuesta ambigua %j conserva incertidumbre', raw => {
    expect(interpretarActualizacionIM(raw)).toMatchObject({ ok: false, sinRespuesta: true });
  });
  it.each([{ isUpdated: true }, { error: 0 }, { venta: { id: 123 } }])('reconoce contrato de éxito %j', raw => {
    expect(interpretarActualizacionIM(raw).ok).toBe(true);
  });
  /**
   * 🪤 11/09/2026 — el PUT que SALE BIEN no contesta JSON: IM devuelve HTTP 200 con
   * `content-type: text/plain` y el texto "El registro se actualizó correctamente.".
   * Sin esto, toda anulación exitosa se leía como fallo. Al vendedor Julio le salió que
   * habían quedado los dos presupuestos vivos (58462 y 58463) cuando el viejo ya estaba
   * anulado, y lo mandó a avisarle a la oficina por nada.
   */
  it.each([
    'El registro se actualizó correctamente.',
    'El registro se actualizo correctamente',
    'Los registros se actualizaron correctamente.',
  ])('🔴 reconoce el texto plano con el que IM confirma de verdad: %s', raw => {
    expect(interpretarActualizacionIM(raw).ok).toBe(true);
  });

  it('un texto plano que NO confirma sigue siendo incertidumbre', () => {
    // El error sí viene en JSON y por 404/500, pero si algún día cambia, el silencio no se
    // interpreta como éxito.
    expect(interpretarActualizacionIM('No se pudo actualizar el registro')).toMatchObject({ ok: false, sinRespuesta: true });
  });

  it('rechazo explícito es definitivo sólo sin ID contradictorio', () => {
    expect(interpretarActualizacionIM({ isUpdated: false })).toMatchObject({ ok: false, sinRespuesta: false });
    expect(interpretarActualizacionIM({ isUpdated: false, id: 123 })).toMatchObject({ ok: false, sinRespuesta: true });
  });
});
