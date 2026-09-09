import { describe, it, expect, vi } from 'vitest';

/**
 * El cálculo de la corrección de una factura.
 *
 * 🔴 Acá se decide cuánta plata se le devuelve o se le cobra de más a un cliente. Lo único que no
 * puede pasar es que la NC y la ND no expliquen EXACTAMENTE la diferencia: un peso que no cierra
 * es un peso que alguien va a tener que buscar a mano en la cuenta corriente.
 */
vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });
vi.mock('./supabase.js', () => ({ sb: vi.fn(), TENANT_ID: 't', hasSupabase: () => true }));
vi.mock('./pedidos.js', () => ({ usuarioIM: vi.fn(async () => 'jorgelina') }));
vi.mock('./vistaPresupuestos.js', () => ({ invalidarVista: vi.fn(), vistaDeRango: vi.fn() }));
vi.mock('./vistaRemitos.js', () => ({ invalidarRemitos: vi.fn(), vistaRemitos: vi.fn() }));

const { calcularCorreccion } = await import('./correccionFactura.js');

/** Lo que sale de la factura y lo que tiene que quedar, con el importe de cada lado. */
const importe = (rs: Array<{ cantidad: number; precio: number }>) =>
  Math.round(rs.reduce((s, r) => s + r.cantidad * r.precio, 0) * 100) / 100;

describe('calcularCorreccion', () => {
  it('🔴 sacar un producto entero va a la NOTA DE CRÉDITO, al precio al que se facturó', () => {
    const c = calcularCorreccion(
      [{ cod_articulo: 10, cantidad: 5, precio: 1000 }, { cod_articulo: 20, cantidad: 2, precio: 500 }],
      [{ cod_articulo: 10, cantidad: 5, precio: 1000 }],
    );
    expect(c.nd).toEqual([]);
    expect(c.nc).toHaveLength(1);
    expect(c.nc[0]).toMatchObject({ cod_articulo: 20, cantidad: 2, precio: 500 });
    expect(c.total_nc).toBe(1000);
    expect(c.diferencia).toBe(-1000);
  });

  it('🔴 agregar un producto va a la NOTA DE DÉBITO', () => {
    const c = calcularCorreccion(
      [{ cod_articulo: 10, cantidad: 5, precio: 1000 }],
      [{ cod_articulo: 10, cantidad: 5, precio: 1000 }, { cod_articulo: 30, cantidad: 3, precio: 250 }],
    );
    expect(c.nc).toEqual([]);
    expect(c.nd[0]).toMatchObject({ cod_articulo: 30, cantidad: 3, precio: 250 });
    expect(c.diferencia).toBe(750);
  });

  it('llevarse menos cantidad: NC por la diferencia, no por el renglón entero', () => {
    const c = calcularCorreccion(
      [{ cod_articulo: 10, cantidad: 5, precio: 1000 }],
      [{ cod_articulo: 10, cantidad: 3, precio: 1000 }],
    );
    expect(c.nc[0]).toMatchObject({ cod_articulo: 10, cantidad: 2, precio: 1000 });
    expect(c.total_nc).toBe(2000);
  });

  /**
   * 🔑 El caso que más pasa, según Mati: *"se puso mal una lista"*. La mercadería es la misma, el
   * precio no. La NC va por la diferencia de precio sobre la cantidad que queda.
   */
  it('🔴 lista mal cargada: NC por la diferencia de precio, con la misma cantidad', () => {
    const c = calcularCorreccion(
      [{ cod_articulo: 10, cantidad: 4, precio: 1200 }],
      [{ cod_articulo: 10, cantidad: 4, precio: 1000 }],
    );
    expect(c.nd).toEqual([]);
    expect(c.nc[0]).toMatchObject({ cod_articulo: 10, cantidad: 4, precio: 200 });
    expect(c.total_nc).toBe(800);
    // 4×1200 = 4800 facturado, tiene que quedar en 4×1000 = 4000.
    expect(importe([{ cantidad: 4, precio: 1200 }]) - c.total_nc).toBe(4000);
  });

  it('precio de menos: ND por la diferencia', () => {
    const c = calcularCorreccion(
      [{ cod_articulo: 10, cantidad: 4, precio: 1000 }],
      [{ cod_articulo: 10, cantidad: 4, precio: 1200 }],
    );
    expect(c.nc).toEqual([]);
    expect(c.nd[0]).toMatchObject({ cod_articulo: 10, cantidad: 4, precio: 200 });
    expect(c.total_nd).toBe(800);
  });

  /**
   * 🔴 EL CASO QUE PUEDE DUPLICAR LA DIFERENCIA. Si cambian la cantidad Y el precio del mismo
   * artículo, el pedazo de cantidad se cuenta al precio VIEJO y el de precio sobre la cantidad
   * NUEVA. Contar los dos sobre la cantidad vieja cobraría dos veces el mismo ajuste.
   */
  it('🔴 cantidad y precio a la vez: la suma da exactamente la diferencia', () => {
    const viejo = [{ cod_articulo: 10, cantidad: 5, precio: 1200 }];
    const nuevo = [{ cod_articulo: 10, cantidad: 3, precio: 1000 }];
    const c = calcularCorreccion(viejo, nuevo);
    // 5×1200 = 6000 → 3×1000 = 3000. Se le devuelven 3000.
    expect(c.diferencia).toBe(-3000);
    expect(importe(viejo) + c.diferencia).toBe(importe(nuevo));
  });

  it('🔴 la NC y la ND juntas explican la diferencia al centavo, caso mezclado', () => {
    const viejo = [
      { cod_articulo: 10, cantidad: 5, precio: 1200 },      // baja de cantidad
      { cod_articulo: 20, cantidad: 2, precio: 500 },        // se saca
      { cod_articulo: 30, cantidad: 10, precio: 80 },        // sube de precio
      { cod_articulo: 40, cantidad: 1, precio: 999.99 },     // no se toca
    ];
    const nuevo = [
      { cod_articulo: 10, cantidad: 2, precio: 1200 },
      { cod_articulo: 30, cantidad: 10, precio: 95 },
      { cod_articulo: 40, cantidad: 1, precio: 999.99 },
      { cod_articulo: 50, cantidad: 4, precio: 333.33 },     // se agrega
    ];
    const c = calcularCorreccion(viejo, nuevo);
    expect(importe(viejo) + c.diferencia).toBeCloseTo(importe(nuevo), 2);
    // El artículo que no se tocó no aparece en ningún comprobante.
    expect([...c.nc, ...c.nd].some(r => r.cod_articulo === 40)).toBe(false);
  });

  it('sin cambios no sale ningún comprobante', () => {
    const rs = [{ cod_articulo: 10, cantidad: 5, precio: 1200.5 }];
    const c = calcularCorreccion(rs, [...rs]);
    expect(c.nc).toEqual([]);
    expect(c.nd).toEqual([]);
    expect(c.diferencia).toBe(0);
  });

  it('🔴 nunca manda cantidades ni precios negativos: IM no los acepta', () => {
    const c = calcularCorreccion(
      [{ cod_articulo: 10, cantidad: 5, precio: 1200 }, { cod_articulo: 20, cantidad: 1, precio: 90 }],
      [{ cod_articulo: 10, cantidad: 9, precio: 800 }],
    );
    for (const r of [...c.nc, ...c.nd]) {
      expect(r.cantidad).toBeGreaterThan(0);
      expect(r.precio).toBeGreaterThan(0);
    }
  });

  it('una diferencia de redondeo de IM no genera un comprobante por $0', () => {
    // IM guarda 4 decimales: menos que eso es ruido, no una corrección.
    const c = calcularCorreccion(
      [{ cod_articulo: 10, cantidad: 3, precio: 1000.00001 }],
      [{ cod_articulo: 10, cantidad: 3, precio: 1000 }],
    );
    expect(c.nc).toEqual([]);
    expect(c.nd).toEqual([]);
  });

  it('los renglones salen ordenados por artículo: el mismo pedido da el mismo comprobante', () => {
    const c = calcularCorreccion(
      [],
      [{ cod_articulo: 30, cantidad: 1, precio: 10 }, { cod_articulo: 10, cantidad: 1, precio: 10 },
       { cod_articulo: 20, cantidad: 1, precio: 10 }],
    );
    expect(c.nd.map(r => r.cod_articulo)).toEqual([10, 20, 30]);
  });

  /** El caso real de BIANCONI del 09/09/2026: la factura salió $73.064,38 por debajo. */
  it('reconstruye una diferencia real: la factura de BIANCONI, $73.064,38 de menos', () => {
    // Los 5 renglones salieron con el neto en vez del bruto (35% de descuento aplicado dos veces).
    const viejo = [{ cod_articulo: 320, cantidad: 4, precio: 14607.8855 }];
    const nuevo = [{ cod_articulo: 320, cantidad: 4, precio: 22473.67 }];
    const c = calcularCorreccion(viejo, nuevo);
    expect(c.nc).toEqual([]);
    expect(c.total_nd).toBeCloseTo(4 * (22473.67 - 14607.8855), 2);
    expect(importe(viejo) + c.diferencia).toBeCloseTo(importe(nuevo), 2);
  });
});
