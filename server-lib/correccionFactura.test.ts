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

const { calcularCorreccion, consolidarRenglones, articulosAmbiguos, renglonesSinArticuloConImporte } = await import('./correccionFactura.js');

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

  /**
   * 🔴 EL PEDAZO DE CANTIDAD VA AL PRECIO **VIEJO**, incluso cuando la cantidad SUBE.
   *
   * Si va al precio nuevo, la identidad se rompe: `(q1−q0)·p1 + q1·(p1−p0)` no da `q1·p1 − q0·p0`.
   * Se ve sólo cuando suben la cantidad Y cambian el precio del mismo artículo a la vez — con
   * 5×1200 → 9×800 la diferencia real es **+1200** y por el otro camino salía −400.
   */
  it('🔴 sube la cantidad y cambia el precio: la diferencia es la real, no la de signo contrario', () => {
    const viejo = [{ cod_articulo: 10, cantidad: 5, precio: 1200 }];
    const nuevo = [{ cod_articulo: 10, cantidad: 9, precio: 800 }];
    const c = calcularCorreccion(viejo, nuevo);
    expect(importe(viejo) + c.diferencia).toBe(importe(nuevo));
    expect(c.diferencia).toBe(1200);
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

/**
 * 🔴 EL DESCUENTO DEL RENGLÓN. Mati (10/09/2026): *"al calcular la NC no está tomando el descuento
 * que tiene ese producto, lo hace por el total"*.
 *
 * Los renglones viajan igual que en la facturación: **precio BRUTO + `descuento_porc` aparte**, e
 * InfoManager aplica el descuento. Medido contra IM el 10/09/2026 sobre la FA B 50422 (cliente
 * 233, BIANCONI): `precio_orig` 22.473,6745 con `descuento_porc` 35 y `precio` 14.607,888425, y
 * el total de la cabecera —587.301,91— es la suma de los NETOS, no de los brutos (699.708,64).
 *
 * Si la corrección ignora el descuento, la nota de crédito sale por el bruto: en esa factura,
 * $112.406,73 de más devueltos a un cliente.
 */
describe('el descuento del renglón', () => {
  /** Lo que la factura realmente dice: neto = precio × (1 − desc/100). */
  const netoDe = (rs: Array<{ cantidad: number; precio: number; descuento_porc?: number }>) =>
    Math.round(rs.reduce((s, r) => s + r.cantidad * r.precio * (1 - (r.descuento_porc ?? 0) / 100), 0) * 100) / 100;

  it('🔴 sacar cantidad con 35% de descuento: la NC va por el NETO, no por el bruto', () => {
    const c = calcularCorreccion(
      [{ cod_articulo: 320, cantidad: 4, precio: 22473.6745, descuento_porc: 35 }],
      [{ cod_articulo: 320, cantidad: 2, precio: 22473.6745, descuento_porc: 35 }],
    );
    // 2 unidades a 14.607,888425 = 29.215,78. Por el bruto habrían sido 44.947,35.
    expect(c.total_nc).toBeCloseTo(2 * 14607.888425, 2);
    expect(c.total_nc).not.toBeCloseTo(2 * 22473.6745, 2);
    // El renglón viaja como lo espera IM: bruto + descuento aparte.
    expect(c.nc[0].precio).toBeCloseTo(22473.6745, 4);
    expect(c.nc[0].descuento_porc).toBe(35);
  });

  it('🔴 sacar el renglón entero: la NC es exactamente lo que ese renglón sumó a la factura', () => {
    const viejo = [
      { cod_articulo: 320, cantidad: 4, precio: 22473.6745, descuento_porc: 35 },
      { cod_articulo: 165, cantidad: 15, precio: 10924.1457, descuento_porc: 0 },
    ];
    const c = calcularCorreccion(viejo, [viejo[1]]);
    expect(c.total_nc).toBeCloseTo(4 * 14607.888425, 2);
    expect(netoDe(viejo) - c.total_nc).toBeCloseTo(netoDe([viejo[1]]), 2);
  });

  it('🔴 cambiar el precio con descuento: la diferencia también va neta', () => {
    const c = calcularCorreccion(
      [{ cod_articulo: 351, cantidad: 7, precio: 12023.45907, descuento_porc: 35 }],
      [{ cod_articulo: 351, cantidad: 7, precio: 13000, descuento_porc: 35 }],
    );
    expect(c.total_nd).toBeCloseTo(7 * (13000 - 12023.45907) * 0.65, 2);
    expect(c.nd[0].descuento_porc).toBe(35);
  });

  it('🔴 cantidad Y precio con descuento: la suma sigue explicando la diferencia al centavo', () => {
    const viejo = [{ cod_articulo: 330, cantidad: 8, precio: 18387.89527, descuento_porc: 35 }];
    const nuevo = [{ cod_articulo: 330, cantidad: 5, precio: 19000, descuento_porc: 35 }];
    const c = calcularCorreccion(viejo, nuevo);
    expect(netoDe(viejo) + c.diferencia).toBeCloseTo(netoDe(nuevo), 2);
  });

  /**
   * 🪤 Si además cambia el DESCUENTO no hay un bruto+porcentaje que dé la diferencia justa, así
   * que ese pedazo va como importe neto con el descuento en cero.
   *
   * ⚠️ Es el único caso que puede quedar a un centavo: el precio unitario se redondea a los 4
   * decimales que guarda IM, y ese resto se multiplica por la cantidad. Con el descuento sin
   * cambiar —que es lo que pasa siempre— la corrección cierra exacta.
   */
  it('🪤 cambia el descuento: la corrección cierra, con el centavo del redondeo de IM', () => {
    const viejo = [{ cod_articulo: 320, cantidad: 4, precio: 22473.6745, descuento_porc: 35 }];
    const nuevo = [{ cod_articulo: 320, cantidad: 4, precio: 22473.6745, descuento_porc: 20 }];
    const c = calcularCorreccion(viejo, nuevo);
    expect(netoDe(viejo) + c.diferencia).toBeCloseTo(netoDe(nuevo), 1);
    // Sube el neto porque bajó el descuento: es una nota de DÉBITO.
    expect(c.total_nd).toBeGreaterThan(0);
    expect(c.nc).toEqual([]);
  });

  it('🔴 la factura entera de BIANCONI: corregirla a cero devuelve 587.301,91 y no 699.708,64', () => {
    // Los 5 renglones tal como los devolvió /ventas/items el 10/09/2026.
    const viejo = [
      { cod_articulo: 320, cantidad: 4, precio: 22473.6745, descuento_porc: 35 },
      { cod_articulo: 351, cantidad: 7, precio: 12023.45907, descuento_porc: 35 },
      { cod_articulo: 330, cantidad: 8, precio: 18387.89527, descuento_porc: 35 },
      { cod_articulo: 165, cantidad: 15, precio: 10924.1457, descuento_porc: 0 },
      { cod_articulo: 166, cantidad: 15, precio: 14312.292, descuento_porc: 0 },
    ];
    const c = calcularCorreccion(viejo, []);
    expect(c.total_nc).toBeCloseTo(587301.91, 1);
    expect(c.nd).toEqual([]);
  });

  it('un renglón sin descuento sigue viajando sin el campo puesto en cualquier cosa', () => {
    const c = calcularCorreccion(
      [{ cod_articulo: 165, cantidad: 15, precio: 10924.1457 }],
      [{ cod_articulo: 165, cantidad: 10, precio: 10924.1457 }],
    );
    expect(c.total_nc).toBeCloseTo(5 * 10924.1457, 2);
    expect(c.nc[0].descuento_porc ?? 0).toBe(0);
  });
});

/**
 * 🔴 EL MISMO ARTÍCULO EN DOS RENGLONES DE LA MISMA FACTURA.
 *
 * Medido contra IM el 10/09/2026 sobre 349 facturas de Casa Central del 01 al 10/09: **17 lo
 * tienen** (15 con el mismo precio en los dos renglones, 2 con precios distintos). Como los
 * renglones se indexaban por `cod_articulo`, el segundo pisaba al primero y la mitad de la
 * mercadería desaparecía del cálculo: en la FA B 50432 el artículo 468 va en dos renglones
 * (150 + 30) y anular la factura entera devolvía **$92.280,10 en vez de $183.754,97**.
 */
describe('el mismo artículo en dos renglones', () => {
  it('🔴 sacarlo entero devuelve los DOS renglones, no el último', () => {
    // La FA B 50432 real: art 468 en 150 y en 30 unidades, las dos a 717,45 con 15%.
    const viejo = [
      { cod_articulo: 468, cantidad: 150, precio: 717.45, descuento_porc: 15 },
      { cod_articulo: 468, cantidad: 30, precio: 717.45, descuento_porc: 15 },
    ];
    const c = calcularCorreccion(viejo, []);
    expect(c.total_nc).toBeCloseTo(180 * 717.45 * 0.85, 2);
    expect(c.nc).toHaveLength(1);
    expect(c.nc[0].cantidad).toBe(180);
  });

  it('🔴 a precios distintos, el importe consolidado sigue siendo el de la factura', () => {
    const viejo = [
      { cod_articulo: 716, cantidad: 10, precio: 1000 },
      { cod_articulo: 716, cantidad: 5, precio: 600 },
    ];
    const c = calcularCorreccion(viejo, []);
    expect(c.total_nc).toBeCloseTo(10 * 1000 + 5 * 600, 2);
  });

  it('consolidarRenglones suma las cantidades y deja el precio de lista intacto', () => {
    const r = consolidarRenglones([
      { cod_articulo: 468, cantidad: 150, precio: 717.45, descuento_porc: 15 },
      { cod_articulo: 468, cantidad: 30, precio: 717.45, descuento_porc: 15 },
      { cod_articulo: 10, cantidad: 1, precio: 57068.96, descuento_porc: 15 },
    ]);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ cod_articulo: 468, cantidad: 180, descuento_porc: 15 });
    expect(r[0].precio).toBeCloseTo(717.45, 4);
  });

  /**
   * 🪤 A precios distintos no hay un precio de lista que represente al renglón consolidado, así
   * que la pantalla no lo puede mostrar sin mentir. Se avisa y esa corrección va por IM.
   */
  it('articulosAmbiguos marca el repetido a distinto precio y no el repetido al mismo', () => {
    expect(articulosAmbiguos([
      { cod_articulo: 468, cantidad: 150, precio: 717.45, descuento_porc: 15 },
      { cod_articulo: 468, cantidad: 30, precio: 717.45, descuento_porc: 15 },
    ])).toEqual([]);
    expect(articulosAmbiguos([
      { cod_articulo: 716, cantidad: 10, precio: 1000 },
      { cod_articulo: 716, cantidad: 5, precio: 600 },
      { cod_articulo: 351, cantidad: 1, precio: 100, descuento_porc: 0 },
      { cod_articulo: 351, cantidad: 1, precio: 100, descuento_porc: 20 },
    ])).toEqual([351, 716]);
  });
});

/**
 * 🔴 LAS CANTIDADES FRACCIONARIAS. IM guarda hasta 4 decimales y los usa: 1.094 renglones del
 * 01 al 10/09/2026 llevan más de 2 (granel, que se vende por kilo). Redondearlas a centavos
 * cambia la plata: 0,045 × 19.008 = 855,36 y con 0,05 salían 950,40.
 */
describe('cantidades fraccionarias', () => {
  it('🔴 una cantidad de 3 decimales no se redondea a centavos', () => {
    const c = calcularCorreccion([{ cod_articulo: 528, cantidad: 0.045, precio: 19008 }], []);
    expect(c.nc[0].cantidad).toBe(0.045);
    expect(c.total_nc).toBeCloseTo(855.36, 2);
  });

  it('media docena de renglones de granel cierran al centavo', () => {
    const viejo = [
      { cod_articulo: 525, cantidad: 0.1, precio: 7000 },
      { cod_articulo: 528, cantidad: 0.045, precio: 19008 },
    ];
    const c = calcularCorreccion(viejo, [{ cod_articulo: 525, cantidad: 0.1, precio: 7000 }]);
    expect(c.total_nc).toBeCloseTo(855.36, 2);
  });
});

/**
 * 🔴 LOS RENGLONES DE TEXTO LIBRE CON PLATA ADENTRO.
 *
 * IM exige `cod_articulo` para crear una nota, así que un renglón escrito a mano no puede entrar
 * en la corrección: se filtra. Casi siempre da igual —9 de los 11 renglones sin artículo que
 * emitió Casa Central del 01 al 10/09/2026 son notas "PENDIENTE" a precio 0— pero los otros dos
 * llevaban $351.932,25 y $194.189,50 de mercadería en la misma factura.
 *
 * Si eso no se avisa, "sacar todo" emite una nota de crédito por el resto y la oficina cree que
 * anuló la factura entera. Se muestra en la pantalla y lo decide una persona.
 */
describe('renglones sin código de artículo', () => {
  it('🔴 avisa de los que tienen importe: no van a entrar en la nota', () => {
    const avisos = renglonesSinArticuloConImporte([
      { cod_articulo: 320, cantidad: 4, precio: 22473.67 },
      { cod_articulo: 0, cantidad: 15, precio: 23462.15, descripcion: 'FORTALEZA  HARAS' },
      { cod_articulo: 0, cantidad: 10, precio: 19418.95, descripcion: 'FORTALEZA BASIC' },
    ]);
    expect(avisos).toHaveLength(2);
    expect(avisos[0]).toMatchObject({ descripcion: 'FORTALEZA  HARAS' });
    expect(avisos[0].importe).toBeCloseTo(351932.25, 2);
  });

  it('las notas "PENDIENTE" a precio cero no molestan a nadie', () => {
    expect(renglonesSinArticuloConImporte([
      { cod_articulo: 320, cantidad: 4, precio: 22473.67 },
      { cod_articulo: 0, cantidad: 6, precio: 0, descripcion: 'ANILLO FRUTA PENDIENTE' },
    ])).toEqual([]);
  });
});
