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

const { emitirFactura, emitirRemito, letraDeFactura } = await import('./facturarIM.js');

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

beforeEach(() => { vi.clearAllMocks(); });

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

    it('🔴 después de tres choques se rinde en vez de seguir probando', async () => {
        const post = vi.fn(async () => ({ data: { mensaje: 'Ya existe una factura con los siguientes datos' } }));
        vi.mocked(axios.create).mockReturnValue({ post, get: vi.fn(), put: vi.fn(), interceptors: { request: { use: vi.fn() } } } as any);
        vi.mocked(axios.post).mockResolvedValue({ data: { token: 'tok' } } as any);
        const r = await emitirFactura({ ...DATOS, numero: 50360 } as any);
        expect(r.ok).toBe(false);
        expect(post).toHaveBeenCalledTimes(3);
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

describe('el remito cuando falta stock (09/09/2026)', () => {
  /**
   * 🔴 `mueve_stock: 'S'` es lo que dispara la validación de stock de IM. Probado contra IM con
   * un artículo en −570: con 'S' rechaza el remito entero, con 'N' sale siempre pero no
   * descuenta. Mati: *"nosotros desde IM generamos a pesar de que esté sin stock"*, así que
   * cuando IM rechaza se reintenta sin mover stock — y tiene que quedar ESCRITO en el remito,
   * porque si no nadie se entera de que ese stock quedó sin descontar.
   */
  it('por defecto mueve stock: es lo que corresponde', async () => {
    const post = mockIM({ isCreated: true, remito: { id: '1', numero: 5 } });
    await emitirRemito(DATOS);
    expect((post.mock.calls[0] as any[])[1].mueve_stock).toBe('S');
    expect((post.mock.calls[0] as any[])[1].observaciones).not.toMatch(/STOCK NO DESCONTADO/);
  });

  it('🔑 con sinMoverStock sale sin descontar Y queda escrito en el comprobante', async () => {
    const post = mockIM({ isCreated: true, remito: { id: '1', numero: 5 } });
    await emitirRemito(DATOS, { sinMoverStock: true });
    expect((post.mock.calls[0] as any[])[1].mueve_stock).toBe('N');
    expect((post.mock.calls[0] as any[])[1].observaciones).toMatch(/STOCK NO DESCONTADO/);
  });
});
