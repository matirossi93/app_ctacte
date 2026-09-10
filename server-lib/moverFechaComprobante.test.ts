import { describe, it, expect } from 'vitest';
import { cuerpoParaMoverFecha } from './moverFechaComprobante.js';

/**
 * MOVER LA FECHA DE UNA FACTURA YA EMITIDA.
 *
 * Mati (10/09/2026): *"necesito que podamos editar la fecha de la factura dentro de la app"*.
 * Pasa seguido porque la oficina factura hoy el reparto de mañana: si se equivocan de día, la
 * factura queda con la fecha corrida y el pedido no aparece donde lo buscan.
 *
 * 🔴 `PUT /ventas/{id}` ES UN REEMPLAZO, NO UN PARCHE. El schema `VentasActualizar` exige nueve
 * campos y acepta otros ocho; lo que no se manda se pierde. O sea que mover la fecha con un
 * cuerpo mínimo **borra los campos AFIP** y la factura vuelve a salir por el controlador fiscal,
 * que es justo lo que se arregló esta mañana.
 *
 * Por eso el cuerpo se arma leyendo la cabecera que ya tiene y cambiando SÓLO la fecha.
 */

/** Una factura B del panel, como la devuelve `GET /ventas/{id}`. */
const FACTURA = {
  tipo_comprobante: 'FA', tipo_factura: 'B', numero: 50451, punto_de_venta: 777,
  tag: 'S', condicion_venta_tipo: 2, observaciones: 'Pedido 58362 - entregar el jueves',
  fac_electronica: 0, anulada: 'N',
  afip_comprobantes_fe: '6', afip_conceptos_fe: 1, afip_tipdoc_fe: 96, afip_cond_vta: 4,
  afip_cod_barra: '', cae: null, fecha_cae: null,
  fecha: '2026-09-11',
};

describe('cuerpoParaMoverFecha', () => {
  it('🔴 cambia la fecha y NADA más', () => {
    const b = cuerpoParaMoverFecha(FACTURA, '2026-09-12');
    expect(b.fecha).toBe('2026-09-12');
    expect(b.numero).toBe(50451);
    expect(b.punto_de_venta).toBe(777);
    expect(b.tipo_comprobante).toBe('FA');
    expect(b.tipo_factura).toBe('B');
    expect(b.observaciones).toBe('Pedido 58362 - entregar el jueves');
    expect(b.condicion_venta_tipo).toBe(2);
    expect(b.tag).toBe('S');
  });

  /**
   * 🔴 EL QUE NO PUEDE FALLAR. Sin estos cuatro campos IM imprime la factura como comprobante
   * fiscal (medido el 09/09/2026 comparando 75 facturas de IM contra 23 del panel).
   */
  it('🔴 preserva los campos AFIP: sin ellos la factura vuelve a salir fiscal', () => {
    const b = cuerpoParaMoverFecha(FACTURA, '2026-09-12');
    expect(b.afip_comprobantes_fe).toBe('6');
    expect(b.afip_conceptos_fe).toBe(1);
    expect(b.afip_tipdoc_fe).toBe(96);
    expect(b.afip_cond_vta).toBe(4);
    expect(b.afip_cod_barra).toBe('');
  });

  it('🔴 una factura A conserva su letra y su código, no se normalizan', () => {
    const b = cuerpoParaMoverFecha({ ...FACTURA, tipo_factura: 'A', afip_comprobantes_fe: '1', afip_tipdoc_fe: 80 }, '2026-09-12');
    expect(b.tipo_factura).toBe('A');
    expect(b.afip_comprobantes_fe).toBe('1');
    expect(b.afip_tipdoc_fe).toBe(80);
  });

  /** 🪤 `anulada` es requerido: si no se manda, IM la toma como 'N' y REVIVE un comprobante anulado. */
  it('🪤 un comprobante anulado sigue anulado después de mover la fecha', () => {
    expect(cuerpoParaMoverFecha({ ...FACTURA, anulada: 'S' }, '2026-09-12').anulada).toBe('S');
  });

  it('🪤 sin observaciones manda cadena vacía, no undefined: el campo es obligatorio', () => {
    const b = cuerpoParaMoverFecha({ ...FACTURA, observaciones: null }, '2026-09-12');
    expect(b.observaciones).toBe('');
  });

  it('recorta las observaciones a los 500 que guarda IM', () => {
    const b = cuerpoParaMoverFecha({ ...FACTURA, observaciones: 'x'.repeat(900) }, '2026-09-12');
    expect(b.observaciones.length).toBe(500);
  });

  /** 🪤 El CAE viaja de vuelta tal cual: en estas facturas es null, pero si algún día hay una con
   *  CAE, mandarla sin él le borraría el número de autorización de AFIP. */
  it('🪤 el CAE se devuelve como vino', () => {
    const b = cuerpoParaMoverFecha({ ...FACTURA, cae: '75123456789012', fecha_cae: '2026-09-11' }, '2026-09-12');
    expect(b.cae).toBe('75123456789012');
    expect(b.fecha_cae).toBe('2026-09-11');
  });

  it('🔴 rechaza una fecha que no es una fecha', () => {
    for (const mala of ['', '11/09/2026', '2026-13-01', 'mañana', null as any]) {
      expect(() => cuerpoParaMoverFecha(FACTURA, mala)).toThrow();
    }
  });

  it('acepta una fecha con hora y se queda con el día', () => {
    expect(cuerpoParaMoverFecha(FACTURA, '2026-09-12T00:00:00').fecha).toBe('2026-09-12');
  });
});
