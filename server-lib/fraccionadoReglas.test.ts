import { describe, it, expect } from 'vitest';
import { paquetesDelRenglon, seFracciona } from './fraccionado.js';

/**
 * Cómo se parte cada renglón en paquetes. Mati (09/09/2026):
 *
 *  · Las mezclas vienen en **bolsa de 30 kg** y lo máximo que se fracciona son **10 kg**.
 *  · *"Si dice 60 kilos, no son 60 kilos fraccionados, son 2 bolsas de 30"*. Si la cantidad es
 *    múltiplo de la bolsa, no se fracciona nada: se entregan bolsas cerradas.
 *  · *"Todo lo que no coincida con el equivalente a la bolsa se fracciona en 10 kilos o menos"*.
 *
 * Sin esto el listado mandaba a fraccionar 60 kg sueltos donde el sector sólo tiene que agarrar
 * dos bolsas del depósito.
 *
 * 🔄 16/09/2026: lo que PASA la bolsa ya no fracciona el renglón entero. Mati, sobre los kilos
 * que exceden: *"veníamos facturando esos kg extra fraccionados"*. Antes, 50 kg con bolsa de 30
 * salían como cinco paquetes de 10; ahora son una bolsa cerrada y 20 kg a pesar. Medido sobre 16
 * días de pedidos, eran 86 renglones de trabajo de más.
 */
describe('en cuántos paquetes se parte un renglón', () => {
  it('🔑 múltiplo de la bolsa: NO se fracciona (60 kg = 2 bolsas de 30)', () => {
    expect(paquetesDelRenglon(60, 30)).toEqual({ fracciona: false, bolsas: 2, formato: 30 });
    expect(paquetesDelRenglon(90, 30)).toEqual({ fracciona: false, bolsas: 3, formato: 30 });
    expect(paquetesDelRenglon(30, 30)).toEqual({ fracciona: false, bolsas: 1, formato: 30 });
  });

  it('🔑 lo que PASA la bolsa: las cerradas se agarran y sólo el resto se pesa', () => {
    // 100 con bolsa de 30: tres cerradas y 10 kg a fraccionar.
    expect(paquetesDelRenglon(100, 30)).toEqual({ fracciona: true, paquetes: [10], bolsas: 3, formato: 30 });
    // 50 con bolsa de 30: una cerrada y 20 kg, que van de a 10.
    expect(paquetesDelRenglon(50, 30)).toEqual({ fracciona: true, paquetes: [10, 10], bolsas: 1, formato: 30 });
  });

  it('🔑 el resto va en su propio paquete: 15 kg = uno de 10 y uno de 5', () => {
    expect((paquetesDelRenglon(15, 30) as any).paquetes).toEqual([10, 5]);
    expect((paquetesDelRenglon(7, 30) as any).paquetes).toEqual([7]);
    expect((paquetesDelRenglon(25, 30) as any).paquetes).toEqual([10, 10, 5]);
  });

  it('🪤 con decimales no aparecen paquetes fantasma de 0,0000001', () => {
    // 30,5 en punto flotante no es exacto y esto se pesa en una balanza.
    expect(paquetesDelRenglon(30.5, 30)).toEqual({ fracciona: true, paquetes: [0.5], bolsas: 1, formato: 30 });
    expect((paquetesDelRenglon(20.1, 30) as any).paquetes).toEqual([10, 10, 0.1]);
  });

  it('🔄 sin formato ya NO se parte en 10: eso inventaba trabajo (cambió el 18/09/2026)', () => {
    // Hasta hoy decía [10,10,10,10,5]: el tope de 10 kg se aplicaba igual sin saber la bolsa.
    // Con el sorgo se vio el costo —bolsa de 40 partida en cuatro— y ahora la cantidad va como
    // vino. Ver el describe del final: el kilaje se carga desde la pantalla.
    expect(paquetesDelRenglon(45, null)).toEqual({ fracciona: true, paquetes: [45], sin_formato: true });
  });

  it('una bolsa de otro formato también se respeta: 50 kg de lenteja son 2 bolsas de 25', () => {
    expect(paquetesDelRenglon(50, 25)).toEqual({ fracciona: false, bolsas: 2, formato: 25 });
  });

  it('menos que una bolsa se fracciona', () => {
    expect((paquetesDelRenglon(10, 30) as any).paquetes).toEqual([10]);
    expect((paquetesDelRenglon(3, 30) as any).paquetes).toEqual([3]);
  });
});

describe('qué productos entran al listado', () => {
  /**
   * 🔴 Mati (09/09/2026): *"la mezcla gallo premium no está saliendo en el listado, a pesar de
   * que sí está pedida"*. El artículo 491 tiene `unidad_de_medida` VACÍO en InfoManager —las
   * otras mezclas dicen "Kilos" o "KG"— y el filtro miraba sólo ese campo.
   */
  it('🔴 MEZCLA GALLO PREMIUM entra aunque IM no le haya cargado la unidad', () => {
    expect(seFracciona({ descripcion: 'MEZCLA GALLO PREMIUM', unidad_de_medida: '', equivalencia_um: 1 })).toBe(true);
  });

  it('lo que ya viene en bolsa cerrada NO se fracciona', () => {
    expect(seFracciona({ descripcion: 'ALPISTE X 30 KG', unidad_de_medida: 'Bolsas', equivalencia_um: 30 })).toBe(false);
  });

  it('las mezclas con la unidad bien cargada siguen entrando', () => {
    expect(seFracciona({ descripcion: 'MEZCLA FINA ESPECIAL', unidad_de_medida: 'KG', equivalencia_um: 1 })).toBe(true);
    expect(seFracciona({ descripcion: 'MEZCLA GRUESA/MEDIANA', unidad_de_medida: 'Kilos', equivalencia_um: 1 })).toBe(true);
  });

  it('🪤 un COMEDERO no se fracciona, aunque tampoco sea un bulto', () => {
    // Se vende por unidad. Con `equivalencia_um: 0` y sin unidad, no hay nada que fraccionar.
    expect(seFracciona({ descripcion: 'COMEDERO PARA GALLO', unidad_de_medida: '', equivalencia_um: 0 })).toBe(false);
    expect(seFracciona({ descripcion: 'COLLAR ANTIPULGAS', unidad_de_medida: '', equivalencia_um: 0 })).toBe(false);
  });

  it('un producto con formato de bolsa conocido entra, aunque IM no diga nada', () => {
    expect(seFracciona({ descripcion: 'MEZCLA GALLO SAN JUAN', unidad_de_medida: '', equivalencia_um: 0 }, 30)).toBe(true);
  });
});

/**
 * 🔴 18/09/2026. SIN KILAJE DE BOLSA NO SE INVENTA NADA.
 *
 * Mati (17/09/2026): *"el sorgo no se está contemplando la bolsa... quizás acá sea mejor que
 * directamente se ponga las cantidades textual como está en el pedido"*, y sobre por qué no
 * alcanza con cargarlos una vez: *"van cambiando los kilajes de las bolsas, no son siempre
 * iguales"*.
 *
 * Un producto sin formato se partía igual en paquetes de 10 kg. Eso no es "no sé": es afirmar
 * que hay que abrir la bolsa y pesar cuatro paquetes, y con el sorgo —bolsa de 40— era trabajo
 * inventado sobre mercadería que ya venía preparada. Sin el dato, la cantidad va como vino y la
 * pantalla pide que le carguen el kilaje.
 */
describe('sin formato de bolsa cargado', () => {
  it('🔴 no se parte en paquetes de 10: va la cantidad tal cual, marcada', () => {
    expect(paquetesDelRenglon(40, null)).toEqual({ fracciona: true, paquetes: [40], sin_formato: true });
    expect(paquetesDelRenglon(100, null)).toEqual({ fracciona: true, paquetes: [100], sin_formato: true });
  });

  it('una cantidad chica tampoco cambia: 7 kg sigue siendo un paquete de 7', () => {
    expect(paquetesDelRenglon(7, null)).toEqual({ fracciona: true, paquetes: [7], sin_formato: true });
  });

  it('🔑 con el kilaje cargado vuelve la regla de siempre', () => {
    // Es el caso del sorgo: cargarle 40 lo convierte en una bolsa cerrada, no en 4 paquetes.
    expect(paquetesDelRenglon(40, 40)).toEqual({ fracciona: false, bolsas: 1, formato: 40 });
  });
});
