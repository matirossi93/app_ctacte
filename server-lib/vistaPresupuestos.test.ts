import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * La vista de presupuestos: lo primero que ve Jorgelina.
 *
 * 🔄 Lo que se prueba acá es que los avisos de lista salgan de lo que está HOY en InfoManager y
 * no de una foto vieja. Mati (09/09/2026): *"las advertencias de precios siguen saliendo a pesar
 * de que se hacen las modificaciones correspondientes"* — salían de `pedidos_vendedor_items`,
 * que se escribe cuando el vendedor carga el pedido y no se vuelve a tocar nunca.
 */

vi.hoisted(() => { process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret'; });

const m = vi.hoisted(() => ({
  sbMock: vi.fn(),
  fetchVentas: vi.fn(),
  fetchVentasItems: vi.fn(),
  reglasActivas: vi.fn(),
  descuentosActivos: vi.fn(),
}));

/** ALPISTE a granel: 30 kg por bolsa. Con 20 kg o más corresponde L1 (12); con menos, L2 (13). */
const CATALOGO = new Map([[1, {
  cod_articulo: 1, descripcion: 'ALPISTE', subrubro: 'Semillas',
  es_bulto: true, kg_por_bulto: 30, unidad_de_medida: 'BOLSA', equivalencia_um: 30,
}]]);

vi.mock('./infomanager.js', () => ({
  // El cache de /ventas se limpia junto con las vistas (10/09/2026).
  invalidarCacheVentas: vi.fn(),
  fetchVentas: m.fetchVentas,
  fetchVentasItems: m.fetchVentasItems,
  fetchArticulosCatalogo: vi.fn(async () => CATALOGO),
  // Se pide con los códigos del rango: un cliente recién creado no está en el cache.
  fetchClientesIMCon: vi.fn(async () => [{ cod_cliente: 7, razon_social: 'FORRAJERIA EL SOL' }]),
  fetchStockPorDeposito: vi.fn(async () => new Map([[1, 999]])),
}));
vi.mock('./pedidos.js', () => ({
  reglasActivas: m.reglasActivas,
  descuentosActivos: m.descuentosActivos,
  catalogoParaListas: vi.fn(async () => CATALOGO),
}));
vi.mock('./supabase.js', () => ({ sb: m.sbMock, TENANT_ID: 'test-tenant', hasSupabase: () => true }));

const { vistaDeRango, invalidarVista } = await import('./vistaPresupuestos.js');

function fakeSb() {
  m.sbMock.mockImplementation(() => ({
    from: () => {
      const res = { data: [], error: null };
      const q: any = {
        then: (r: any, j: any) => Promise.resolve(res).then(r, j),
        maybeSingle: () => Promise.resolve(res),
        delete: () => q, insert: () => q, upsert: () => q, update: () => q,
      };
      for (const k of ['select', 'eq', 'in', 'not', 'is', 'or', 'order', 'limit']) q[k] = () => q;
      return q;
    },
  }));
}

const PR = {
  id: '999', numero: 58300, tipo_comprobante: 'PR', anulada: 'N',
  // 🔑 El panel es de Casa Central: los de otras empresas ni se miran (ver el test de abajo).
  cod_empresa: 1,
  fecha: '2026-09-09', cod_cliente: 7, total: 10000, observaciones: '',
};
/** Un renglón de 1 bolsa (30 kg) del artículo 1, con la lista y el descuento que se le pasen. */
const renglon = (cod_lista_precios: number, descuento_porc = 0) => ([{
  id_comprobante: '999', cod_articulo: 1, cantidad: 1, cod_lista_precios, descuento_porc,
  precio: 1000, precio_orig: 1000, iva_por: 0,
}]);

beforeEach(() => {
  vi.clearAllMocks();
  invalidarVista();
  fakeSb();
  m.fetchVentas.mockResolvedValue([PR]);
  // 30 kg de ALPISTE: por cantidad le corresponde L1 (12).
  m.reglasActivas.mockResolvedValue([
    { nombre: 'SEMILLAS', match_tipo: 'subrubro', match_valor: 'Semillas', cod_lista: 12, condicion: 'min', umbral: 20, unidad: 'kg', ambito: 'articulo' },
  ]);
  m.descuentosActivos.mockResolvedValue([]);
});

describe('los avisos de lista se recalculan contra InfoManager', () => {
  it('🔴 con la lista mal puesta, avisa que la empresa pierde margen', async () => {
    m.fetchVentasItems.mockResolvedValue(renglon(13));    // está en L2 y le corresponde L1
    const v = await vistaDeRango('2026-09-09', '2026-09-09', true);
    const fila = v.pendientes[0];
    expect(fila.gravedad.pierde_margen).toBe(1);
    expect(fila.avisos[0]).toMatch(/le corresponde/i);
  });

  /**
   * 🔑 EL PUNTO DE TODO ESTE CAMBIO: se corrige la lista en InfoManager y el cartel se va solo.
   * Antes salía de una foto guardada al crear el pedido y no se borraba nunca.
   */
  it('🔑 corregida la lista en IM, el aviso DESAPARECE en el refresco siguiente', async () => {
    m.fetchVentasItems.mockResolvedValue(renglon(13));
    const antes = await vistaDeRango('2026-09-09', '2026-09-09', true);
    expect(antes.pendientes[0].gravedad.pierde_margen).toBe(1);

    m.fetchVentasItems.mockResolvedValue(renglon(12));    // Jorgelina la corrigió
    const despues = await vistaDeRango('2026-09-09', '2026-09-09', true);
    expect(despues.pendientes[0].gravedad.pierde_margen).toBe(0);
    expect(despues.pendientes[0].avisos).toEqual([]);
  });

  /**
   * 🪤 "Tiene derecho a L1 y está en L2" es un falso positivo cuando el renglón lleva descuento:
   * un descuento y una lista mejor son dos caminos al mismo precio (Mati, 27/08/2026). Acusar de
   * más hace que después nadie mire ningún cartel.
   */
  it('🪤 no acusa "le cobrás de más" a un renglón que lleva descuento', async () => {
    m.reglasActivas.mockResolvedValue([
      { nombre: 'SEMILLAS', match_tipo: 'subrubro', match_valor: 'Semillas', cod_lista: 13, condicion: 'min', umbral: 20, unidad: 'kg', ambito: 'articulo' },
    ]);
    m.fetchVentasItems.mockResolvedValue(renglon(12, 25));   // lista más cara, pero con 25% off
    const v = await vistaDeRango('2026-09-09', '2026-09-09', true);
    expect(v.pendientes[0].gravedad.cobra_de_mas).toBe(0);
  });

  it('sin descuento, ese mismo caso sí se marca', async () => {
    m.reglasActivas.mockResolvedValue([
      { nombre: 'SEMILLAS', match_tipo: 'subrubro', match_valor: 'Semillas', cod_lista: 13, condicion: 'min', umbral: 20, unidad: 'kg', ambito: 'articulo' },
    ]);
    m.fetchVentasItems.mockResolvedValue(renglon(12));
    const v = await vistaDeRango('2026-09-09', '2026-09-09', true);
    expect(v.pendientes[0].gravedad.cobra_de_mas).toBe(1);
  });

  /**
   * 🔑 Ahora vale para TODOS los presupuestos, no sólo para los que entran por la app — que son
   * el 24%. El resto los carga la oficina en InfoManager y nunca tuvieron control de listas.
   */
  it('🔑 marca también los presupuestos que NO salieron de la app', async () => {
    m.fetchVentasItems.mockResolvedValue(renglon(13));
    const v = await vistaDeRango('2026-09-09', '2026-09-09', true);
    expect(v.pendientes[0].de_la_app).toBe(false);
    expect(v.pendientes[0].gravedad.pierde_margen).toBe(1);
  });

  /**
   * 🪤 Sin reglas la pantalla tiene que abrir igual. Que no se pueda evaluar una lista no puede
   * dejar a la oficina sin ver los pedidos del día.
   */
  it('🪤 si las reglas no se pueden leer, la vista abre igual y sin carteles', async () => {
    m.reglasActivas.mockRejectedValue(new Error('supabase caído'));
    m.fetchVentasItems.mockResolvedValue(renglon(13));
    const v = await vistaDeRango('2026-09-09', '2026-09-09', true);
    expect(v.pendientes).toHaveLength(1);
    expect(v.pendientes[0].avisos).toEqual([]);
    expect(v.pendientes[0].gravedad.pierde_margen).toBe(0);
  });
});


describe('dos presupuestos vivos del mismo cliente', () => {
  /**
   * 🔴 09/09/2026, NAVARRO Andrea. El panel editó el PR 58301 y creó el 58309, pero el pedido de
   * la app siguió apuntando al 58301. El vendedor editó después desde la app: `editarPedido` vio
   * ese comprobante anulado, recreó a partir de él y anuló el que ya estaba anulado. Quedaron el
   * 58309 y el 58317 vivos, los dos facturables — Mati: *"nos están saliendo los dos"*.
   *
   * La causa se arregla en `editarPresupuesto` (reapunta el pedido). Esto es la segunda defensa:
   * que se VEA antes de facturar, porque facturar los dos le manda al cliente el doble.
   */
  const otro = { ...PR, id: '1000', numero: 58317, total: 264370.25 };

  it('🔴 cada uno sabe del otro', async () => {
    m.fetchVentas.mockResolvedValue([PR, otro]);
    m.fetchVentasItems.mockResolvedValue([...renglon(12), { ...renglon(12)[0], id_comprobante: '1000' }]);
    const v = await vistaDeRango('2026-09-09', '2026-09-09', true);
    const a = v.pendientes.find((f: any) => f.im_comprobante_id === '999');
    const b = v.pendientes.find((f: any) => f.im_comprobante_id === '1000');
    expect(a.hermanos).toEqual([{ im_comprobante_id: '1000', im_numero: 58317, total: 264370.25 }]);
    expect(b.hermanos[0].im_numero).toBe(58300);
    expect(v.duplicados).toBe(2);
  });

  it('un pedido solo no se marca', async () => {
    m.fetchVentasItems.mockResolvedValue(renglon(12));
    const v = await vistaDeRango('2026-09-09', '2026-09-09', true);
    expect(v.pendientes[0].hermanos).toEqual([]);
    expect(v.duplicados).toBe(0);
  });

  /** Dos pedidos del mismo cliente en días distintos son normales: no se marcan. */
  it('🪤 el mismo cliente en OTRO día no es un duplicado', async () => {
    m.fetchVentas.mockResolvedValue([PR, { ...otro, fecha: '2026-09-08' }]);
    m.fetchVentasItems.mockResolvedValue(renglon(12));
    const v = await vistaDeRango('2026-09-08', '2026-09-09', true);
    for (const f of v.pendientes) expect(f.hermanos).toEqual([]);
  });

  /** Y el anulado no cuenta: el filtro de vigentes ya lo dejó afuera. */
  it('🪤 uno anulado no marca al que quedó vivo', async () => {
    m.fetchVentas.mockResolvedValue([PR, { ...otro, anulada: 'S' }]);
    m.fetchVentasItems.mockResolvedValue(renglon(12));
    const v = await vistaDeRango('2026-09-09', '2026-09-09', true);
    expect(v.pendientes).toHaveLength(1);
    expect(v.pendientes[0].hermanos).toEqual([]);
  });
});

/**
 * 🔴 EL PANEL ES DE CASA CENTRAL. Mati (09/09/2026): *"el panel tiene que ser para casa central
 * únicamente, porque es la única que tiene hoja de ruta... ya están apareciendo pedidos de las
 * otras sucursales"*.
 *
 * Medido ese día sobre los remitos vivos de una semana: 182 de Casa Central (empresa 1) contra
 * **1.852 de las sucursales** (empresas 2, 3 y 4). Nueve de cada diez filas eran de otra
 * sucursal, que además no se despacha desde acá.
 */
describe('sólo Casa Central', () => {
  it('🔴 un presupuesto de otra sucursal no entra en la vista', async () => {
    m.fetchVentas.mockResolvedValue([
      { ...PR, id: '999', cod_empresa: 1 },
      { ...PR, id: '1000', numero: 58301, cod_empresa: 2 },   // San Martín
      { ...PR, id: '1001', numero: 58302, cod_empresa: 3 },   // otra sucursal
    ]);
    m.fetchVentasItems.mockResolvedValue(renglon(12));
    const v = await vistaDeRango('2026-09-09', '2026-09-09', true);
    const ids = [...v.pendientes, ...v.asignados].map((f: any) => String(f.im_comprobante_id));
    expect(ids).toEqual(['999']);
  });
});
