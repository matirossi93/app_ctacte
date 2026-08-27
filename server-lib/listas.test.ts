import { describe, it, expect } from 'vitest';
import {
  clasificarArticulo, bultosDelPedido, evaluarPedido,
  type ArticuloInfo, type ReglaLista, type ReglaDescuento,
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

  it('con 10 bultos entra y Ganave puede ir en L2 sin que sea error', () => {
    const r = evaluarPedido([{ cod_articulo: 1, cantidad: 10, cod_lista: 13 }], c, REGLAS);
    expect(r.promo_general).toBe(true);
    expect(r.avisos[0].severidad).toBe('ok');
  });

  it('🔑 la promo general HABILITA pero no obliga: quedarse en L1 con 10 bultos no es error', () => {
    // Mati 26/08: "es opcional, lo carga el vendedor". El contador del carrito le avisa
    // que esta disponible; marcarlo como error seria un falso positivo (491 renglones
    // de las facturas reales caian en este caso).
    const r = evaluarPedido([{ cod_articulo: 1, cantidad: 10, cod_lista: 12 }], c, REGLAS);
    expect(r.promo_general).toBe(true);
    expect(r.avisos[0].severidad).toBe('ok');
    expect(r.avisos[0].mensaje).toBeNull();
  });

  it('el ejemplo del audio completo: 9 de Gran Campeón + 20 kg de alpiste llegan a 10 bultos y todo el pedido puede ir hasta L3', () => {
    const r = evaluarPedido([
      { cod_articulo: 140, cantidad: 9, cod_lista: 14 },
      { cod_articulo: 400, cantidad: 20, cod_lista: 14 },
    ], c, REGLAS);
    expect(r.bultos).toBe(10);
    expect(r.promo_general).toBe(true);
    // Gran Campeón L3 libre; alpiste L3 por la promo. Ninguno es error.
    expect(r.avisos.every(a => a.severidad === 'ok')).toBe(true);
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

  it('el techo sube con la promo pero el derecho no', () => {
    const cg = cat('ganave');
    // Con 10 bultos la promo habilita L2: usarla o no, las dos cosas estan bien.
    expect(evaluarPedido([{ cod_articulo: 1, cantidad: 10, cod_lista: 12 }], cg, REGLAS).avisos[0].severidad).toBe('ok');
    expect(evaluarPedido([{ cod_articulo: 1, cantidad: 10, cod_lista: 13 }], cg, REGLAS).avisos[0].severidad).toBe('ok');
    // Con 1 bulto no hay promo: L1 es el techo, poner L2 es perder margen.
    expect(evaluarPedido([{ cod_articulo: 1, cantidad: 1, cod_lista: 13 }], cg, REGLAS).avisos[0].severidad).toBe('margen');
  });
});

describe('artículos excluidos del circuito', () => {
  // Mati 26/08: FORRAJES VARIOS se usa para facturar a consumidor final. Es el articulo
  // MAS facturado de Casa Central, y su subrubro ("Varios") algun dia puede tener regla.
  const forrajes = clasificarArticulo({ cod_articulo: 13818, descripcion: 'FORRAJES VARIOS', subrubro: 'Varios', unidad_de_medida: null, equivalencia_um: 0 });
  const reglas: ReglaLista[] = [
    { nombre: 'FORRAJES VARIOS', match_tipo: 'articulo', match_valor: '13818', cod_lista: 12, condicion: 'excluido', umbral: null, unidad: null, ambito: null },
    { nombre: 'VARIOS', match_tipo: 'subrubro', match_valor: 'Varios', cod_lista: 14, condicion: 'libre', umbral: null, unidad: null, ambito: null },
  ];

  it('no se controla aunque su subrubro tenga regla', () => {
    const r = evaluarPedido([{ cod_articulo: 13818, cantidad: 5, cod_lista: 12 }], new Map([[13818, forrajes]]), reglas);
    expect(r.avisos[0].severidad).toBe('sin_regla');
    expect(r.avisos[0].mensaje).toBeNull();
  });
});

describe('polenta y harina de maíz salen por código, no por subrubro', () => {
  // En IM viven en el subrubro "Legumbres", pero la planilla los saca de ahi
  // ("LEGUMBRES salvo polenta y harina de trigo") y les da su propia condicion.
  // Mati 26/08: "a partir de 10 kg recien le pueden hacer lista 2".
  const polenta = clasificarArticulo({ cod_articulo: 722, descripcion: 'POLENTA', subrubro: 'Legumbres', unidad_de_medida: 'Kilos', equivalencia_um: 1 });
  const c = new Map([[722, polenta]]);
  const reglas: ReglaLista[] = [
    { nombre: 'LEGUMBRES', match_tipo: 'subrubro', match_valor: 'Legumbres', cod_lista: 12, condicion: 'max', umbral: 20, unidad: 'kg', ambito: 'articulo' },
    { nombre: 'LEGUMBRES', match_tipo: 'subrubro', match_valor: 'Legumbres', cod_lista: 13, condicion: 'min', umbral: 20, unidad: 'kg', ambito: 'articulo' },
    { nombre: 'POLENTA Y HARINA DE MAIZ', match_tipo: 'articulo', match_valor: '722', cod_lista: 12, condicion: 'max', umbral: 10, unidad: 'kg', ambito: 'articulo' },
    { nombre: 'POLENTA Y HARINA DE MAIZ', match_tipo: 'articulo', match_valor: '722', cod_lista: 13, condicion: 'min', umbral: 10, unidad: 'kg', ambito: 'articulo' },
  ];

  it('con 12 kg llega a L2 por su regla propia (con la de Legumbres harían falta 20)', () => {
    const r = evaluarPedido([{ cod_articulo: 722, cantidad: 12, cod_lista: 12 }], c, reglas);
    expect(r.avisos[0].severidad).toBe('cliente');
    expect(r.avisos[0].lista_sugerida).toBe(13);
  });

  it('con 8 kg se queda en L1, y ponerlo en L2 es perder margen', () => {
    expect(evaluarPedido([{ cod_articulo: 722, cantidad: 8, cod_lista: 12 }], c, reglas).avisos[0].severidad).toBe('ok');
    expect(evaluarPedido([{ cod_articulo: 722, cantidad: 8, cod_lista: 13 }], c, reglas).avisos[0].severidad).toBe('margen');
  });

  it('el techo es L2: no existe L3 para polenta', () => {
    const r = evaluarPedido([{ cod_articulo: 722, cantidad: 50, cod_lista: 14 }], c, reglas);
    expect(r.avisos[0].severidad).toBe('margen');
    expect(r.avisos[0].lista_sugerida).toBe(13);
  });
});

describe('🪤 una línea partida en varios subrubros de IM acumula junta (auditoría 27/08)', () => {
  // En IM la línea Tiernito vive en DOS subrubros: "Tiernitos" (perro, 15/21 kg) y
  // "Tiernito" (gato, 10 kg). Acumular por subrubro hacía que 3+2 contaran 3 y 2, la
  // condición "5 de la misma línea" no se cumpliera nunca, y el motor BLOQUEARA una
  // venta legítima diciendo "estás vendiendo más barato". Mismo caso con Zimpi/Zimpy.
  const perro = clasificarArticulo({ cod_articulo: 111, descripcion: 'TIERNITO CARNE  x 21 KG', subrubro: 'Tiernitos', unidad_de_medida: 'Bolsas', equivalencia_um: 21 });
  const gato = clasificarArticulo({ cod_articulo: 119, descripcion: 'TIERNITO GATITO X 10KG', subrubro: 'Tiernito', unidad_de_medida: 'Bolsas', equivalencia_um: 10 });
  const c = new Map([[111, perro], [119, gato]]);
  // Las dos filas del seed se llaman igual: ese nombre es la línea comercial.
  const reglas: ReglaLista[] = ['Tiernitos', 'Tiernito'].flatMap((sub) => ([
    { nombre: 'LINEA TIERNITO', match_tipo: 'subrubro' as const, match_valor: sub, cod_lista: 12, condicion: 'libre' as const, umbral: null, unidad: null, ambito: null },
    { nombre: 'LINEA TIERNITO', match_tipo: 'subrubro' as const, match_valor: sub, cod_lista: 14, condicion: 'min' as const, umbral: 5, unidad: 'bulto' as const, ambito: 'linea' as const },
  ]));

  it('3 bolsas de perro + 2 de gato son 5 de la misma línea: L3 vale y no se bloquea', () => {
    const r = evaluarPedido([
      { cod_articulo: 111, cantidad: 3, cod_lista: 14 },
      { cod_articulo: 119, cantidad: 2, cod_lista: 14 },
    ], c, reglas);
    expect(r.avisos.every(a => a.severidad === 'ok')).toBe(true);
  });

  it('con 4 en total todavía no llega y ahí sí avisa', () => {
    const r = evaluarPedido([
      { cod_articulo: 111, cantidad: 2, cod_lista: 14 },
      { cod_articulo: 119, cantidad: 2, cod_lista: 14 },
    ], c, reglas);
    expect(r.avisos.every(a => a.severidad === 'margen')).toBe(true);
  });
});

describe('control de descuentos (reglas de Mati del 27/08)', () => {
  // 25% desde 1 · 30% desde 5 · 35% desde 10 · 40% desde 30, contando el SURTIDO de la
  // línea, y ÚNICAMENTE en Lista 1. Los porcentajes son topes.
  const CEREALES: ReglaDescuento[] = [
    { nombre: 'CEREALES PARA DESAYUNO', match_tipo: 'subrubro', match_valor: 'Cereales para desayuno', desde_cantidad: 1, ambito: 'linea', porcentaje_max: 25, requiere_lista: 12, requiere_mejor_lista: false, aviso: null },
    { nombre: 'CEREALES PARA DESAYUNO', match_tipo: 'subrubro', match_valor: 'Cereales para desayuno', desde_cantidad: 5, ambito: 'linea', porcentaje_max: 30, requiere_lista: 12, requiere_mejor_lista: false, aviso: null },
    { nombre: 'CEREALES PARA DESAYUNO', match_tipo: 'subrubro', match_valor: 'Cereales para desayuno', desde_cantidad: 10, ambito: 'linea', porcentaje_max: 35, requiere_lista: 12, requiere_mejor_lista: false, aviso: null },
    { nombre: 'CEREALES PARA DESAYUNO', match_tipo: 'subrubro', match_valor: 'Cereales para desayuno', desde_cantidad: 30, ambito: 'linea', porcentaje_max: 40, requiere_lista: 12, requiere_mejor_lista: false, aviso: null },
    // 2% para Gran Campeón, sólo sobre la mejor lista y sólo contado.
    { nombre: 'LINEA GRAN CAMPEON', match_tipo: 'subrubro', match_valor: 'Gran Campeon', desde_cantidad: 1, ambito: 'articulo', porcentaje_max: 2, requiere_lista: null, requiere_mejor_lista: true, aviso: 'Este 2% sólo vale si el pedido se paga de contado.' },
  ];
  const anillos = clasificarArticulo({ cod_articulo: 311, descripcion: 'ANILLOS FRUTADOS x 2.5 Kg', subrubro: 'Cereales para desayuno', unidad_de_medida: 'Bolsas', equivalencia_um: 2.5 });
  const almoh = clasificarArticulo({ cod_articulo: 301, descripcion: 'ALMOHADITA DE FRUTILLA X 2.5 KG', subrubro: 'Cereales para desayuno', unidad_de_medida: 'Bolsas', equivalencia_um: 2.5 });
  const c = new Map([[311, anillos], [301, almoh], [140, clasificarArticulo(CRUDO.granCampeon)]]);
  const av = (items: any[]) => evaluarPedido(items, c, REGLAS, CEREALES).avisos;

  it('1 unidad en L1 admite hasta 25%', () => {
    expect(av([{ cod_articulo: 311, cantidad: 1, cod_lista: 12, descuento: 25 }])[0].mensaje_descuento).toBeNull();
    const p = av([{ cod_articulo: 311, cantidad: 1, cod_lista: 12, descuento: 30 }])[0];
    expect(p.descuento_max).toBe(25);
    expect(p.mensaje_descuento).toContain('máximo para esta cantidad es 25%');
  });

  it('🔑 los escalones cuentan el SURTIDO de la línea: 2 anillos + 3 almohaditas = 5 → 30%', () => {
    const r = av([
      { cod_articulo: 311, cantidad: 2, cod_lista: 12, descuento: 30 },
      { cod_articulo: 301, cantidad: 3, cod_lista: 12, descuento: 30 },
    ]);
    expect(r.every(a => a.mensaje_descuento === null)).toBe(true);
    expect(r[0].descuento_max).toBe(30);
  });

  it('poner menos del tope está bien (son topes, no valores exactos)', () => {
    expect(av([{ cod_articulo: 311, cantidad: 10, cod_lista: 12, descuento: 12 }])[0].mensaje_descuento).toBeNull();
  });

  it('30 unidades llegan al 40%', () => {
    expect(av([{ cod_articulo: 311, cantidad: 30, cod_lista: 12, descuento: 40 }])[0].descuento_max).toBe(40);
  });

  it('🔑 el descuento de cereales NO vale fuera de Lista 1', () => {
    const p = av([{ cod_articulo: 311, cantidad: 10, cod_lista: 13, descuento: 35 }])[0];
    expect(p.descuento_max).toBe(0);
    expect(p.mensaje_descuento).toContain('sólo se puede aplicar en L1');
  });

  it('un artículo sin reglas no tiene descuentos habilitados', () => {
    const ca = cat('ganave');
    const p = evaluarPedido([{ cod_articulo: 1, cantidad: 5, cod_lista: 12, descuento: 5 }], ca, REGLAS, CEREALES).avisos[0];
    expect(p.descuento_max).toBe(0);
    expect(p.mensaje_descuento).toContain('no tiene descuentos habilitados');
  });

  it('sin descuento puesto no molesta a nadie', () => {
    const ca = cat('ganave');
    const p = evaluarPedido([{ cod_articulo: 1, cantidad: 5, cod_lista: 12 }], ca, REGLAS, CEREALES).avisos[0];
    expect(p.descuento).toBe(0);
    expect(p.mensaje_descuento).toBeNull();
    expect(p.nota_descuento).toBeNull();
  });

  it('🔑 el 2% de Gran Campeón sólo vale sobre la mejor lista, y avisa lo del contado', () => {
    // L3 es su techo (L2 y L3 están LIBRE): ahí el 2% vale.
    const ok = av([{ cod_articulo: 140, cantidad: 1, cod_lista: 14, descuento: 2 }])[0];
    expect(ok.descuento_max).toBe(2);
    expect(ok.mensaje_descuento).toBeNull();
    expect(ok.nota_descuento).toContain('contado');
    // En L1 no está en su mejor lista: el 2% no corresponde.
    const mal = av([{ cod_articulo: 140, cantidad: 1, cod_lista: 12, descuento: 2 }])[0];
    expect(mal.descuento_max).toBe(0);
    expect(mal.mensaje_descuento).toContain('mejor precio');
  });

  it('el aviso de contado no aparece si no se usó descuento', () => {
    expect(av([{ cod_articulo: 140, cantidad: 1, cod_lista: 14 }])[0].nota_descuento).toBeNull();
  });
});
