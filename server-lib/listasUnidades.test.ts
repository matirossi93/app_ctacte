import { describe, it, expect } from 'vitest';
import { evaluarPedido, clasificarArticulo, type ReglaLista, type ArticuloInfo } from './listas.js';

/**
 * La planilla mide con tres varas distintas y no son intercambiables:
 *   "30 unidades del mismo producto" -> unidades vendidas
 *   "a partir de 50 bolsas"          -> bultos (los pallets de piedras sanitarias)
 *   "a partir de 20 kilos"           -> kilos
 *
 * 🪤 Antes las tres se contaban como bultos, y un artículo que IM no reconoce como bolsa
 * (unidad de medida vacía, equivalencia 0 — así vienen los accesorios, las pipetas y los
 * shampoos) nunca suma un bulto: el umbral en unidades no se cumplía jamás.
 */
const R = (o: Partial<ReglaLista> & { cod_lista: number; condicion: any }): ReglaLista =>
  ({ nombre: 'X', match_tipo: 'subrubro', match_valor: 'Accesorios Perros y Gatos', umbral: null, unidad: null, ambito: null, ...o } as ReglaLista);

// Del catálogo real: un collar, que se vende por unidad y no tiene presentación en kilos.
// (Ojo con elegir el ejemplo: "ARENA SANITARIA VITAL FUN X 6K" SÍ es una bolsa de 6 kg y el
// clasificador la reconoce bien por el "X 6K" de la descripción.)
const suelto: ArticuloInfo = clasificarArticulo({
  cod_articulo: 921, descripcion: 'COLLAR ANTIPULGAS CHICO',
  subrubro: 'Accesorios Perros y Gatos', equivalencia_um: 0, unidad_de_medida: null,
});
const catalogo = new Map([[921, suelto]]);

describe('umbrales en unidades sobre artículos que IM no marca como bolsa', () => {
  const reglas = [
    R({ cod_lista: 12, condicion: 'libre' }),
    R({ cod_lista: 13, condicion: 'min', umbral: 5, unidad: 'unidad', ambito: 'articulo' }),
  ];

  it('🔴 5 unidades alcanzan la Lista 2', () => {
    // Con `unidad: 'bulto'` esto daba 0 bultos y la condición no se cumplía nunca.
    expect(suelto.es_bulto).toBe(false);
    const r = evaluarPedido([{ cod_articulo: 921, cantidad: 5, cod_lista: 13 }], catalogo, reglas);
    expect(r.avisos[0].severidad).toBe('ok');
  });

  it('con 4 todavía no', () => {
    const r = evaluarPedido([{ cod_articulo: 921, cantidad: 4, cod_lista: 13 }], catalogo, reglas);
    expect(r.avisos[0].severidad).toBe('margen');
  });

  it('🔴 y esas unidades NO cuentan como bultos para la promo general', () => {
    // La promo pide 10 bultos SURTIDOS: una arena de 6 kg suelta no es un bulto.
    const r = evaluarPedido([{ cod_articulo: 921, cantidad: 12, cod_lista: 13 }], catalogo, reglas);
    expect(r.bultos).toBe(0);
    expect(r.promo_general).toBe(false);
  });

  it('el umbral en bolsas sigue contando bolsas, no unidades', () => {
    const porBolsas = [R({ cod_lista: 12, condicion: 'libre' }),
                       R({ cod_lista: 13, condicion: 'min', umbral: 5, unidad: 'bulto', ambito: 'articulo' })];
    const r = evaluarPedido([{ cod_articulo: 921, cantidad: 5, cod_lista: 13 }], catalogo, porBolsas);
    expect(r.avisos[0].severidad).toBe('margen');
  });
});


describe('una lista alcanzable por dos caminos a la vez', () => {
  // Hoy la planilla no trae ninguna línea así, pero el índice único lo permite desde que se
  // amplió a (destino, lista, condicion). Si algún día una lista se habilita por la promo
  // general Y por una cantidad propia, el techo y el derecho tienen que seguir siendo cosas
  // distintas: la promo habilita, la cantidad obliga.
  const bolsa = clasificarArticulo({ cod_articulo: 400, descripcion: 'GANAVE X 20 KG', subrubro: 'Ganave', equivalencia_um: 20 });
  const cat = new Map([[400, bolsa]]);
  const reglas = [
    R({ match_valor: 'Ganave', cod_lista: 12, condicion: 'libre' }),
    R({ match_valor: 'Ganave', cod_lista: 13, condicion: 'min', umbral: 10, unidad: 'unidad', ambito: 'linea' }),
    R({ match_valor: 'Ganave', cod_lista: 13, condicion: 'promo_general', umbral: 10, unidad: 'bulto', ambito: 'pedido' }),
  ];

  it('🔴 si sólo entra por la promo general, L2 queda habilitada pero NO es un derecho', () => {
    // 10 bultos surtidos disparan la promo, pero no llegó a las 10 unidades de la línea.
    const r = evaluarPedido([
      { cod_articulo: 400, cantidad: 4, cod_lista: 12 },
      { cod_articulo: 401, cantidad: 6, cod_lista: 12 },
    ], new Map([...cat, [401, clasificarArticulo({ cod_articulo: 401, descripcion: 'OTRO X 20 KG', subrubro: 'Otro', equivalencia_um: 20 })]]), reglas);
    expect(r.promo_general).toBe(true);
    // Está en L1 pudiendo ir a L2: es decisión suya, no un error.
    expect(r.avisos[0].severidad).toBe('ok');
  });

  it('🔴 si llegó a la cantidad propia, L2 SÍ es un derecho y venderle en L1 le cobra de más', () => {
    const r = evaluarPedido([{ cod_articulo: 400, cantidad: 10, cod_lista: 12 }], cat, reglas);
    expect(r.avisos[0].severidad).toBe('cliente');
    expect(r.avisos[0].lista_sugerida).toBe(13);
  });
});
