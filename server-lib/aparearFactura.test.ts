import { describe, it, expect } from 'vitest';
import { aparearFacturas } from './aparearFactura.js';

/**
 * El número de factura que se muestra al lado de cada entrega. Si aparea mal, la hoja dice que
 * el repartidor lleva una factura que en realidad es de otro pedido del mismo cliente.
 *
 * Los casos salen de lo medido contra IM (168 remitos de Casa Central, 2-4/09/2026).
 */

const RE = { id: 'r1', numero: 76818, cod_cliente: 1011, total: 324155.07, usuario_fecha: '2026-09-02T10:00:00' };

describe('aparear factura con remito', () => {
  it('🔑 el vínculo GUARDADO gana siempre: es el único que no se dedujo', async () => {
    // Aunque haya una factura que aparee por importe, lo que emitimos nosotros manda.
    const r = aparearFacturas(
      [RE],
      [{ id: 'f9', numero: 999, cod_cliente: 1011, total: 324155.07 }],
      new Map([['r1', { im_factura_id: 'f1', im_factura_numero: 50358, im_factura_tipo: 'FA B' }]]),
    );
    expect(r.get('r1')).toMatchObject({ im_factura_numero: 50358, origen: 'vinculo' });
  });

  it('🔑 una sola factura del mismo cliente por el mismo importe: no hay nada que decidir', async () => {
    const r = aparearFacturas(
      [RE],
      [{ id: 'f1', numero: 50358, cod_cliente: 1011, total: 324155.07, tipo_factura: 'B' },
       { id: 'f2', numero: 50359, cod_cliente: 500, total: 324155.07, tipo_factura: 'A' }],
      new Map(),
    );
    expect(r.get('r1')).toMatchObject({ im_factura_numero: 50358, im_factura_tipo: 'FA B', origen: 'unica' });
  });

  it('🪤 dos facturas iguales del mismo cliente: gana la grabada más cerca en el tiempo', async () => {
    // Pasa de verdad: entre 4% y 18% de los remitos, según el día. Son dos pedidos iguales.
    const r = aparearFacturas(
      [RE],
      [{ id: 'f1', numero: 50358, cod_cliente: 1011, total: 324155.07, tipo_factura: 'B', usuario_fecha: '2026-09-02T16:30:00' },
       { id: 'f2', numero: 50359, cod_cliente: 1011, total: 324155.07, tipo_factura: 'B', usuario_fecha: '2026-09-02T10:02:00' }],
      new Map(),
    );
    expect(r.get('r1')).toMatchObject({ im_factura_numero: 50359, origen: 'elegida' });
  });

  it('🪤 sin hora usable, el desempate es determinista (número más bajo), no el orden de llegada', async () => {
    const facturas = [
      { id: 'f2', numero: 50359, cod_cliente: 1011, total: 324155.07, tipo_factura: 'B' },
      { id: 'f1', numero: 50358, cod_cliente: 1011, total: 324155.07, tipo_factura: 'B' },
    ];
    const a = aparearFacturas([RE], facturas, new Map());
    const b = aparearFacturas([RE], [...facturas].reverse(), new Map());
    expect(a.get('r1')!.im_factura_numero).toBe(50358);
    expect(b.get('r1')!.im_factura_numero).toBe(50358);
  });

  it('🔴 sin factura que aparee NO se inventa una: queda en "ninguna"', async () => {
    const r = aparearFacturas(
      [RE],
      [{ id: 'f1', numero: 50358, cod_cliente: 999, total: 100 }],
      new Map(),
    );
    expect(r.get('r1')).toMatchObject({ im_factura_numero: null, origen: 'ninguna' });
  });

  it('🔴 no aparea por importe parecido: el mismo cliente con otro total no es la misma entrega', async () => {
    const r = aparearFacturas(
      [RE],
      [{ id: 'f1', numero: 50358, cod_cliente: 1011, total: 324155.08 }],   // un centavo de diferencia
      new Map(),
    );
    expect(r.get('r1')!.origen).toBe('ninguna');
  });

  it('los importes se comparan en centavos enteros, no como decimales', async () => {
    // 0.1 + 0.2 !== 0.3 en punto flotante: comparar totales con === es pedir un bug.
    const r = aparearFacturas(
      [{ id: 'r1', numero: 1, cod_cliente: 1, total: 0.1 + 0.2 }],
      [{ id: 'f1', numero: 2, cod_cliente: 1, total: 0.3, tipo_factura: 'B' }],
      new Map(),
    );
    expect(r.get('r1')!.origen).toBe('unica');
  });

  it('un vínculo guardado vacío no bloquea la deducción', async () => {
    const r = aparearFacturas(
      [RE],
      [{ id: 'f1', numero: 50358, cod_cliente: 1011, total: 324155.07, tipo_factura: 'B' }],
      new Map([['r1', { im_factura_id: null, im_factura_numero: null, im_factura_tipo: null }]]),
    );
    expect(r.get('r1')).toMatchObject({ im_factura_numero: 50358, origen: 'unica' });
  });

  it('sin remitos no rompe', async () => {
    expect(aparearFacturas([], [], new Map()).size).toBe(0);
  });
});
