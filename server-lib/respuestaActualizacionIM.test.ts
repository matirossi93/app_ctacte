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

/**
 * 🔴 UN FRAGMENTO NO ES UNA CONFIRMACIÓN.
 *
 * Astra (11/09/2026), revisando el fix del texto plano: la regex buscaba el fragmento
 * *"se actualizó correctamente"* en cualquier parte del cuerpo, sin anclar. Eso acepta como
 * éxito la frase que dice exactamente lo contrario —"NO se actualizó correctamente"— y
 * cualquier página HTML o respuesta que cite la confirmación antes de explicar un error.
 *
 * Leer un rechazo como éxito es peor que el bug original: el original avisaba de más y alguien
 * iba a mirar; éste da por guardado lo que no se guardó y nadie mira nunca.
 *
 * Sólo se aceptan las confirmaciones COMPLETAS que IM devuelve de verdad.
 */
describe('sólo la confirmación completa cuenta como éxito', () => {
  it('🔑 las dos que manda IM, con acento y sin acento', () => {
    for (const t of [
      'El registro se actualizó correctamente.',
      'El registro se actualizo correctamente.',
      'Los registros se actualizaron correctamente.',
      '  El registro se actualizó correctamente.  ',
      'El  registro   se actualizó\n correctamente.',
      'El registro se actualizó correctamente',
    ]) {
      expect(interpretarActualizacionIM(t).ok, t).toBe(true);
    }
  });

  it('🔴 la NEGACIÓN no es un éxito', () => {
    for (const t of [
      'No se actualizó correctamente.',
      'El registro no se actualizó correctamente.',
      'El registro NO se actualizó correctamente, verifique los datos.',
    ]) {
      const r = interpretarActualizacionIM(t);
      expect(r.ok, t).toBe(false);
      if (!r.ok) expect(r.sinRespuesta).toBe(true);
    }
  });

  it('🔴 la confirmación citada y después un error, tampoco', () => {
    for (const t of [
      'El registro se actualizó correctamente. Pero el comprobante quedó con errores.',
      'Se esperaba "El registro se actualizó correctamente." y hubo un fallo.',
      'Error: el registro se actualizó correctamente sólo parcialmente.',
    ]) {
      const r = interpretarActualizacionIM(t);
      expect(r.ok, t).toBe(false);
      if (!r.ok) expect(r.sinRespuesta).toBe(true);
    }
  });

  it('🔴 una página HTML que contenga la frase, tampoco', () => {
    const r = interpretarActualizacionIM('<html><body><p>El registro se actualizó correctamente.</p></body></html>');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.sinRespuesta).toBe(true);
  });

  it('🔴 un string cualquiera sigue siendo incertidumbre', () => {
    for (const t of ['', 'ok', 'Se superó el límite de solicitudes por hora para este cliente']) {
      const r = interpretarActualizacionIM(t);
      expect(r.ok, t).toBe(false);
      if (!r.ok) expect(r.sinRespuesta).toBe(true);
    }
  });
});
