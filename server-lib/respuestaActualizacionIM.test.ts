import { describe, expect, it } from 'vitest';
import { interpretarActualizacionIM } from './respuestaActualizacionIM.js';
describe('confirmación explícita de PUT', () => {
  it.each([{}, '', '<html>Gateway timeout</html>', { mensaje: 'Servicio sin respuesta' }, { error: 1 }])('respuesta ambigua %j conserva incertidumbre', raw => {
    expect(interpretarActualizacionIM(raw)).toMatchObject({ ok: false, sinRespuesta: true });
  });
  it.each([{ isUpdated: true }, { error: 0 }, { venta: { id: 123 } }])('reconoce contrato de éxito %j', raw => {
    expect(interpretarActualizacionIM(raw).ok).toBe(true);
  });
  it('rechazo explícito es definitivo sólo sin ID contradictorio', () => {
    expect(interpretarActualizacionIM({ isUpdated: false })).toMatchObject({ ok: false, sinRespuesta: false });
    expect(interpretarActualizacionIM({ isUpdated: false, id: 123 })).toMatchObject({ ok: false, sinRespuesta: true });
  });
});
