import { describe, it, expect } from 'vitest';
import {
  clasificarArticulo, bultosDelPedido, evaluarPedido,
  type ArticuloInfo, type ReglaLista,
} from './listas.js';

/** Artículos reales del catálogo de IM (bajados 26/08/2026), con sus datos crudos. */
const CRUDO = {
  granCampeon:  { cod_articulo: 140, descripcion: 'GRAN CAMPEON ADULTO X 21 KG', subrubro: 'Gran Campeon', unidad_de_medida: 'Bolsas', equivalencia_um: 21 },
  alpiste:      { cod_articulo: 400, descripcion: 'ALPISTE', subrubro: 'Cereales', unidad_de_medida: 'Kilos', equivalencia_um: 1 },
  avena:        { cod_articulo: 704, descripcion: 'AVENA INSTANTANEA', subrubro: 'Cereales', unidad_de_medida: 'Kilos', equivalencia_um: 1 },
  ganave:       { cod_articulo: 1, descripcion: 'BEBE x 25 Kg - GANAVE', subrubro: 'Ganave', unidad_de_medida: 'Bolsas', equivalencia_um: 25 },
  // Caso real de dato sucio: la descripción no dice kilos y la um está vacía, pero eq=20.
  piedras:      { cod_articulo: 1009, descripcion: 'PIEDRAS SANITARIAS X 20 KG', subrubro: 'Accesorios Perros y Gatos', unidad_de_medida: null, equivalencia_um: 20 },
  // Caso real de dato sucio: es un bulto (caja de 30u) pero eq=1.
  pitusas:      { cod_articulo: 3002, descripcion: 'GALLETAS PITUSAS CHOCOLATE 160gr x 30u', subrubro: 'Galletas', unidad_de_medida: 'Caja', equivalencia_um: 1 },
  // Caso real de dato sucio: shampoo de 250cc marcado como "Bolsas" en IM.
  shampoo:      { cod_articulo: 1987, descripcion: 'SHAMPOO ELMER CACHORRO X 250 CC', subrubro: 'Farmacia', unidad_de_medida: 'Bolsas', equivalencia_um: 1 },
};

const cat = (...ks: Array<keyof typeof CRUDO>) => {
  const m = new Map<number, ArticuloInfo>();
  for (const k of ks) { const a = clasificarArticulo(CRUDO[k]); m.set(a.cod_articulo, a); }
  return m;
};

/** Reglas tal como quedan en listas_reglas para estas líneas. */
const REGLAS: ReglaLista[] = [
  // LINEA GRAN CAMPEON: L1 "1 bolsa", L2 LIBRE, L3 LIBRE (Mati confirmó que llega hasta L3).
  { nombre: 'LINEA GRAN CAMPEON', match_tipo: 'subrubro', match_valor: 'Gran Campeon', cod_lista: 12, condicion: 'libre', umbral: null, unidad: null, ambito: null },
  { nombre: 'LINEA GRAN CAMPEON', match_tipo: 'subrubro', match_valor: 'Gran Campeon', cod_lista: 13, condicion: 'libre', umbral: null, unidad: null, ambito: null },
  { nombre: 'LINEA GRAN CAMPEON', match_tipo: 'subrubro', match_valor: 'Gran Campeon', cod_lista: 14, condicion: 'libre', umbral: null, unidad: null, ambito: null },
  // LINEA GANAVE: L1 "1 bolsa", L2 "10 bultos promo general".
  { nombre: 'LINEA GANAVE', match_tipo: 'subrubro', match_valor: 'Ganave', cod_lista: 12, condicion: 'libre', umbral: null, unidad: null, ambito: null },
  { nombre: 'LINEA GANAVE', match_tipo: 'subrubro', match_valor: 'Ganave', cod_lista: 13, condicion: 'promo_general', umbral: 10, unidad: 'bulto', ambito: 'pedido' },
  // ALPISTE: L1 "menos de 20 kilos", L2 "a partir de 20 kilos", L3 "10 bultos promo general".
  { nombre: 'ALPISTE', match_tipo: 'articulo', match_valor: '400', cod_lista: 12, condicion: 'max', umbral: 20, unidad: 'kg', ambito: 'articulo' },
  { nombre: 'ALPISTE', match_tipo: 'articulo', match_valor: '400', cod_lista: 13, condicion: 'min', umbral: 20, unidad: 'kg', ambito: 'articulo' },
  { nombre: 'ALPISTE', match_tipo: 'articulo', match_valor: '400', cod_lista: 14, condicion: 'promo_general', umbral: 10, unidad: 'bulto', ambito: 'pedido' },
];

describe('clasificarArticulo — bulto o granel', () => {
  it('la descripción con la multiplicación manda: "X 21 KG" es bulto de 21 kilos', () => {
    const a = clasificarArticulo(CRUDO.granCampeon);
    expect(a.es_bulto).toBe(true);
    expect(a.kg_por_bulto).toBe(21);
  });

  it('"x 25 Kg" en minúscula también (IM escribe de las dos formas)', () => {
    expect(clasificarArticulo(CRUDO.ganave).kg_por_bulto).toBe(25);
  });

  it('sin kilos en el nombre y unidad_de_medida vacía, manda equivalencia_um', () => {
    const a = clasificarArticulo(CRUDO.piedras);
    expect(a.es_bulto).toBe(true);
    expect(a.kg_por_bulto).toBe(20);
  });

  it('caja cerrada con equivalencia_um=1 igual es bulto (galletas x 30u)', () => {
    expect(clasificarArticulo(CRUDO.pitusas).es_bulto).toBe(true);
  });

  it('granel: sin presentación ni equivalencia, se vende por kilo', () => {
    const a = clasificarArticulo(CRUDO.alpiste);
    expect(a.es_bulto).toBe(false);
    expect(a.kg_por_bulto).toBe(0);
  });

  it('🪤 dato sucio de IM: un shampoo de 250cc marcado "Bolsas" NO cuenta como bulto', () => {
    // "X 250 CC" es el envase de una unidad de consumo. La descripción le gana a la
    // unidad_de_medida mal cargada — si no, un shampoo sumaría para la promo de 10 bultos.
    const a = clasificarArticulo(CRUDO.shampoo);
    expect(a.es_bulto).toBe(false);
    expect(a.kg_por_bulto).toBe(0);
  });

  it('🪤 mismo caso con el antiparasitario de 20 ml, también marcado "BOLSAS" en IM', () => {
    expect(clasificarArticulo({ cod_articulo: 1989, descripcion: 'ANTIPARASITARIO ELMER VERMICAN X 20 ML', subrubro: 'Farmacia', unidad_de_medida: 'BOLSAS', equivalencia_um: 1 }).es_bulto).toBe(false);
  });

  it('fardo "15X80 GR" sí es bulto: el número de unidades va antes de la X', () => {
    expect(clasificarArticulo({ cod_articulo: 671, descripcion: 'FRAC. PANCETA MANI CHEFF  MK 15X80 GR', subrubro: 'Fraccionado', unidad_de_medida: 'Fardo', equivalencia_um: 1.2 }).es_bulto).toBe(true);
  });

  it('"MAIZ BT X20KG" es bulto de 20 kg aunque IM lo tenga con equivalencia_um en 0', () => {
    const a = clasificarArticulo({ cod_articulo: 486, descripcion: 'MAIZ BT X20KG', subrubro: 'Maiz', unidad_de_medida: 'BOLSA', equivalencia_um: 0 });
    expect(a.es_bulto).toBe(true);
    expect(a.kg_por_bulto).toBe(20);
  });
});

describe('bultosDelPedido — qué suma para la promo general', () => {
  const c = cat('granCampeon', 'alpiste');

  it('los bultos suman por unidad', () => {
    expect(bultosDelPedido([{ cod_articulo: 140, cantidad: 9, cod_lista: 12 }], c)).toBe(9);
  });

  it('un granel de menos de 20 kg no suma nada', () => {
    expect(bultosDelPedido([{ cod_articulo: 400, cantidad: 19, cod_lista: 12 }], c)).toBe(0);
  });

  it('un granel de 20 kg suma UN bulto', () => {
    expect(bultosDelPedido([{ cod_articulo: 400, cantidad: 20, cod_lista: 12 }], c)).toBe(1);
  });

  it('60 kg de granel siguen siendo UN bulto, no tres (confirmado por Mati 26/08)', () => {
    expect(bultosDelPedido([{ cod_articulo: 400, cantidad: 60, cod_lista: 12 }], c)).toBe(1);
  });

  it('el ejemplo del audio: 9 bultos de Gran Campeón + 20 kg de granel = 10 bultos', () => {
    expect(bultosDelPedido([
      { cod_articulo: 140, cantidad: 9, cod_lista: 12 },
      { cod_articulo: 400, cantidad: 20, cod_lista: 12 },
    ], c)).toBe(10);
  });
});

describe('evaluarPedido — la promo general', () => {
  const c = cat('ganave', 'granCampeon', 'alpiste');

  it('con 9 bultos NO entra: Ganave se queda en L1', () => {
    const r = evaluarPedido([{ cod_articulo: 1, cantidad: 9, cod_lista: 12 }], c, REGLAS);
    expect(r.promo_general).toBe(false);
    expect(r.avisos[0].lista_sugerida).toBe(12);
    expect(r.avisos[0].severidad).toBe('ok');
  });

  it('con 10 bultos entra y Ganave pasa a L2', () => {
    const r = evaluarPedido([{ cod_articulo: 1, cantidad: 10, cod_lista: 13 }], c, REGLAS);
    expect(r.promo_general).toBe(true);
    expect(r.avisos[0].lista_sugerida).toBe(13);
    expect(r.avisos[0].severidad).toBe('ok');
  });

  it('el ejemplo del audio completo: 9 de Gran Campeón + 20 kg de alpiste habilitan la promo, y el alpiste igual sube a L3 por su condición propia', () => {
    const r = evaluarPedido([
      { cod_articulo: 140, cantidad: 9, cod_lista: 14 },
      { cod_articulo: 400, cantidad: 20, cod_lista: 14 },
    ], c, REGLAS);
    expect(r.bultos).toBe(10);
    expect(r.promo_general).toBe(true);
    // Gran Campeón: L3 libre, así que L3 está bien.
    expect(r.avisos[0].lista_sugerida).toBe(14);
    // Alpiste: 20 kg le dan L2, y la promo general le da L3. Gana la mejor.
    expect(r.avisos[1].lista_sugerida).toBe(14);
  });

  it('🔑 las promos se superponen: en el mismo pedido conviven L2 general y L3 puntual', () => {
    const r = evaluarPedido([
      { cod_articulo: 1, cantidad: 10, cod_lista: 13 },   // Ganave -> L2 por promo general
      { cod_articulo: 140, cantidad: 1, cod_lista: 14 },  // Gran Campeón -> L3 siempre
    ], c, REGLAS);
    expect(r.avisos[0].lista_sugerida).toBe(13);
    expect(r.avisos[1].lista_sugerida).toBe(14);
    expect(r.avisos.every(a => a.severidad === 'ok')).toBe(true);
  });
});

describe('evaluarPedido — condiciones por cantidad del propio artículo', () => {
  const c = cat('alpiste');

  it('19 kg de alpiste: L1 (la condición es "menos de 20 kilos")', () => {
    const r = evaluarPedido([{ cod_articulo: 400, cantidad: 19, cod_lista: 12 }], c, REGLAS);
    expect(r.avisos[0].lista_sugerida).toBe(12);
  });

  it('20 kg de alpiste: pasa a L2', () => {
    const r = evaluarPedido([{ cod_articulo: 400, cantidad: 20, cod_lista: 13 }], c, REGLAS);
    expect(r.avisos[0].lista_sugerida).toBe(13);
  });
});

describe('evaluarPedido — los dos tipos de error', () => {
  const c = cat('ganave', 'alpiste');

  it('lista MÁS ALTA de la que corresponde = pérdida de margen', () => {
    // 1 sola bolsa de Ganave: sin promo general, le toca L1. El vendedor puso L2.
    const r = evaluarPedido([{ cod_articulo: 1, cantidad: 1, cod_lista: 13 }], c, REGLAS);
    expect(r.avisos[0].severidad).toBe('margen');
    expect(r.avisos[0].mensaje).toContain('más barato');
  });

  it('lista MÁS BAJA teniendo derecho = le cobró de más al cliente', () => {
    // 25 kg de alpiste dan L2, pero el vendedor lo dejó en L1.
    const r = evaluarPedido([{ cod_articulo: 400, cantidad: 25, cod_lista: 12 }], c, REGLAS);
    expect(r.avisos[0].severidad).toBe('cliente');
    expect(r.avisos[0].mensaje).toContain('cobrando de más');
  });

  it('cuando coincide no dice nada', () => {
    const r = evaluarPedido([{ cod_articulo: 1, cantidad: 1, cod_lista: 12 }], c, REGLAS);
    expect(r.avisos[0].severidad).toBe('ok');
    expect(r.avisos[0].mensaje).toBeNull();
  });
});

describe('evaluarPedido — alcance casa central', () => {
  it('un artículo sin regla no se valida y no molesta (es de las minoristas)', () => {
    const c = cat('shampoo');
    const r = evaluarPedido([{ cod_articulo: 1987, cantidad: 3, cod_lista: 15 }], c, REGLAS);
    expect(r.avisos[0].severidad).toBe('sin_regla');
    expect(r.avisos[0].mensaje).toBeNull();
    expect(r.avisos[0].lista_sugerida).toBeNull();
  });

  it('🪤 el gemelo fraccionado "X KG" NO hereda las reglas de su línea', () => {
    // Vive en el subrubro 'Gran Campeon' igual que la bolsa, pero es venta minorista
    // al público. Si heredara la regla, el validador opinaría sobre algo fuera de alcance.
    const espejo = clasificarArticulo({ cod_articulo: 10186, descripcion: 'GRAN CAMPEON ADULTO CAR Y POLL X KG', subrubro: 'Gran Campeon', unidad_de_medida: null, equivalencia_um: 0 });
    expect(espejo.es_fraccionado).toBe(true);
    const c = new Map([[10186, espejo]]);
    const r = evaluarPedido([{ cod_articulo: 10186, cantidad: 5, cod_lista: 12 }], c, REGLAS);
    expect(r.avisos[0].severidad).toBe('sin_regla');
  });

  it('pero SÍ se controla si Mati le puso una regla por código propio (avena forrajera)', () => {
    const av = clasificarArticulo({ cod_articulo: 453, descripcion: 'AVENA FORRAJERA X KG', subrubro: 'Forrajes', unidad_de_medida: 'Kilos', equivalencia_um: 1 });
    expect(av.es_fraccionado).toBe(true);
    const reglas: ReglaLista[] = [
      { nombre: 'AVENA FORRAJERA X KG', match_tipo: 'articulo', match_valor: '453', cod_lista: 13, condicion: 'min', umbral: 20, unidad: 'kg', ambito: 'articulo' },
    ];
    const r = evaluarPedido([{ cod_articulo: 453, cantidad: 25, cod_lista: 12 }], new Map([[453, av]]), reglas);
    expect(r.avisos[0].severidad).toBe('cliente');
    expect(r.avisos[0].lista_sugerida).toBe(13);
  });

  it('la bolsa "X 25 KG" no se confunde con el fraccionado "X KG"', () => {
    expect(clasificarArticulo(CRUDO.ganave).es_fraccionado).toBe(false);
    expect(clasificarArticulo(CRUDO.granCampeon).es_fraccionado).toBe(false);
  });

  it('un artículo que no está en el catálogo tampoco rompe', () => {
    const r = evaluarPedido([{ cod_articulo: 99999, cantidad: 1, cod_lista: 12 }], new Map(), REGLAS);
    expect(r.avisos[0].severidad).toBe('sin_regla');
  });

  it('la regla por artículo le gana a la de su línea', () => {
    // El alpiste es subrubro "Cereales" pero tiene regla propia por código: manda la propia.
    const c = cat('alpiste');
    const conLinea: ReglaLista[] = [...REGLAS,
      { nombre: 'CEREALES', match_tipo: 'subrubro', match_valor: 'Cereales', cod_lista: 15, condicion: 'libre', umbral: null, unidad: null, ambito: null }];
    const r = evaluarPedido([{ cod_articulo: 400, cantidad: 5, cod_lista: 12 }], c, conLinea);
    expect(r.avisos[0].lista_sugerida).toBe(12); // no 15: la regla del artículo tapa la del subrubro
  });
});

describe('evaluarPedido — condiciones de línea surtida', () => {
  it('"30 unidades surtidas de la misma línea" suma los renglones de esa línea', () => {
    const c = cat('ganave');
    const reglas: ReglaLista[] = [
      { nombre: 'GANAVE', match_tipo: 'subrubro', match_valor: 'Ganave', cod_lista: 12, condicion: 'libre', umbral: null, unidad: null, ambito: null },
      { nombre: 'GANAVE', match_tipo: 'subrubro', match_valor: 'Ganave', cod_lista: 14, condicion: 'min', umbral: 30, unidad: 'bulto', ambito: 'linea' },
    ];
    const dos = [
      { cod_articulo: 1, cantidad: 20, cod_lista: 14 },
      { cod_articulo: 1, cantidad: 15, cod_lista: 14 },
    ];
    // 20 + 15 = 35 bultos de la línea -> llega a los 30.
    expect(evaluarPedido(dos, c, reglas).avisos[0].lista_sugerida).toBe(14);
    // Un solo renglón de 20 no llega.
    expect(evaluarPedido([dos[0]], c, reglas).avisos[0].lista_sugerida).toBe(12);
  });
});

describe('LIBRE habilita pero no obliga (control cruzado 26/08 contra 1.052 facturas reales)', () => {
  // Rosco tiene L2 y L3 en LIBRE. El motor marcaba como error cada renglon que no usara
  // la mejor lista disponible: 88% de los renglones de Rosco facturados daban "aviso".
  const reglasLibre: ReglaLista[] = [
    { nombre: 'LINEA ROSCO', match_tipo: 'subrubro', match_valor: 'Rosco', cod_lista: 12, condicion: 'libre', umbral: null, unidad: null, ambito: null },
    { nombre: 'LINEA ROSCO', match_tipo: 'subrubro', match_valor: 'Rosco', cod_lista: 13, condicion: 'libre', umbral: null, unidad: null, ambito: null },
    { nombre: 'LINEA ROSCO', match_tipo: 'subrubro', match_valor: 'Rosco', cod_lista: 14, condicion: 'libre', umbral: null, unidad: null, ambito: null },
  ];
  const rosco = clasificarArticulo({ cod_articulo: 170, descripcion: 'ROSCO GATO PESCADO x 10 KG', subrubro: 'Rosco', unidad_de_medida: 'Bolsas', equivalencia_um: 10 });
  const c = new Map([[170, rosco]]);

  it('vender en L1 una línea LIBRE hasta L3 NO es un error: es decisión del vendedor', () => {
    const r = evaluarPedido([{ cod_articulo: 170, cantidad: 1, cod_lista: 12 }], c, reglasLibre);
    expect(r.avisos[0].severidad).toBe('ok');
    expect(r.avisos[0].mensaje).toBeNull();
  });

  it('pero pasarse del techo SÍ es error de margen', () => {
    const r = evaluarPedido([{ cod_articulo: 170, cantidad: 1, cod_lista: 15 }], c, reglasLibre);
    expect(r.avisos[0].severidad).toBe('margen');
    expect(r.avisos[0].lista_sugerida).toBe(14);
  });

  it('una condición POR CANTIDAD sí genera derecho: no dárselo es cobrarle de más', () => {
    // 20 kg de alpiste habilitan L2 por cantidad (no por LIBRE), y quedarse en L1 es error.
    const ca = cat('alpiste');
    const r = evaluarPedido([{ cod_articulo: 400, cantidad: 20, cod_lista: 12 }], ca, REGLAS);
    expect(r.avisos[0].severidad).toBe('cliente');
    expect(r.avisos[0].lista_sugerida).toBe(13);
  });

  it('el techo de LIBRE convive con el derecho por cantidad en el mismo renglón', () => {
    // Ganave: L1 libre + L2 por promo general. Con 10 bultos hay derecho a L2.
    const cg = cat('ganave');
    expect(evaluarPedido([{ cod_articulo: 1, cantidad: 10, cod_lista: 12 }], cg, REGLAS).avisos[0].severidad).toBe('cliente');
    // Con 1 bulto no hay promo: L1 es el techo, poner L2 es perder margen.
    expect(evaluarPedido([{ cod_articulo: 1, cantidad: 1, cod_lista: 13 }], cg, REGLAS).avisos[0].severidad).toBe('margen');
  });
});
