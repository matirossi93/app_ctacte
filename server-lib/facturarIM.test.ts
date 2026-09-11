import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

/**
 * Emitir factura y remito es lo ÚNICO irreversible del circuito: consume numeración fiscal,
 * toca la cuenta corriente y descuenta stock. Lo que se testea acá es que falle del lado
 * seguro.
 *
 * Los campos salen de probarlo contra IM el 07/09/2026 (remito de prueba 77290, anulado).
 */

vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });
vi.mock('axios', () => ({ default: { post: vi.fn(), create: vi.fn() } }));

const { emitirFactura, emitirRemito, emitirRemitoMasivo, letraDeFactura } = await import('./facturarIM.js');
// La numeración cachea el rango 20 s para no pedirle a IM la misma lista una vez por letra y
// otra por cada remito forzado. Entre tests hay que tirarlo o uno le contesta al siguiente.
const { invalidarCacheNumeracion } = await import('./infomanager.js');

function mockIM(respuesta: any, fallar?: any) {
    const post = vi.fn(async () => { if (fallar) throw fallar; return { data: respuesta }; });
    vi.mocked(axios.create).mockReturnValue({
        post, get: vi.fn(), put: vi.fn(), interceptors: { request: { use: vi.fn() } },
    } as any);
    vi.mocked(axios.post).mockResolvedValue({ data: { token: 'tok' } } as any);
    return post;
}

const DATOS = {
    cod_empresa: 1, cod_cliente: 1093, cod_vendedor: 2, categoria_iva: 'CF',
    cod_lista_precios: 12, usuario: 'susana', total: 29771.58, origen_id: '58757247',
    // Con el número ya calculado, que es como lo llama el panel: al facturar una hoja se
    // consulta UNA vez y se va incrementando. Sin él, `emitirFactura` sale a preguntarle a IM.
    numero: 50360,
    items: [{ cod_articulo: 661, cantidad: 1, precio: 29771.58, cod_lista_precios: 13 }],
};

beforeEach(() => { vi.clearAllMocks(); invalidarCacheNumeracion(); });

describe('letraDeFactura — es una regla FISCAL', () => {
    it('🔴 CF lleva B; RI y RM llevan A', () => {
        // Medido sobre 3.887 facturas reales de la semana del 01/09/2026, punto de venta 777.
        expect(letraDeFactura('CF')).toBe('B');
        expect(letraDeFactura('RI')).toBe('A');
        expect(letraDeFactura('RM')).toBe('A');
    });

    it('🔴 una categoría desconocida NO cae en una letra por defecto', () => {
        // Emitir la letra equivocada es un problema impositivo. Sin dato, no se emite.
        for (const c of ['', null, undefined, 'EX', 'otra']) {
            expect(letraDeFactura(c as any)).toBeNull();
        }
    });

    it('no se cuelga por mayúsculas ni espacios', () => {
        expect(letraDeFactura(' ri ')).toBe('A');
        expect(letraDeFactura('cf')).toBe('B');
    });
});

describe('emitirFactura', () => {
    it('🔴 sin condición de IVA NO EMITE NADA', async () => {
        const post = mockIM({ isCreated: true, venta: { id: 1, numero: 2 } });
        const r = await emitirFactura({ ...DATOS, categoria_iva: null } as any);
        expect(r.ok).toBe(false);
        expect(post).not.toHaveBeenCalled();                 // ni siquiera se llamó a IM
        if (!r.ok) expect(r.error).toMatch(/letra de factura/i);
    });

    it('🔴 la letra y el punto de venta salen del cliente', async () => {
        const post = mockIM({ isCreated: true, venta: { id: 58757300, numero: 50120 } });
        const r = await emitirFactura({ ...DATOS, categoria_iva: 'RI' } as any);
        expect(r.ok).toBe(true);
        const [url, body] = post.mock.calls[0] as any[];
        expect(url).toBe('/ventas');
        expect(body.tipo_comprobante).toBe('FA');
        expect(body.tipo_factura).toBe('A');                 // RI → A
        expect(body.punto_de_venta).toBe(777);               // el de Casa Central
        expect(body.anulada).toBe('N');                      // o no pasa los filtros de IM
    });

    it('🔴 200 con el error adentro NO es un éxito', async () => {
        // La regla de oro de IM: contesta 200 con el error en el body.
        mockIM({ mensaje: 'Ocurrió un error al grabar información.', detalles: 'Validaciones: ...' });
        const r = await emitirFactura(DATOS as any);
        expect(r.ok).toBe(false);
    });

    it('🔴 si IM no contesta, se marca sinRespuesta: NO se sabe si se emitió', async () => {
        // Es el caso más peligroso: reintentar a ciegas factura dos veces al mismo cliente.
        mockIM(null, { message: 'timeout' });
        const r = await emitirFactura(DATOS as any);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.sinRespuesta).toBe(true);
    });

    it('🔴 IM NO asigna el número de factura: se manda calculado', async () => {
        // Probado el 07/09/2026: con `numero: 0` —que es lo que funciona en presupuestos y
        // remitos— IM contesta "Ya existe una factura ... numero: [0]".
        const post = mockIM({ isCreated: true, venta: { id: 1, numero: 50360 } });
        await emitirFactura({ ...DATOS, numero: 50360 } as any);
        expect((post.mock.calls[0] as any[])[1].numero).toBe(50360);
    });

    it('🔴 si el número ya estaba usado, reintenta con el siguiente', async () => {
        // La oficina puede estar facturando desde IM al mismo tiempo y quedarse con el
        // correlativo. IM valida la unicidad, así que un choque se resuelve subiendo el
        // número — nunca duplicando.
        let n = 0;
        const post = vi.fn(async (_url: string, body: any) => {
            n++;
            if (body.numero < 50362) return { data: { mensaje: 'Ya existe una factura con los siguientes datos: numero: [' + body.numero + ']' } };
            return { data: { isCreated: true, venta: { id: 9, numero: body.numero } } };
        });
        vi.mocked(axios.create).mockReturnValue({ post, get: vi.fn(), put: vi.fn(), interceptors: { request: { use: vi.fn() } } } as any);
        vi.mocked(axios.post).mockResolvedValue({ data: { token: 'tok' } } as any);

        const r = await emitirFactura({ ...DATOS, numero: 50360 } as any);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.numero).toBe(50362);
        expect(n).toBe(3);
    });

    // Eran 3 intentos y no alcanzaban: el 09/09/2026 había 4 facturas seguidas fechadas para
    // el día siguiente y PASTERIS se quedó sin facturar. Ahora son 10, pero sigue habiendo tope:
    // cada intento es una request y probar sin fin colgaría la pantalla.
    it('🔴 después de 10 choques se rinde en vez de seguir probando para siempre', async () => {
        const post = vi.fn(async () => ({ data: { mensaje: 'Ya existe una factura con los siguientes datos' } }));
        vi.mocked(axios.create).mockReturnValue({ post, get: vi.fn(), put: vi.fn(), interceptors: { request: { use: vi.fn() } } } as any);
        vi.mocked(axios.post).mockResolvedValue({ data: { token: 'tok' } } as any);
        const r = await emitirFactura({ ...DATOS, numero: 50360 } as any);
        expect(r.ok).toBe(false);
        expect(post).toHaveBeenCalledTimes(10);
    });

    it('lleva el presupuesto de origen en cod_compatibilidad', async () => {
        // Es lo único que IM guarda del vínculo: facturar por API no lo crea solo.
        const post = mockIM({ isCreated: true, venta: { id: 1, numero: 2 } });
        await emitirFactura(DATOS as any);
        expect((post.mock.calls[0] as any[])[1].cod_compatibilidad).toBe('58757247');
    });
});

describe('emitirRemito', () => {
    it('🔴 talonario_manual va en "A": con "N" IM lo rechaza', async () => {
        // Probado contra IM: "Talonario manual no válido". Los presupuestos sí usan 'N'.
        const post = mockIM({ isCreated: true, venta: { id: 58757250, numero: 77290 } });
        const r = await emitirRemito(DATOS as any);
        expect(r.ok).toBe(true);
        const [url, body] = post.mock.calls[0] as any[];
        expect(url).toBe('/remitos');
        expect(body.talonario_manual).toBe('A');
        expect(body.tipo_comprobante).toBe('RE');
        expect(body.tipo_factura).toBe('X');
        expect(body.punto_de_venta).toBe(7);       // el de la hoja de ruta real
        expect(body.mueve_stock).toBe('S');        // descuenta stock de verdad
    });

    it('🔴 cada renglón lleva cod_unidad_negocio', async () => {
        // Sin esto: "La cuenta de venta [4100002] del artículo [661] no tiene unidad de negocio".
        const post = mockIM({ isCreated: true, venta: { id: 1, numero: 2 } });
        await emitirRemito(DATOS as any);
        expect((post.mock.calls[0] as any[])[1].items[0].cod_unidad_negocio).toBe(1);
        expect((post.mock.calls[0] as any[])[1].items[0].cod_cuenta).toBe(4100002);
    });

    it('el remito no depende de la condición de IVA', async () => {
        // Es X, no tiene letra: un cliente sin categoría cargada igual puede tener remito.
        const post = mockIM({ isCreated: true, venta: { id: 1, numero: 2 } });
        const r = await emitirRemito({ ...DATOS, categoria_iva: null } as any);
        expect(r.ok).toBe(true);
        expect(post).toHaveBeenCalled();
    });
});

describe('el remito cuando el stock está en negativo (09/09/2026)', () => {
  /**
   * 🔑 Mati: *"necesito por favor que se remita la mercadería aunque esté en negativo"*.
   * `/remitos` valida stock y rechaza; `/remitos/masivo` deja salir el remito Y descuenta igual.
   * Probado contra IM con un artículo en −570, que quedó en −571.
   */
  it('el remito normal siempre mueve stock: es lo que corresponde', async () => {
    const post = mockIM({ isCreated: true, remito: { id: '1', numero: 5 } });
    await emitirRemito(DATOS);
    expect((post.mock.calls[0] as any[])[0]).toBe('/remitos');
    expect((post.mock.calls[0] as any[])[1].mueve_stock).toBe('S');
  });

  /**
   * 🪤 El masivo NO aplica `descuento_porc`: lo guarda escrito y calcula el importe con el precio
   * entero. Un renglón de 4 × 22.473,67 con 35% salía por 89.894,68 en vez de 58.431,54, o sea el
   * remito por MÁS que su factura. Va el precio ya neto y el descuento en cero.
   */
  it('🔴 manda el precio NETO: el masivo no aplica el descuento y el remito saldría por de más', async () => {
    const post = mockIM('');
    vi.mocked(axios.create).mockReturnValue({
      post,
      get: vi.fn(async () => ({ data: { results: [{ id: '999', numero: 77373, tipo_comprobante: 'RE', punto_de_venta: 7, cod_cliente: 1093 }] } })),
      put: vi.fn(), interceptors: { request: { use: vi.fn() } },
    } as any);
    await emitirRemitoMasivo({ ...DATOS, items: [{ cod_articulo: 320, cantidad: 4, precio: 22473.67, descuento_porc: 35 }] });
    const [url, body] = post.mock.calls[0] as any[];
    expect(url).toBe('/remitos/masivo');
    expect(body.items[0].precio).toBeCloseTo(14607.8855, 4);
    expect(body.items[0].descuento_porc).toBe(0);
    // 4 × 14.607,8855 = 58.431,542, que es exactamente lo que factura el renglón.
    expect(body.items[0].precio * body.items[0].cantidad).toBeCloseTo(58431.542, 3);
  });

  /**
   * 🔴 El masivo contesta 200 con el body VACÍO: no devuelve id ni número. Si el remito no
   * aparece después, se dice que no se sabe — inventar un id haría que el panel lo dé por
   * emitido y nadie vuelva a mirarlo.
   */
  it('🔴 si después no encuentra el remito, NO lo da por emitido', async () => {
    const post = mockIM('');
    vi.mocked(axios.create).mockReturnValue({
      post,
      get: vi.fn(async () => ({ data: { results: [{ id: '1', numero: 70000, tipo_comprobante: 'RE', punto_de_venta: 7, cod_cliente: 1093 }] } })),
      put: vi.fn(), interceptors: { request: { use: vi.fn() } },
    } as any);
    const r = await emitirRemitoMasivo(DATOS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no lo encontré|no pude confirmar/i);
  });

  it('sin ningún remito reciente no inventa una numeración', async () => {
    const post = mockIM('');
    vi.mocked(axios.create).mockReturnValue({
      post, get: vi.fn(async () => ({ data: { results: [] } })),
      put: vi.fn(), interceptors: { request: { use: vi.fn() } },
    } as any);
    const r = await emitirRemitoMasivo(DATOS);
    expect(r.ok).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });
});

/**
 * 🔴 EL BUG QUE DEJÓ SIN REMITO A LEAL Y A DIAZ EL 09/09/2026.
 *
 * `/remitos/masivo` es el camino que usa el panel cuando el stock está en negativo, y es el
 * único que necesita que el número se lo demos nosotros. Se calculaba mirando los remitos de
 * los últimos 7 días **hasta hoy**, y la oficina fecha los del reparto de mañana con la fecha
 * de mañana: los 77377 y 77378 estaban fechados el 10/09, la ventana no los veía y el masivo
 * salía con un número ya usado. IM contestaba *"El número de comprobante [77377] ya existe
 * para el punto de venta [7] y empresa [1]"*, el reintento moría ahí, y en pantalla se seguía
 * mostrando el error de stock original — o sea, parecía que el arreglo del stock negativo
 * nunca había funcionado.
 */
describe('proximoNumeroRemito — la numeración no sigue a la fecha', () => {
  it('🔴 la ventana mira ADELANTE: los remitos del reparto de mañana ya tienen número', async () => {
    const get = vi.fn(async () => ({ data: { results: [] } }));
    vi.mocked(axios.create).mockReturnValue({
      post: vi.fn(), get, put: vi.fn(), interceptors: { request: { use: vi.fn() } },
    } as any);
    vi.mocked(axios.post).mockResolvedValue({ data: { token: 'tok' } } as any);
    const { proximoNumeroRemito } = await import('./facturarIM.js');
    await proximoNumeroRemito(7);
    const params = (get.mock.calls[0] as any[])[1].params;
    const hoy = new Date().toISOString().slice(0, 10);
    expect(params.fechaHasta > hoy).toBe(true);
  });
});

describe('emitirRemitoMasivo — choque de numeración', () => {
  it('🔴 si el número ya existe reintenta con el siguiente en vez de rendirse', async () => {
    // El primer POST choca (IM contesta 500 con el error adentro), el segundo entra.
    let intentos = 0;
    const post = vi.fn(async () => {
      intentos += 1;
      if (intentos === 1) {
        throw { response: { status: 500, data: { detalles: 'Validaciones: • El número de comprobante [77377] ya existe para el punto de venta [7] y empresa [1].' } } };
      }
      return { data: '' };
    });
    // 1ª consulta: la numeración (ve hasta el 77377, propone el 77378, que choca).
    // 2ª consulta: la verificación posterior, donde ya está el remito que entró (77379).
    let consultas = 0;
    const get = vi.fn(async () => {
      consultas += 1;
      const rows = consultas === 1
        ? [{ id: '1', numero: 77376, tipo_comprobante: 'RE', punto_de_venta: 7, cod_cliente: 1093 },
           { id: '2', numero: 77377, tipo_comprobante: 'RE', punto_de_venta: 7, cod_cliente: 1093 }]
        : [{ id: '9', numero: 77379, tipo_comprobante: 'RE', punto_de_venta: 7, cod_cliente: 1093 }];
      return { data: { results: rows } };
    });
    vi.mocked(axios.create).mockReturnValue({
      post, get, put: vi.fn(), interceptors: { request: { use: vi.fn() } },
    } as any);
    vi.mocked(axios.post).mockResolvedValue({ data: { token: 'tok' } } as any);
    const r = await emitirRemitoMasivo(DATOS);
    expect(post).toHaveBeenCalledTimes(2);
    // El segundo intento va con el número siguiente, no con el mismo.
    expect((post.mock.calls[1] as any[])[1].cabecera[0].numero)
      .toBe((post.mock.calls[0] as any[])[1].cabecera[0].numero + 1);
    // Y lo da por emitido con el número que entró de verdad, no con el que chocó.
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.numero).toBe(77379);
  });

  it('🔴 el error de un choque de numeración NO se confunde con falta de stock', async () => {
    const post = vi.fn(async () => {
      throw { response: { status: 500, data: { detalles: 'Validaciones: • El número de comprobante [77377] ya existe para el punto de venta [7] y empresa [1].' } } };
    });
    vi.mocked(axios.create).mockReturnValue({
      post,
      get: vi.fn(async () => ({ data: { results: [{ id: '1', numero: 77376, tipo_comprobante: 'RE', punto_de_venta: 7, cod_cliente: 1093 }] } })),
      put: vi.fn(), interceptors: { request: { use: vi.fn() } },
    } as any);
    vi.mocked(axios.post).mockResolvedValue({ data: { token: 'tok' } } as any);
    const r = await emitirRemitoMasivo(DATOS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/n[úu]mero/i);
  });
});

/**
 * 🔴 EL VENDEDOR VA EN LA CABECERA. Y NO, no se puede en los dos lados.
 *
 * Mati (09/09/2026): *"tiene que figurar ítem por ítem el vendedor, es importantísimo porque la
 * aplicación toma quién es el que hizo la venta"* y después *"si puede figurar en los dos lados
 * mejor"*. Se probó contra IM con cinco comprobantes (cliente 1093, todos anulados) y la API no
 * lo permite: si los renglones llevan `cod_vendedor`, **IM deja la cabecera en 0**; el
 * `PUT /ventas/{id}` posterior contesta "se actualizó correctamente" y no la cambia.
 *
 * El desempate lo da nuestro propio código: `comisiones.ts` toma el vendedor de la CABECERA y
 * trata el 0 como mostrador, así que mandarlo en los renglones dejaba la venta **sin comisión
 * para nadie**. Gana la cabecera.
 */
describe('el vendedor de la venta', () => {
  it('🔴 la FACTURA lo lleva en la cabecera y NO en los renglones', async () => {
    const post = mockIM({ isCreated: true, venta: { id: 1, numero: 50360 } });
    await emitirFactura({ ...DATOS, cod_vendedor: 3, items: [
      { cod_articulo: 661, cantidad: 1, precio: 100 },
      { cod_articulo: 662, cantidad: 2, precio: 200 },
    ] });
    const body = (post.mock.calls[0] as any[])[1];
    expect(body.cod_vendedor).toBe(3);
    // 🪤 Con esto adentro, IM pone la cabecera en 0 y el vendedor pierde la comisión.
    for (const it of body.items) expect(it.cod_vendedor).toBeUndefined();
  });

  it('🔴 el REMITO también lo lleva en la cabecera', async () => {
    const post = mockIM({ isCreated: true, remito: { id: 7, numero: 77300 } });
    await emitirRemito({ ...DATOS, cod_vendedor: 12 });
    const body = (post.mock.calls[0] as any[])[1];
    expect(body.cod_vendedor).toBe(12);
    // IM ignora el del renglón en remitos (probado con texto y con número).
    for (const it of body.items) expect(it.cod_vendedor).toBeUndefined();
  });

  it('la NOTA DE CRÉDITO lo lleva igual: también entra en el cálculo de comisiones', async () => {
    const post = mockIM({ isCreated: true, venta: { id: 5, numero: 1700 } });
    const { emitirNotaCredito } = await import('./facturarIM.js');
    await emitirNotaCredito({ ...DATOS, cod_vendedor: 2, numero: 1700 } as any);
    expect((post.mock.calls[0] as any[])[1].cod_vendedor).toBe(2);
  });
});

/**
 * 🔴 EL MISMO BUG QUE EL REMITO, EN LAS FACTURAS. Bloqueó a PASTERIS el 09/09/2026.
 *
 * La oficina factura hoy el reparto de MAÑANA, así que el panel emite facturas fechadas mañana
 * — y después no las ve, porque la ventana terminaba hoy. Verificado contra IM: las facturas B
 * 50403 a 50406 del punto 777 estaban fechadas el 10/09, `proximoNumeroFactura` proponía la
 * 50403 y los tres intentos (50403, 50404, 50405) chocaban todos. El mensaje que veía Jorgelina
 * —"Ya existe una factura ... numero: [50405]"— era el del tercer intento.
 */
/** La serie del circuito: empresa 1, destino Manual, tag 'S'. */
const SERIE = { cod_empresa: 1, id_destino: 1, tag: 'S' };

describe('proximoNumeroFactura — la numeración no sigue a la fecha', () => {
  it('🔴 la ventana mira ADELANTE: la oficina factura hoy el reparto de mañana', async () => {
    const get = vi.fn(async () => ({ data: { results: [] } }));
    vi.mocked(axios.create).mockReturnValue({
      post: vi.fn(), get, put: vi.fn(), interceptors: { request: { use: vi.fn() } },
    } as any);
    vi.mocked(axios.post).mockResolvedValue({ data: { token: 'tok' } } as any);
    const { proximoNumeroFactura } = await import('./facturarIM.js');
    await proximoNumeroFactura('B', 777, 30, 'FA', SERIE);
    const params = (get.mock.calls[0] as any[])[1].params;
    expect(params.fechaHasta > new Date().toISOString().slice(0, 10)).toBe(true);
  });

  it('🔴 no se rinde a los 3 números: la oficina puede tener varios adelantados', async () => {
    // IM contesta 200 con el error adentro, que es como llega este rechazo de verdad.
    const post = vi.fn(async () => ({ data: {
      mensaje: 'Ocurrió un error al grabar información.',
      detalles: 'Ya existe una factura con los siguientes datos: tipo_factura [B], punto_de_venta [777], numero: [50405]',
    } }));
    vi.mocked(axios.create).mockReturnValue({
      post, get: vi.fn(async () => ({ data: { results: [] } })),
      put: vi.fn(), interceptors: { request: { use: vi.fn() } },
    } as any);
    vi.mocked(axios.post).mockResolvedValue({ data: { token: 'tok' } } as any);
    const r = await emitirFactura({ ...DATOS, numero: 50403 });
    expect(post.mock.calls.length).toBeGreaterThanOrEqual(8);
    // Y cada intento va con el número siguiente, no con el mismo.
    const nums = post.mock.calls.map((c: any) => c[1].numero);
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
    expect(new Set(nums).size).toBe(nums.length);
    expect(r.ok).toBe(false);
  });
});

/**
 * ⏱️ EL CLICK DE FACTURAR TARDABA UNA ETERNIDAD Y ERA CASI TODO ESTO.
 *
 * Mati (09/09/2026): *"intentemos mejorar los tiempos de demora cuando se hace click en
 * facturar"*. Medido contra IM ese día: `fetchVentas` de 30 días trae 58.119 filas y tarda
 * **31 s**; el de 7 días trae 14.118 y tarda **5 s**. Y averiguar el próximo número es lo
 * primero que pasa al apretar Facturar, así que esos 31 s los espera la oficina mirando la
 * pantalla — por cada letra de factura que haya en la tanda.
 *
 * La oficina factura todos los días, así que en 7 días SIEMPRE hay comprobantes del talonario.
 * Se busca ahí primero y sólo se abre a 30 días si no aparece ninguno, que es el caso raro
 * (arranque de talonario, feriados largos) y el único que justifica pagar la espera.
 */
describe('la numeración no paga 30 días de ventas cuando alcanza con 7', () => {
  const conVentas = (rows: any[]) => {
    const get = vi.fn(async () => ({ data: { results: rows } }));
    vi.mocked(axios.create).mockReturnValue({
      post: vi.fn(), get, put: vi.fn(), interceptors: { request: { use: vi.fn() } },
    } as any);
    vi.mocked(axios.post).mockResolvedValue({ data: { token: 'tok' } } as any);
    return get;
  };

  it('🔴 con facturas en la última semana consulta UNA sola ventana corta', async () => {
    const get = conVentas([{ numero: 50410, tipo_comprobante: 'FA', tipo_factura: 'B', punto_de_venta: 777, ...SERIE }]);
    const { proximoNumeroFactura } = await import('./facturarIM.js');
    expect(await proximoNumeroFactura('B', 777, 30, 'FA', SERIE)).toBe(50411);
    expect(get).toHaveBeenCalledTimes(1);
    const { fechaDesde, fechaHasta } = (get.mock.calls[0] as any[])[1].params;
    // Una semana atrás, no un mes: es la diferencia entre 5 s y 31 s.
    const dias = (Date.parse(fechaHasta) - Date.parse(fechaDesde)) / 864e5;
    expect(dias).toBeLessThan(40);
  });

  it('sin nada en la semana corta se abre a la ventana larga antes de rendirse', async () => {
    // Ninguna factura del talonario: la ventana corta vuelve vacía y hay que mirar más atrás.
    const get = conVentas([{ numero: 900, tipo_comprobante: 'RE', punto_de_venta: 7 }]);
    const { proximoNumeroFactura } = await import('./facturarIM.js');
    await proximoNumeroFactura('B', 777, 30, 'FA', SERIE);
    expect(get).toHaveBeenCalledTimes(2);
    const corta = (get.mock.calls[0] as any[])[1].params;
    const larga = (get.mock.calls[1] as any[])[1].params;
    expect(larga.fechaDesde < corta.fechaDesde).toBe(true);
  });
});

/**
 * ⏱️ Al facturar una tanda, el mismo rango se pedía una vez por letra de factura y otra por CADA
 * remito que hay que forzar por stock negativo. Son ~5 s cada vez contra IM.
 */
describe('la numeración no le pide a IM la misma lista dos veces seguidas', () => {
  it('dos búsquedas seguidas del mismo rango son UNA sola consulta', async () => {
    const get = vi.fn(async () => ({ data: { results: [
      { numero: 50410, tipo_comprobante: 'FA', tipo_factura: 'B', punto_de_venta: 777, ...SERIE },
      { numero: 1200, tipo_comprobante: 'FA', tipo_factura: 'A', punto_de_venta: 777, ...SERIE },
    ] } }));
    vi.mocked(axios.create).mockReturnValue({
      post: vi.fn(), get, put: vi.fn(), interceptors: { request: { use: vi.fn() } },
    } as any);
    vi.mocked(axios.post).mockResolvedValue({ data: { token: 'tok' } } as any);
    const { proximoNumeroFactura } = await import('./facturarIM.js');
    expect(await proximoNumeroFactura('B', 777, 30, 'FA', SERIE)).toBe(50411);
    expect(await proximoNumeroFactura('A', 777, 30, 'FA', SERIE)).toBe(1201);
    expect(get).toHaveBeenCalledTimes(1);
  });

  /**
   * 🪤 El cache es SÓLO de la numeración. `emitirRemitoMasivo` va a buscar a IM el remito que
   * acaba de emitir —el endpoint contesta con el body vacío— y una lista vieja no lo tendría:
   * diría "lo aceptó pero no lo encontré" sobre un remito que existe.
   */
  it('🔴 la búsqueda del remito recién emitido NO sale del cache', async () => {
    let consultas = 0;
    const get = vi.fn(async () => {
      consultas += 1;
      // La 1ª es la numeración; a partir de la 2ª aparece el remito recién creado.
      const rows: any[] = [{ id: '1', numero: 77400, tipo_comprobante: 'RE', punto_de_venta: 7, cod_cliente: 1093 }];
      if (consultas > 1) rows.push({ id: '2', numero: 77401, tipo_comprobante: 'RE', punto_de_venta: 7, cod_cliente: 1093 });
      return { data: { results: rows } };
    });
    vi.mocked(axios.create).mockReturnValue({
      post: vi.fn(async () => ({ data: '' })), get, put: vi.fn(), interceptors: { request: { use: vi.fn() } },
    } as any);
    vi.mocked(axios.post).mockResolvedValue({ data: { token: 'tok' } } as any);
    const r = await emitirRemitoMasivo(DATOS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.numero).toBe(77401);
  });
});

/**
 * 🔴 EL COSTO DE DISTRIBUCIÓN NO PERTENECE A NINGUNA LISTA DE PRECIOS.
 *
 * NAVARRO (PR 58317) no se pudo facturar el 09/09/2026: *"HTTP 400: El artículo código [13819]
 * no pertenece a la lista de precios [13]"*. El renglón del costo de distribución se guarda con
 * la lista que estaba abierta en el editor, `/presupuestos` lo acepta sin chistar y `/ventas` lo
 * rechaza. Probado contra IM: el mismo renglón SIN `cod_lista_precios` entra (FA 50413).
 *
 * El reintento saca la lista SÓLO del artículo que IM nombra, así que el resto de los renglones
 * conserva la suya. Sirve para cualquier artículo que quede fuera de la lista del pedido, no
 * sólo para el 13819.
 */
describe('un artículo que no está en la lista de precios no frena la factura', () => {
  it('🔴 reintenta sin la lista del artículo que IM rechazó', async () => {
    let n = 0;
    const post = vi.fn(async () => {
      n += 1;
      if (n === 1) throw { response: { status: 400, data: { detalles: 'Validaciones: \n• El artículo código [13819] no pertenece a la lista de precios [13].' } } };
      return { data: { isCreated: true, venta: { id: 9, numero: 50413 } } };
    });
    vi.mocked(axios.create).mockReturnValue({
      post, get: vi.fn(), put: vi.fn(), interceptors: { request: { use: vi.fn() } },
    } as any);
    vi.mocked(axios.post).mockResolvedValue({ data: { token: 'tok' } } as any);
    const r = await emitirFactura({ ...DATOS, numero: 50413, items: [
      { cod_articulo: 1214, cantidad: 10, precio: 877.63, cod_lista_precios: 13 },
      { cod_articulo: 13819, cantidad: 1, precio: 7700, cod_lista_precios: 13 },
    ] });
    expect(r.ok).toBe(true);
    const items = (post.mock.calls[1] as any[])[1].items;
    // El que rechazó IM va sin lista; el otro la conserva.
    expect(items.find((i: any) => i.cod_articulo === 13819).cod_lista_precios).toBeUndefined();
    expect(items.find((i: any) => i.cod_articulo === 1214).cod_lista_precios).toBe(13);
  });

  it('el remito hace lo mismo: si no, la factura sale y el remito queda colgado', async () => {
    let n = 0;
    const post = vi.fn(async () => {
      n += 1;
      if (n === 1) throw { response: { status: 400, data: { detalles: '• El artículo código [13819] no pertenece a la lista de precios [13].' } } };
      return { data: { isCreated: true, remito: { id: 3, numero: 77400 } } };
    });
    vi.mocked(axios.create).mockReturnValue({
      post, get: vi.fn(), put: vi.fn(), interceptors: { request: { use: vi.fn() } },
    } as any);
    vi.mocked(axios.post).mockResolvedValue({ data: { token: 'tok' } } as any);
    const r = await emitirRemito({ ...DATOS, items: [{ cod_articulo: 13819, cantidad: 1, precio: 7700, cod_lista_precios: 13 }] });
    expect(r.ok).toBe(true);
    expect((post.mock.calls[1] as any[])[1].items[0].cod_lista_precios).toBeUndefined();
  });
});

/**
 * 🔗 QUE LOS COMPROBANTES QUEDEN ASOCIADOS EN INFOMANAGER.
 *
 * Mati (09/09/2026): *"no se están asociando los comprobantes entre sí... si queremos hacer una
 * nota de crédito el sistema te pide que esté asociada a la factura porque tiene que ver con el
 * movimiento de mercadería. Tenemos un recuadro que cuando está asociado se hace un tilde, y no
 * se está haciendo"*.
 *
 * Leído de un remito REAL que generó IM (el 77298, de la factura 50362), el vínculo lo escribe en
 * las observaciones con el id interno: `" [Remito Automático -FA:58764473]"`. No hay ningún campo
 * para esto y `genero_re_auto: 'S'` lo descarta la API, así que se replica esa convención.
 */
describe('el remito queda marcado con su factura', () => {
  it('🔴 la marca lleva el id INTERNO de la factura, no el número', async () => {
    const post = mockIM({ isCreated: true, remito: { id: 7, numero: 77300 } });
    await emitirRemito({ ...DATOS, observaciones: 'Pedido 58330', im_factura_id: '58785131' } as any);
    const obs = (post.mock.calls[0] as any[])[1].observaciones;
    expect(obs).toBe('Pedido 58330 [Remito Automático -FA:58785131]');
  });

  it('sin factura no inventa una marca vacía', async () => {
    const post = mockIM({ isCreated: true, remito: { id: 7, numero: 77300 } });
    await emitirRemito({ ...DATOS, observaciones: 'Pedido 58330' } as any);
    expect((post.mock.calls[0] as any[])[1].observaciones).toBe('Pedido 58330');
  });
});

/**
 * 🔴 SIN LOS CAMPOS AFIP, INFOMANAGER IMPRIME LA FACTURA COMO COMPROBANTE FISCAL.
 *
 * Mati (09/09/2026): *"nos lleva directamente a imprimir un comprobante fiscal... nosotros no
 * pasamos por AFIP, lo declaramos por otro lado"*. Comparadas las 75 facturas B del punto 777
 * hechas en IM contra las 23 del panel, la única diferencia eran estos cuatro campos.
 */
describe('los campos AFIP de la factura', () => {
  it('🔴 una factura B lleva el código 6 y una A el 1', async () => {
    let post = mockIM({ isCreated: true, venta: { id: 1, numero: 50360 } });
    await emitirFactura({ ...DATOS, categoria_iva: 'CF' });   // CF → B
    expect((post.mock.calls[0] as any[])[1].afip_comprobantes_fe).toBe('6');

    post = mockIM({ isCreated: true, venta: { id: 1, numero: 1630 } });
    await emitirFactura({ ...DATOS, categoria_iva: 'RI' });   // RI → A
    expect((post.mock.calls[0] as any[])[1].afip_comprobantes_fe).toBe('1');
  });

  it('los otros tres van como los pone la oficina', async () => {
    const post = mockIM({ isCreated: true, venta: { id: 1, numero: 50360 } });
    await emitirFactura(DATOS);
    const b = (post.mock.calls[0] as any[])[1];
    expect(b.afip_conceptos_fe).toBe(1);       // 1 = productos
    expect(b.afip_tipdoc_fe).toBe(96);         // 96 = DNI
    expect(b.afip_cond_vta).toBe(4);           // 4 = cuenta corriente, que es como factura el panel
  });
});

/**
 * 🔴 LA NOTA DE CRÉDITO TAMBIÉN SALE POR CONTROLADOR FISCAL SIN ESTOS CAMPOS.
 *
 * Mati (10/09/2026): *"la NC se está generando en controlador fiscal, debería seguir la misma
 * suerte de todo el otro circuito, que no involucre a AFIP, es interno"*.
 *
 * Es el mismo problema que tuvieron las facturas el 09/09 y se arregla igual: `emitirNota` nunca
 * mandaba los campos AFIP, así que quedaban en `null`. Leídas 45 notas de la oficina del 15/08 al
 * 10/09/2026 —las que SÍ salen internas— el patrón es:
 *
 *   afip_comprobantes_fe ""  (36 NC + 4 ND)      afip_tipdoc_fe  0  (45/45)
 *   afip_conceptos_fe    1 en las NC, 0 en las ND  afip_cond_vta   0  (45/45)
 *   afip_cod_barra       ""                        id_destino      1  (39/45)
 *
 * ⚠️ `talonario_manual` y `mueve_stock` quedan en `null` porque IM los descarta al crear por API,
 * y NO son los que deciden: la factura A 1630 del panel también los tiene en null y sale interna.
 */
describe('los campos AFIP de la nota de crédito', () => {
  it('🔴 la NC va con los mismos campos que las que hace la oficina', async () => {
    const { emitirNotaCredito } = await import('./facturarIM.js');
    const post = mockIM({ isCreated: true, venta: { id: 9, numero: 7 } });
    await emitirNotaCredito({ ...DATOS, numero: 7 } as any);
    const b = (post.mock.calls[0] as any[])[1];
    expect(b.afip_comprobantes_fe).toBe('');
    expect(b.afip_conceptos_fe).toBe(1);
    expect(b.afip_tipdoc_fe).toBe(0);
    expect(b.afip_cond_vta).toBe(0);
    expect(b.afip_cod_barra).toBe('');
  });

  it('🔑 la ND lleva conceptos en 0: es lo que tienen las 4 de la oficina', async () => {
    const { emitirNotaDebito } = await import('./facturarIM.js');
    const post = mockIM({ isCreated: true, venta: { id: 9, numero: 745 } });
    await emitirNotaDebito({ ...DATOS, numero: 745 } as any);
    expect((post.mock.calls[0] as any[])[1].afip_conceptos_fe).toBe(0);
  });

  /**
   * 🪤 El destino NO se elige: sale de `/puntos-de-venta`. Leído el 10/09/2026, la empresa 1
   * tiene el 999 sólo con destino 3 y el 777 sólo con destino 1 — mandar otro da "no está
   * relacionado a un punto de venta existente".
   */
  it('🪤 el destino va atado al punto de venta, no se inventa', async () => {
    const { emitirNotaCredito } = await import('./facturarIM.js');
    const post = mockIM({ isCreated: true, venta: { id: 9, numero: 7 } });
    await emitirNotaCredito({ ...DATOS, numero: 7 } as any);
    const b = (post.mock.calls[0] as any[])[1];
    expect(b.id_destino).toBe(1);
    expect(b.punto_de_venta).toBe(777);
  });
});


describe('respuesta ambigua después de POST: no habilita otra emisión', () => {
  const sinPunto = 'Validaciones: \n• El usuario cargado (anto) no está relacionado a un punto de venta existente para el tipo de comprobante [NC - B].';
  it('reconoce el rechazo de usuario sin punto de venta, sin reintentar la emisión', async () => {
    const { comoError, interpretar, emitirNotaCredito } = await import('./facturarIM.js');
    const error={response:{status:400,data:{detalles:sinPunto}}};
    expect(comoError(error)).toMatchObject({ok:false,sinRespuesta:false});
    expect(interpretar({detalles:sinPunto},'NC B')).toMatchObject({ok:false,sinRespuesta:false});
    const post=mockIM(null,error);
    expect(await emitirNotaCredito({...DATOS,usuario:'anto',numero:30080})).toMatchObject({ok:false,sinRespuesta:false});
    expect(post).toHaveBeenCalledTimes(1);
  });
  it.each([{isCreated:true},{id:123},{venta:{id:123}}])('un dato de emisión contradictorio mantiene la incertidumbre: %j', async extra => {
    const {comoError}=await import('./facturarIM.js');
    expect(comoError({response:{status:400,data:{detalles:sinPunto,...extra}}})).toMatchObject({ok:false,sinRespuesta:true});
  });
  it('no interpreta una validación genérica ni una desconexión como rechazo',async()=>{
    const {comoError}=await import('./facturarIM.js');
    expect(comoError({response:{status:400,data:{detalles:'Validaciones: no se pudo determinar el resultado'}}})).toMatchObject({ok:false,sinRespuesta:true});
    expect(comoError({message:'socket hang up'})).toMatchObject({ok:false,sinRespuesta:true});
  });
  it.each([{}, '', '<html>Bad gateway</html>', {isCreated:true},
    {mensaje:'El comprobante se procesó, pero no existe conexión al servicio de respuesta'}])('no confunde respuesta desconocida con rechazo: %j', async data => {
    const { interpretar } = await import('./facturarIM.js');
    expect(interpretar(data, 'NC B')).toMatchObject({ok:false,sinRespuesta:true});
  });
  it.each([500,502,504])('HTTP %s de infraestructura es incierto', async status => {
    const { comoError } = await import('./facturarIM.js');
    expect(comoError({response:{status,data:{mensaje:'Internal server error'}}})).toMatchObject({ok:false,sinRespuesta:true});
  });
  it('acepta rechazo estructurado sin ID y mantiene la validación exacta HTTP500 de IM', async () => {
    const { interpretar, comoError } = await import('./facturarIM.js');
    expect(interpretar({isCreated:false,detalles:'El CUIT del cliente es inválido'},'NC')).toMatchObject({ok:false,sinRespuesta:false});
    expect(interpretar({isCreated:false,id:123,detalles:'El CUIT del cliente es inválido'},'NC')).toMatchObject({ok:false,sinRespuesta:true});
    expect(comoError({response:{status:500,data:{isCreated:false,id:123,detalles:'Ya existe una factura con los siguientes datos'}}})).toMatchObject({ok:false,sinRespuesta:true});
    expect(comoError({response:{status:500,data:{detalles:'Validaciones: • El número de comprobante [77377] ya existe para el punto de venta [7] y empresa [1].'}}})).toMatchObject({ok:false,sinRespuesta:false});
  });
});

 describe('NC/ND en el punto manual confirmado por oficina', () => {
  it.each(['NC','ND'])('%s nunca avanza números después de una colisión', async tipo => {
    const {emitirNotaCredito,emitirNotaDebito}=await import('./facturarIM.js');
    const post=mockIM({isCreated:false,detalles:'Ya existe una factura con: punto_de_venta = 777 y numero = 30080'});
    const r=await (tipo==='NC'?emitirNotaCredito:emitirNotaDebito)({...DATOS,numero:30080});
    expect(r).toMatchObject({ok:false,sinRespuesta:false}); expect(post).toHaveBeenCalledTimes(1);
    expect((post.mock.calls[0] as any[])[1]).toMatchObject({punto_de_venta:777,id_destino:1,numero:30080,tipo_comprobante:tipo});
  });
  it('un cero explícito no consume un correlativo automático',async()=>{
    const {emitirNotaCredito}=await import('./facturarIM.js'); const post=mockIM({});
    expect(await emitirNotaCredito({...DATOS,numero:0})).toMatchObject({ok:false}); expect(post).not.toHaveBeenCalled();
  });
 });

 it('la colisión real del 777 es un rechazo: no queda incierta ni reintenta',async()=>{
  const {comoError,emitirNotaCredito}=await import('./facturarIM.js');
  const detalles="Validaciones: Ya existe una factura con: tag = 'S', cod_empresa = 1, id_destino = 1, punto_de_venta = 777, tipo_factura = 'B' y numero = 30059.";
  const e={response:{status:400,data:{detalles}}}; const post=mockIM(null,e);
  expect(await emitirNotaCredito({...DATOS,numero:30059})).toMatchObject({ok:false,sinRespuesta:false}); expect(post).toHaveBeenCalledTimes(1);
  expect(comoError({response:{status:400,data:{detalles,id:123}}})).toMatchObject({sinRespuesta:true});
 });
 it.each([['IM_PTO_VENTA_NC','999'],['IM_ID_DESTINO_NC','3'],['IM_NUMERO_NC_AUTO','1']])('configuración antigua %s=%s no envía notas',async(key,value)=>{
  vi.resetModules();vi.stubEnv(key,value);
  try {const {emitirNotaCredito}=await import('./facturarIM.js');const post=mockIM({});expect(await emitirNotaCredito({...DATOS,numero:30080})).toMatchObject({ok:false});expect(post).not.toHaveBeenCalled();}
  finally {vi.unstubAllEnvs();vi.resetModules();}
 });

/**
 * 🔴 EL NÚMERO SALE DE LA SERIE A LA QUE VA A PERTENECER EL COMPROBANTE.
 *
 * InfoManager nombra al rechazar un número repetido: *"tag = 'S', cod_empresa = 1,
 * id_destino = 1, punto_de_venta = 777, tipo_factura = 'B' y numero = …"*. El cálculo filtraba
 * sólo tipo, letra y punto: en una instalación con más de una empresa, el máximo podía venir de
 * un talonario ajeno.
 */
describe('proximoNumeroFactura — el número sale de la serie correcta', () => {
  const venta = (extra: any) => ({
    tipo_comprobante: 'FA', tipo_factura: 'B', punto_de_venta: 777,
    cod_empresa: 1, id_destino: 1, tag: 'S', ...extra,
  });
  const conVentas = async (filas: any[]) => {
    const get = vi.fn(async () => ({ data: { results: filas } }));
    vi.mocked(axios.create).mockReturnValue({ post: vi.fn(), get, put: vi.fn(), interceptors: { request: { use: vi.fn() } } } as any);
    vi.mocked(axios.post).mockResolvedValue({ data: { token: 'tok' } } as any);
    const { proximoNumeroFactura, invalidarCacheNumeracion } = await import('./facturarIM.js').then(async m => ({
      ...m, invalidarCacheNumeracion: (await import('./infomanager.js')).invalidarCacheNumeracion,
    }));
    invalidarCacheNumeracion();
    return proximoNumeroFactura('B', 777, 30, 'FA', SERIE);
  };

  it('🔑 una serie de OTRA EMPRESA no mueve el número', async () => {
    expect(await conVentas([venta({ numero: 100 }), venta({ numero: 9999, cod_empresa: 2 })])).toBe(101);
  });

  it('🔑 ni la de otro DESTINO', async () => {
    expect(await conVentas([venta({ numero: 100 }), venta({ numero: 9999, id_destino: 3 })])).toBe(101);
  });

  it('🔑 ni la de otro TAG', async () => {
    expect(await conVentas([venta({ numero: 100 }), venta({ numero: 9999, tag: 'N' })])).toBe(101);
  });

  it('sigue respetando tipo, letra y punto de venta', async () => {
    expect(await conVentas([
      venta({ numero: 100 }),
      venta({ numero: 9999, tipo_comprobante: 'NC' }),
      venta({ numero: 9998, tipo_factura: 'A' }),
      venta({ numero: 9997, punto_de_venta: 999 }),
    ])).toBe(101);
  });

  /**
   * 🔴 UNA FILA QUE NO SE PUEDE UBICAR NO SE SALTEA: CORTA.
   *
   * Saltearla parece prudente y no lo es: si resultara ser de esta serie y tuviera el número más
   * alto, el máximo saldría más bajo y propondríamos un correlativo YA USADO. Sólo se descarta
   * lo demostrablemente ajeno; ante la duda no hay número.
   */
  it('🔑 una fila compatible SIN empresa, destino o tag deja el número en null', async () => {
    for (const falta of [{ cod_empresa: null }, { id_destino: undefined }, { tag: null }]) {
      expect(await conVentas([venta({ numero: 100 }), venta({ numero: 9999, ...falta })]), JSON.stringify(falta)).toBeNull();
    }
  });

  it('🔑 ni con valores ilegibles o que sólo coincidirían por coerción', async () => {
    for (const malo of [{ cod_empresa: 'x' }, { id_destino: [1] }, { tag: ['S'] }, { cod_empresa: true }, { punto_de_venta: '777abc' }, { cod_empresa: 1.5 }, { id_destino: 1e20 }]) {
      expect(await conVentas([venta({ numero: 100 }), venta({ numero: 9999, ...malo })]), JSON.stringify(malo)).toBeNull();
    }
  });

  it('🔑 una PROPIA con número ilegible tampoco deja emitir', async () => {
    expect(await conVentas([venta({ numero: 100 }), venta({ numero: 'abc' })])).toBeNull();
    expect(await conVentas([venta({ numero: 100 }), venta({ numero: null })])).toBeNull();
  });

  /** El caso concreto: 50400 legible + una que podría ser nuestra. No puede salir 50401. */
  it('🔑 mezcla de una válida y una potencialmente propia ilegible: NO emite el siguiente', async () => {
    const r = await conVentas([venta({ numero: 50400 }), venta({ numero: 50999, tag: null })]);
    expect(r).not.toBe(50401);
    expect(r).toBeNull();
  });

  it('🪤 pasado el entero seguro, el +1 deja de ser el siguiente: null', async () => {
    expect(await conVentas([venta({ numero: Number.MAX_SAFE_INTEGER })])).toBeNull();
  });

  it('🪤 una serie ajena ilegible en tipo o letra tampoco se puede descartar', async () => {
    expect(await conVentas([venta({ numero: 100 }), venta({ numero: 9999, tipo_comprobante: null })])).toBeNull();
  });

  it('la empresa y el punto sí cuentan cuando vienen como texto', async () => {
    expect(await conVentas([venta({ numero: 100, cod_empresa: '1', punto_de_venta: '777' })])).toBe(101);
  });

  it('sin ninguna fila de la serie, no inventa un número', async () => {
    expect(await conVentas([venta({ numero: 500, cod_empresa: 2 })])).toBeNull();
  });
});

/**
 * 🪤 `VentasItemsCrear` marca `descuento_porc` como **required**, y el armado lo omitía cuando
 * valía 0. La API lo venía aceptando, así que esto NO prueba ser la causa de ningún rechazo: es
 * cumplir el contrato donde no se cumplía. Se acota a las notas para no tocar factura y remito.
 */
describe('el renglón de una nota cumple el contrato', () => {
  const emitir = async (items: any[]) => {
    const post = vi.fn(async () => ({ data: { id: '1', numero: 30079 } }));
    vi.mocked(axios.create).mockReturnValue({
      post, get: vi.fn(async () => ({ data: { results: [] } })), put: vi.fn(),
      interceptors: { request: { use: vi.fn() } },
    } as any);
    vi.mocked(axios.post).mockResolvedValue({ data: { token: 'tok' } } as any);
    const { emitirNotaCredito } = await import('./facturarIM.js');
    await emitirNotaCredito({
      cod_empresa: 1, cod_cliente: 1039, cod_vendedor: 2, usuario: 'anto', categoria_iva: 'CF',
      cod_lista_precios: 12, total: 100, numero: 30079, items,
    } as any);
    return (post.mock.calls[0] as any[])?.[1];
  };

  it('🔑 con descuento 0 el campo VIAJA, no se omite', async () => {
    const p = await emitir([{ cod_articulo: 610, cantidad: 5, precio: 100, iva_por: 21, descuento_porc: 0 }]);
    expect(p.items[0]).toHaveProperty('descuento_porc', 0);
  });

  it('🔑 y sin el campo en el origen, también', async () => {
    const p = await emitir([{ cod_articulo: 610, cantidad: 5, precio: 100, iva_por: 21 }]);
    expect(p.items[0]).toHaveProperty('descuento_porc', 0);
  });

  it('🪤 un descuento positivo se conserva tal cual', async () => {
    const p = await emitir([{ cod_articulo: 610, cantidad: 5, precio: 100, iva_por: 21, descuento_porc: 15 }]);
    expect(p.items[0].descuento_porc).toBe(15);
  });

  it('🪤 el precio y el IVA del renglón no se tocan', async () => {
    const p = await emitir([{ cod_articulo: 610, cantidad: 5, precio: 1234.56, iva_por: 10.5, descuento_porc: 0 }]);
    expect(p.items[0]).toMatchObject({ cod_articulo: 610, cantidad: 5, precio: 1234.56, iva_por: 10.5 });
  });
});

/** 🔴 Un `numero` precalculado NO exime de acreditar su talonario: si no, es un bypass. */
describe('el contexto se valida aunque el número venga dado', () => {
  const emitir = async (fn: 'factura' | 'nota', datos: any) => {
    const post = vi.fn(async () => ({ data: { id: '1', numero: 999 } }));
    vi.mocked(axios.create).mockReturnValue({
      post, get: vi.fn(async () => ({ data: { results: [] } })), put: vi.fn(),
      interceptors: { request: { use: vi.fn() } },
    } as any);
    vi.mocked(axios.post).mockResolvedValue({ data: { token: 'tok' } } as any);
    const m = await import('./facturarIM.js');
    const base = { cod_cliente: 1, cod_vendedor: 2, usuario: 'u', categoria_iva: 'CF',
      cod_lista_precios: 12, total: 100, numero: 50500,
      items: [{ cod_articulo: 1, cantidad: 1, precio: 100, iva_por: 0 }] };
    const r = fn === 'factura'
      ? await m.emitirFactura({ ...base, ...datos } as any)
      : await m.emitirNotaCredito({ ...base, ...datos } as any);
    return { r, post };
  };

  it('🔑 con empresa inválida NO se hace el POST, aunque el número venga dado', async () => {
    for (const empresa of [0, -1, 1.5, 'x', null, undefined, true]) {
      const { r, post } = await emitir('factura', { cod_empresa: empresa });
      expect(r.ok, String(empresa)).toBe(false);
      expect(post, String(empresa)).not.toHaveBeenCalled();
    }
  });

  it('🔑 lo mismo para la nota', async () => {
    const { r, post } = await emitir('nota', { cod_empresa: null });
    expect(r.ok).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it('con una empresa válida sí emite', async () => {
    const { post } = await emitir('factura', { cod_empresa: 1 });
    expect(post).toHaveBeenCalled();
  });
});
