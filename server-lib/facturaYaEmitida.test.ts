import { describe, it, expect } from 'vitest';
import { buscarFacturasYaEmitidas } from './facturaYaEmitida.js';

/**
 * 🔴 Esto existe porque el 09/09/2026 se emitió una factura DUPLICADA de verdad (la 50401, que
 * hubo que borrar a mano). El presupuesto ya estaba facturado en InfoManager, el panel no tenía
 * cómo saberlo y facturó igual.
 */

const PR = { im_comprobante_id: '58727292', cod_cliente: 297, total: 155430.72 };

describe('detectar que un presupuesto ya se facturó', () => {
  it('🔴 el caso real: hay una factura del mismo cliente por el mismo importe', async () => {
    const r = buscarFacturasYaEmitidas(
      [PR],
      [{ id: 'f1', numero: 50370, cod_cliente: 297, total: 155430.72, tipo_factura: 'B', fecha: '2026-09-09' }],
      new Map(),
    );
    expect(r.get('58727292')).toMatchObject({ numero: 50370, tipo: 'FA B', origen: 'deducida' });
  });

  it('🔑 lo que emitimos NOSOTROS se sabe de cierto, no se deduce', async () => {
    const r = buscarFacturasYaEmitidas(
      [PR], [],
      new Map([['58727292', { im_factura_id: 'f9', im_factura_numero: 50358, im_factura_tipo: 'FA B' }]]),
    );
    expect(r.get('58727292')).toMatchObject({ numero: 50358, origen: 'nuestra' });
  });

  it('un presupuesto sin factura que le calce no se marca', async () => {
    const r = buscarFacturasYaEmitidas(
      [PR],
      [{ id: 'f1', numero: 50370, cod_cliente: 999, total: 155430.72, tipo_factura: 'B' }],
      new Map(),
    );
    expect(r.has('58727292')).toBe(false);
  });

  it('🔴 un centavo de diferencia NO es la misma venta', async () => {
    const r = buscarFacturasYaEmitidas(
      [PR],
      [{ id: 'f1', numero: 50370, cod_cliente: 297, total: 155430.73, tipo_factura: 'B' }],
      new Map(),
    );
    expect(r.has('58727292')).toBe(false);
  });

  it('🪤 dos presupuestos iguales y UNA factura: sólo uno queda marcado', async () => {
    // Si no, el cliente que compra lo mismo dos veces no podría facturar nunca el segundo.
    const r = buscarFacturasYaEmitidas(
      [{ im_comprobante_id: 'a', cod_cliente: 1, total: 500 },
       { im_comprobante_id: 'b', cod_cliente: 1, total: 500 }],
      [{ id: 'f1', numero: 901, cod_cliente: 1, total: 500, tipo_factura: 'B' }],
      new Map(),
    );
    expect(r.size).toBe(1);
    expect(r.has('a')).toBe(true);
  });

  it('🪤 una factura ya atada a OTRO presupuesto no marca a éste', async () => {
    // La 901 es del presupuesto 'x', que ni siquiera está en esta tanda.
    const r = buscarFacturasYaEmitidas(
      [{ im_comprobante_id: 'a', cod_cliente: 1, total: 500 }],
      [{ id: 'f1', numero: 901, cod_cliente: 1, total: 500, tipo_factura: 'B' }],
      new Map([['x', { im_factura_id: 'f1', im_factura_numero: 901, im_factura_tipo: 'FA B' }]]),
    );
    expect(r.has('a')).toBe(false);
  });

  it('dos presupuestos iguales y DOS facturas: los dos quedan marcados', async () => {
    const r = buscarFacturasYaEmitidas(
      [{ im_comprobante_id: 'a', cod_cliente: 1, total: 500 },
       { im_comprobante_id: 'b', cod_cliente: 1, total: 500 }],
      [{ id: 'f1', numero: 901, cod_cliente: 1, total: 500, tipo_factura: 'B' },
       { id: 'f2', numero: 902, cod_cliente: 1, total: 500, tipo_factura: 'B' }],
      new Map(),
    );
    expect(r.size).toBe(2);
  });

  it('el resultado no depende del orden en que llegó la lista', async () => {
    const presus = [{ im_comprobante_id: 'b', cod_cliente: 1, total: 500 },
                    { im_comprobante_id: 'a', cod_cliente: 1, total: 500 }];
    const facturas = [{ id: 'f1', numero: 901, cod_cliente: 1, total: 500, tipo_factura: 'B' }];
    const x = buscarFacturasYaEmitidas(presus, facturas, new Map());
    const y = buscarFacturasYaEmitidas([...presus].reverse(), facturas, new Map());
    expect([...x.keys()]).toEqual([...y.keys()]);
  });

  it('sin presupuestos no rompe', async () => {
    expect(buscarFacturasYaEmitidas([], [], new Map()).size).toBe(0);
  });
});
