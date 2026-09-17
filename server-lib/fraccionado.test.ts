import { describe, it, expect } from 'vitest';
import { armarFraccionado, totalesFraccionado, esKilo } from './fraccionado.js';

/**
 * El listado que va al sector de fraccionado. Si está mal, preparan de más, de menos, o
 * fraccionan algo que venía en bolsa cerrada.
 */

const CAT = new Map<number, { descripcion: string; unidad_de_medida: string | null }>([
  [1, { descripcion: 'MEZCLA FINA ESPECIAL', unidad_de_medida: 'KG' }],
  [2, { descripcion: 'AVENA INSTANTANEA', unidad_de_medida: 'Kilos' }],
  [3, { descripcion: 'ALIMENTO PERRO 22KG', unidad_de_medida: 'BOLSA' }],
  [4, { descripcion: 'PASTA DE MANI', unidad_de_medida: 'UNIDAD' }],
]);

/** Lo que `formatosBolsa` deduce de los pedidos: la mezcla y la avena vienen en bolsa. */
const FORMATOS = new Map<number, number>([[1, 30], [2, 20]]);

describe('armarFraccionado', () => {
  it('🔑 cuatro pedidos de 30 kg son cuatro BOLSAS CERRADAS: no se fracciona nada', () => {
    // 🔄 Cambió el 09/09/2026. Antes esto daba cuatro paquetes de 30 para fraccionar; Mati:
    // "si dice 60 kilos, no son 60 kilos fraccionados, son 2 bolsas de 30". Un múltiplo exacto
    // de la bolsa ya viene preparado del depósito.
    const r = armarFraccionado([
      { cod_articulo: 1, cantidad: 30 }, { cod_articulo: 1, cantidad: 30 },
      { cod_articulo: 1, cantidad: 30 }, { cod_articulo: 1, cantidad: 30 },
    ], CAT, FORMATOS);
    expect(r).toHaveLength(1);
    expect(r[0].bolsas_enteras).toBe(4);
    expect(r[0].paquetes).toBe(0);
  });

  it('🔴 "no se puede globalizar": dos pedidos de 15 kg son dos juegos de paquetes, no uno de 30', () => {
    // Mati (07/09/2026). Si se sumaran, el sector prepararía un solo bulto para dos clientes.
    const r = armarFraccionado([
      { cod_articulo: 1, cantidad: 15 }, { cod_articulo: 1, cantidad: 15 },
    ], CAT, FORMATOS);
    expect(r[0].cantidades).toEqual([10, 10, 5, 5]);
    expect(r[0].kg).toBe(30);
  });

  it('🔴 lo que NO se vende por kilo no se fracciona', () => {
    // Una bolsa cerrada de 22 kg viaja como está. Si entrara al listado, alguien la abriría.
    const r = armarFraccionado([
      { cod_articulo: 3, cantidad: 10 }, { cod_articulo: 4, cantidad: 5 },
      { cod_articulo: 2, cantidad: 60 },
    ], CAT);
    expect(r.map(x => x.descripcion)).toEqual(['AVENA INSTANTANEA']);
  });

  it('las cantidades salen de mayor a menor y los productos en orden alfabético', () => {
    // La avena viene en bolsa de 20: los pedidos de 60 y 20 son bolsas cerradas y el de 10 se
    // fracciona. La mezcla de 20 no es múltiplo de 30, así que va en 10 + 10.
    const r = armarFraccionado([
      { cod_articulo: 2, cantidad: 10 }, { cod_articulo: 1, cantidad: 20 },
      { cod_articulo: 2, cantidad: 60 }, { cod_articulo: 2, cantidad: 20 },
    ], CAT, FORMATOS);
    expect(r.map(x => x.descripcion)).toEqual(['AVENA INSTANTANEA', 'MEZCLA FINA ESPECIAL']);
    expect(r[0].cantidades).toEqual([10]);
    expect(r[0].bolsas_enteras).toBe(4);          // 60 = 3 bolsas + 20 = 1 bolsa
    expect(r[1].cantidades).toEqual([10, 10]);
  });

  it('un artículo que no está en el catálogo no se inventa', () => {
    // Sin ficha no se sabe si va por kilo: queda afuera y el pedido igual se prepara a mano.
    expect(armarFraccionado([{ cod_articulo: 999, cantidad: 30 }], CAT)).toHaveLength(0);
  });

  it('cantidades en cero o negativas no generan paquetes', () => {
    expect(armarFraccionado([
      { cod_articulo: 1, cantidad: 0 }, { cod_articulo: 1, cantidad: -5 },
    ], CAT)).toHaveLength(0);
  });

  it('los kilos no arrastran el error del punto flotante', () => {
    // 30,1 + 30,2 da 60,29999... y esto se pesa en una balanza.
    const r = armarFraccionado([
      { cod_articulo: 1, cantidad: 30.1 }, { cod_articulo: 1, cantidad: 30.2 },
    ], CAT);
    expect(r[0].kg).toBe(60.3);
  });

  it('esKilo reconoce cómo lo escribe IM, y no confunde otras unidades', () => {
    for (const u of ['KG', 'kg', ' Kilos ', 'KILOGRAMO']) expect(esKilo(u)).toBe(true);
    for (const u of ['BOLSA', 'UNIDAD', '', null, undefined, 'KGS']) expect(esKilo(u)).toBe(false);
  });
});

describe('totalesFraccionado', () => {
  it('cuenta productos, paquetes y kilos de lo que SÍ hay que fraccionar', () => {
    // Mezcla (bolsa 30): 30 es bolsa entera, 20 va en 10 + 10. Avena (bolsa 20): 60 son 3
    // bolsas enteras. Así que se fraccionan 2 paquetes y 20 kg, no los 110 pedidos.
    const lineas = armarFraccionado([
      { cod_articulo: 1, cantidad: 30 }, { cod_articulo: 1, cantidad: 20 },
      { cod_articulo: 2, cantidad: 60 },
    ], CAT, FORMATOS);
    expect(totalesFraccionado(lineas)).toEqual({ productos: 2, paquetes: 2, kg: 20 });
    expect(lineas.reduce((s, l) => s + l.bolsas_enteras, 0)).toBe(4);
  });
});

it('conserva código y separa artículos con el mismo nombre en el impreso',()=>{
 const cat=new Map([[10,{descripcion:'MEZCLA',unidad_de_medida:'KG'}],[20,{descripcion:'MEZCLA',unidad_de_medida:'KG'}]]);
 const r=armarFraccionado([{cod_articulo:10,cantidad:5},{cod_articulo:20,cantidad:3}],cat);
 expect(r).toHaveLength(2);expect(r[0]).toMatchObject({cod_articulo:10,kg:5});expect(r[1]).toMatchObject({cod_articulo:20,kg:3});
});

/**
 * 🔑 LO QUE SE FABRICA ACÁ. Mati (16/09/2026): *"necesito que incluyamos también en el reporte de
 * fraccionados los balanceados de producción propia y el maíz quebrado, es mercadería que
 * producimos y necesitamos saber también para que produzcan la gente de producción"*.
 */
describe('lo que hay que producir', () => {
  const cat = new Map<number, any>([
    [51, { descripcion: 'CERDO X 40 KG', subrubro: 'Semillero' }],
    [57, { descripcion: 'PONEDORA POSTURA X 40 KG', subrubro: 'Semillero' }],
    [477, { descripcion: 'MAIZ QUEBRADO MEDIANO X 30 KG', subrubro: 'Quebrados' }],
    [463, { descripcion: 'MAIZ QUEBRADO', subrubro: 'Quebrados' }],
    [1, { descripcion: 'ALPISTE', subrubro: 'Semillas' }],
  ]);

  it('🔑 junta los balanceados propios y el maíz quebrado, con sus kilos', async () => {
    const { armarProduccion } = await import('./fraccionado.js');
    const r = armarProduccion([
      { cod_articulo: 51, cantidad: 3 }, { cod_articulo: 477, cantidad: 10 },
      { cod_articulo: 1, cantidad: 30 },
    ], cat);
    // Ordenado por subrubro: el sector prepara primero una familia y después la otra.
    expect(r).toEqual([
      { cod_articulo: 477, descripcion: 'MAIZ QUEBRADO MEDIANO X 30 KG', subrubro: 'Quebrados', bolsas: 10, kg: 300 },
      { cod_articulo: 51, descripcion: 'CERDO X 40 KG', subrubro: 'Semillero', bolsas: 3, kg: 120 },
    ]);
  });

  it('🪤 y NO mete lo que se fracciona: son dos trabajos de dos sectores distintos', async () => {
    const { armarProduccion } = await import('./fraccionado.js');
    expect(armarProduccion([{ cod_articulo: 1, cantidad: 30 }], cat)).toEqual([]);
  });

  it('suma el mismo producto pedido por varios clientes', async () => {
    const { armarProduccion } = await import('./fraccionado.js');
    const r = armarProduccion([
      { cod_articulo: 51, cantidad: 3 }, { cod_articulo: 51, cantidad: 2 }, { cod_articulo: 51, cantidad: 0.5 },
    ], cat);
    expect(r[0]).toMatchObject({ bolsas: 5.5, kg: 220 });
  });

  /** Sin kilos en la presentación no se inventa un peso: se informa la bolsa y listo. */
  it('un producto sin kilos declarados sale igual, sin kilos', async () => {
    const { armarProduccion } = await import('./fraccionado.js');
    expect(armarProduccion([{ cod_articulo: 463, cantidad: 4 }], cat)[0]).toMatchObject({ bolsas: 4, kg: null });
  });

  it('ignora cantidades que no son cantidades', async () => {
    const { armarProduccion } = await import('./fraccionado.js');
    for (const c of [0, -3, NaN, null, undefined]) {
      expect(armarProduccion([{ cod_articulo: 51, cantidad: c as any }], cat), String(c)).toEqual([]);
    }
  });
});

/**
 * 🔴 EL FORMATO QUE SABEMOS DE MEMORIA MANDA SOBRE EL DEDUCIDO.
 *
 * Mati (16/09/2026): *"está mal el fraccionado en el girasol pelado, la bolsa viene por 25 kg y
 * en la app se está fraccionando en cantidades más chicas"*. La deducción necesita 20 renglones
 * del artículo en 30 días: lo que se vende poco no llega nunca a esa muestra.
 */
describe('el formato de bolsa conocido', () => {
  it('🔑 GIRASOL PELADO son bolsas de 25 kg, no paquetes de 10', async () => {
    // `formatosBolsa` arrastra la carga de InfoManager, que exige su secreto al importarse.
    process.env.INFOMANAGER_CLIENT_SECRET ??= 'test-secret';
    const { FORMATOS_CONOCIDOS } = await import('./formatosBolsa.js');
    const { paquetesDelRenglon } = await import('./fraccionado.js');
    expect(FORMATOS_CONOCIDOS.get(459)).toBe(25);
    /**
     * Los que confirmó Mati: alpiste y mijo 25, lino 40, alubia 30 (16/09) · avena ARROLLADA 30,
     * avena INSTANTANEA 20 y sorgo 40 (17/09).
     *
     * 🪤 El 16/09 acá decía que la instantánea venía por 30 —*"las bolsas de avena son de 30"*
     * era la regla de PRECIOS, no el formato— y salió fraccionada mal. Y el sorgo no estaba, así
     * que se partía en paquetes de 10. Los kilajes cambian: esta lista envejece sola.
     */
    expect([...FORMATOS_CONOCIDOS.entries()].sort((a, b) => a[0] - b[0]))
      .toEqual([[400, 25], [401, 40], [402, 25], [403, 40], [459, 25], [703, 30], [704, 20], [723, 30]]);
    // 25 kg justos: una bolsa cerrada, nada que fraccionar.
    expect(paquetesDelRenglon(25, 25)).toMatchObject({ fracciona: false, bolsas: 1 });
    // 50 son dos bolsas; 30 no es múltiplo y sí se fracciona.
    expect(paquetesDelRenglon(50, 25)).toMatchObject({ fracciona: false, bolsas: 2 });
    expect(paquetesDelRenglon(30, 25)).toMatchObject({ fracciona: true });
  });

  /**
   * 🔴 LAS BOLSAS ENTERAS NO SE ABREN. Mati (16/09/2026), sobre los kilos que exceden la bolsa:
   * *"veníamos facturando esos kg extra fraccionados"*.
   *
   * Antes, una cantidad que no fuera múltiplo exacto se fraccionaba ENTERA: 30 kg de mijo con
   * bolsa de 25 salían como tres paquetes de 10 en vez de una bolsa cerrada más 5 kg. Medido
   * sobre 16 días de pedidos reales, eran 86 renglones de trabajo de más.
   */
  it('🔑 lo que pasa la bolsa se parte solo: bolsa cerrada + el resto', async () => {
    const { paquetesDelRenglon } = await import('./fraccionado.js');
    // MIJO, bolsa de 25: una cerrada y 5 kg a pesar.
    expect(paquetesDelRenglon(30, 25)).toEqual({ fracciona: true, paquetes: [5], bolsas: 1, formato: 25 });
    // 60 con bolsa de 25: dos cerradas y 10 kg.
    expect(paquetesDelRenglon(60, 25)).toEqual({ fracciona: true, paquetes: [10], bolsas: 2, formato: 25 });
    // 40 con bolsa de 30: una cerrada y 10 kg.
    expect(paquetesDelRenglon(40, 30)).toEqual({ fracciona: true, paquetes: [10], bolsas: 1, formato: 30 });
    // 🪤 El resto grande sigue partiéndose de a 10 como máximo: 55 con bolsa 40 son 1 + [10, 5].
    expect(paquetesDelRenglon(55, 40)).toEqual({ fracciona: true, paquetes: [10, 5], bolsas: 1, formato: 40 });
  });

  it('🪤 y menos de una bolsa se fracciona entero, como siempre', async () => {
    const { paquetesDelRenglon } = await import('./fraccionado.js');
    expect(paquetesDelRenglon(20, 25)).toEqual({ fracciona: true, paquetes: [10, 10] });
  });

  it('🔑 el listado suma las dos cosas del mismo renglón', async () => {
    const { armarFraccionado } = await import('./fraccionado.js');
    const cat = new Map([[402, { descripcion: 'MIJO', unidad_de_medida: 'Kilos' }]]);
    const r = armarFraccionado([{ cod_articulo: 402, cantidad: 30 }], cat as any, new Map([[402, 25]]));
    expect(r[0]).toMatchObject({ descripcion: 'MIJO', cantidades: [5], paquetes: 1, bolsas_enteras: 1, formato_bolsa: 25 });
  });

  it('🪤 sin el formato, 25 kg se partían en paquetes de 10: eso era el problema', async () => {
    const { paquetesDelRenglon } = await import('./fraccionado.js');
    const r = paquetesDelRenglon(25, null) as any;
    expect(r.fracciona).toBe(true);
    expect(r.paquetes.length).toBeGreaterThan(1);
  });
});
