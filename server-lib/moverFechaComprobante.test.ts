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

/**
 * 🔴 UN DEFAULT EN UN PUT QUE REEMPLAZA TODO ES CORRUPCIÓN SILENCIOSA.
 *
 * Astra (11/09/2026), después de mandar un PUT con un body inválido a un comprobante real para
 * ver qué contestaba IM: *"IM contestó 'actualizado correctamente' y me pisó todos los campos —
 * el comprobante quedó con número −1, tipo ZZ, fecha 0000-00-00 y punto de venta 999.
 * `PUT /ventas/{id}` no valida nada y sobrescribe número, tipo, fecha y punto de venta"*.
 *
 * Acá los valores salían todos de la cabecera de IM, que es lo correcto, PERO con `??` y un
 * `Number()` que cae en 0: si la cabecera llegaba incompleta, el PUT escribía `numero: 0`,
 * `punto_de_venta: 0` o convertía un remito en factura B — y IM lo aceptaba sin chistar.
 *
 * Ahora falta un identificador, no hay PUT.
 */
describe('cabecera incompleta: no se inventa nada', () => {
  const completa = {
    tipo_comprobante: 'RE', tipo_factura: 'X', numero: 77442, punto_de_venta: 3,
    tag: 'S', condicion_venta_tipo: 1, observaciones: 'algo', fac_electronica: 0,
    anulada: 'N', fecha: '2026-09-10',
  };

  it('🔑 sin tipo_comprobante NO se arma el cuerpo (convertiría un remito en factura)', () => {
    expect(() => cuerpoParaMoverFecha({ ...completa, tipo_comprobante: null }, '2026-09-12')).toThrow(/tipo/i);
    expect(() => cuerpoParaMoverFecha({ ...completa, tipo_comprobante: '' }, '2026-09-12')).toThrow(/tipo/i);
  });

  it('🔑 sin número NO se arma el cuerpo (lo dejaría en 0)', () => {
    expect(() => cuerpoParaMoverFecha({ ...completa, numero: null }, '2026-09-12')).toThrow(/número/i);
    expect(() => cuerpoParaMoverFecha({ ...completa, numero: '' }, '2026-09-12')).toThrow(/número/i);
    expect(() => cuerpoParaMoverFecha({ ...completa, numero: 0 }, '2026-09-12')).toThrow(/número/i);
  });

  it('🔑 sin punto de venta NO se arma el cuerpo (lo movería al pv 0)', () => {
    expect(() => cuerpoParaMoverFecha({ ...completa, punto_de_venta: null }, '2026-09-12')).toThrow(/punto de venta/i);
    expect(() => cuerpoParaMoverFecha({ ...completa, punto_de_venta: '' }, '2026-09-12')).toThrow(/punto de venta/i);
  });

  it('🪤 la letra no se inventa: si vino vacía va vacía, NO "B"', () => {
    const c = cuerpoParaMoverFecha({ ...completa, tipo_factura: null }, '2026-09-12');
    expect(c.tipo_factura).toBe('');
    expect(c.tipo_comprobante).toBe('RE');
  });

  it('una cabecera completa sigue saliendo igual que siempre', () => {
    const c = cuerpoParaMoverFecha(completa, '2026-09-12');
    expect(c).toMatchObject({
      fecha: '2026-09-12', tipo_comprobante: 'RE', tipo_factura: 'X',
      numero: 77442, punto_de_venta: 3, anulada: 'N',
    });
  });
});
