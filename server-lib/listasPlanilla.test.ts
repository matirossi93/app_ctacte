import { describe, it, expect } from 'vitest';
import { evaluarPedido, clasificarArticulo, type ReglaLista, type ArticuloInfo } from './listas.js';

/**
 * Las condiciones que agregó la planilla corregida del 08/09/2026 (Mati la revisó fila por
 * fila y respondió las dudas de notación). Lo que se testea acá es la traducción:
 *
 *   "BOLSA"      -> bulto_cerrado           : alcanza con llevarse la bolsa cerrada
 *   "BOLS +10%"  -> bulto_cerrado OPCIONAL  : habilita la lista, pero NO es un derecho
 *   "10+1"       -> min 11 (bonificacion)   : Mati: "tiene que convertirse en lista 2 con 11
 *                                             unidades, que es el equivalente"
 *   "- 5 UDS"    -> max 5 INCLUSIVE         : Mati: "ese es el precio hasta 5 uds"
 *   "30 UDS"     -> ambito linea            : Mati: "es sumando la linea"
 */

// Los artículos salen del catálogo REAL de IM (equivalencia_um incluida): sin ella el
// clasificador los toma por granel y ninguna condición por bulto se cumple nunca.
const art = (cod: number, descripcion: string, subrubro: string, equivalencia_um = 0, unidad_de_medida: string | null = null): ArticuloInfo =>
  clasificarArticulo({ cod_articulo: cod, descripcion, subrubro, equivalencia_um, unidad_de_medida });

const catalogo = new Map<number, ArticuloInfo>([
  [1, art(1, 'ALPISTE X 20 KG', 'Alpiste', 20, 'Bolsas')],
  [2, art(2, 'ALPISTE', 'Alpiste', 1, 'Kilos')],                                   // granel: cod 400 en IM
  [3, art(3, 'PIEDRAS SANITARIAS MI NINO 12,5', 'Accesorios Perros y Gatos', 12.5)], // cod 995
  [4, art(4, 'AVENA INSTANTANEA X 10 UD', 'Cereales para desayuno', 10)],
  [5, art(5, 'GRANOLA X 10 UD', 'Cereales para desayuno', 10)],
]);

const R = (o: Partial<ReglaLista> & { cod_lista: number; condicion: any }): ReglaLista => ({
  nombre: 'X', match_tipo: 'subrubro', match_valor: 'Alpiste',
  umbral: null, unidad: null, ambito: null, ...o,
} as ReglaLista);

describe('"BOLSA" — la bolsa cerrada habilita la lista', () => {
  const reglas = [
    R({ cod_lista: 12, condicion: 'libre' }),
    R({ cod_lista: 13, condicion: 'bulto_cerrado' }),
  ];

  it('🔴 llevarse la bolsa cerrada da derecho a L2, sin mirar los kilos', () => {
    // Antes esto era "min 20 kg", que dejaba afuera las bolsas de 25 y 30 kg.
    const r = evaluarPedido([{ cod_articulo: 1, cantidad: 1, cod_lista: 13 }], catalogo, reglas);
    expect(r.avisos[0].severidad).toBe('ok');
  });

  it('🔴 y si la vende en L1 teniendo la bolsa, le está cobrando de más', () => {
    const r = evaluarPedido([{ cod_articulo: 1, cantidad: 1, cod_lista: 12 }], catalogo, reglas);
    expect(r.avisos[0].severidad).toBe('cliente');
    expect(r.avisos[0].lista_sugerida).toBe(13);
  });

  it('unos kilos sueltos no son una bolsa', () => {
    const r = evaluarPedido([{ cod_articulo: 2, cantidad: 5, cod_lista: 13 }], catalogo, reglas);
    expect(r.avisos[0].severidad).toBe('margen');
  });

  it('🔴 pero el producto que se despacha A GRANEL igual llega a la bolsa por kilos', () => {
    // 🪤 En IM, Legumbres y Mezclas están cargados por kilo (unidad "Kilos", equivalencia 1):
    // ninguno es "bulto". Exigir es_bulto hacía que la condición no se cumpliera nunca y
    // marcaba 692 renglones reales como si vendieran por debajo de la lista.
    const r = evaluarPedido([{ cod_articulo: 2, cantidad: 25, cod_lista: 13 }], catalogo, reglas);
    expect(r.avisos[0].severidad).toBe('ok');
  });
});

describe('"BOLS +10%" — habilita L3 pero no es un derecho del cliente', () => {
  // 🪤 Este es el bug que reportó la auditoría en MEZCLAS: L2 y L3 con la MISMA condición
  // hacían que L2 fuera inalcanzable y que todo pedido disparara "le estás cobrando de más"
  // (110 casos en 4 semanas). El 10% extra es una decisión del vendedor, no algo exigible.
  const reglas = [
    R({ cod_lista: 12, condicion: 'libre' }),
    R({ cod_lista: 13, condicion: 'bulto_cerrado' }),
    R({ cod_lista: 14, condicion: 'bulto_cerrado', opcional: true }),
  ];

  it('🔴 vender en L2 con la bolsa NO es un error, aunque L3 esté habilitada', () => {
    const r = evaluarPedido([{ cod_articulo: 1, cantidad: 1, cod_lista: 13 }], catalogo, reglas);
    expect(r.avisos[0].severidad).toBe('ok');
  });

  it('vender en L3 con la bolsa tampoco lo es: está habilitada', () => {
    const r = evaluarPedido([{ cod_articulo: 1, cantidad: 1, cod_lista: 14 }], catalogo, reglas);
    expect(r.avisos[0].severidad).toBe('ok');
  });

  it('🔴 sin la bolsa, L3 sigue estando fuera de alcance', () => {
    const r = evaluarPedido([{ cod_articulo: 2, cantidad: 3, cod_lista: 14 }], catalogo, reglas);
    expect(r.avisos[0].severidad).toBe('margen');
  });
});

describe('"10+1" — se carga como 11 unidades en la lista 2', () => {
  const reglas = [
    R({ nombre: 'PIEDRAS SANITARIAS', match_valor: 'Accesorios Perros y Gatos', cod_lista: 12, condicion: 'libre' }),
    R({ nombre: 'PIEDRAS SANITARIAS', match_valor: 'Accesorios Perros y Gatos', cod_lista: 13,
        condicion: 'min', umbral: 6, unidad: 'bulto', ambito: 'linea', bonificacion: '5+1' }),
  ];

  it('🔴 con 6 unidades (5+1) le corresponde L2', () => {
    const r = evaluarPedido([{ cod_articulo: 3, cantidad: 6, cod_lista: 13 }], catalogo, reglas);
    expect(r.avisos[0].severidad).toBe('ok');
  });

  it('🔴 con 5 todavía no llega', () => {
    const r = evaluarPedido([{ cod_articulo: 3, cantidad: 5, cod_lista: 13 }], catalogo, reglas);
    expect(r.avisos[0].severidad).toBe('margen');
  });

  it('🔴 el renglón bonificado a precio 0 avisa CÓMO se carga, y no como un descuento ilegal', () => {
    // Así lo cargan hoy: 5 pagadas en L1 + 1 a precio cero. Son 207 casos en 4 semanas.
    const r = evaluarPedido([
      { cod_articulo: 3, cantidad: 5, cod_lista: 12 },
      { cod_articulo: 3, cantidad: 1, cod_lista: 12, descuento: 100 },
    ], catalogo, reglas);
    const bonif = r.avisos[1];
    expect(bonif.mensaje_bonificacion).toMatch(/5\+1/);
    expect(bonif.mensaje_bonificacion).toMatch(/6 unidades/);
    expect(bonif.mensaje_bonificacion).toMatch(/L2/);
    // Y NO se lo trata como "se pasó del tope de descuento": es otra cosa.
    expect(bonif.mensaje_descuento).toBeNull();
  });
});

describe('"- 5 UDS" — hasta 5 unidades, el 5 incluido', () => {
  const reglas = [
    R({ nombre: 'CEREALES', match_valor: 'Cereales para desayuno', cod_lista: 12, condicion: 'libre' }),
    R({ nombre: 'CEREALES', match_valor: 'Cereales para desayuno', cod_lista: 13, condicion: 'max', umbral: 5, unidad: 'bulto', ambito: 'linea' }),
    R({ nombre: 'CEREALES', match_valor: 'Cereales para desayuno', cod_lista: 14, condicion: 'min', umbral: 5, unidad: 'bulto', ambito: 'linea' }),
  ];

  it('🔴 con 5 exactas todavía entra en L2 ("hasta 5")', () => {
    const r = evaluarPedido([{ cod_articulo: 4, cantidad: 5, cod_lista: 13 }], catalogo, reglas);
    expect(r.avisos[0].severidad).not.toBe('margen');
  });

  it('con 6 ya no: ahí le toca L3', () => {
    const r = evaluarPedido([{ cod_articulo: 4, cantidad: 6, cod_lista: 13 }], catalogo, reglas);
    expect(r.avisos[0].lista_sugerida).toBe(14);
  });
});

describe('los umbrales se cuentan sumando la línea', () => {
  // Mati, 08/09: "es sumando la linea". En Flecky esto mueve el cumplimiento del 4% al 10%.
  const reglas = [
    R({ nombre: 'CEREALES', match_valor: 'Cereales para desayuno', cod_lista: 12, condicion: 'libre' }),
    R({ nombre: 'CEREALES', match_valor: 'Cereales para desayuno', cod_lista: 14, condicion: 'min', umbral: 10, unidad: 'bulto', ambito: 'linea' }),
  ];

  it('🔴 dos productos distintos de la misma línea suman para el umbral', () => {
    const r = evaluarPedido([
      { cod_articulo: 4, cantidad: 6, cod_lista: 14 },
      { cod_articulo: 5, cantidad: 4, cod_lista: 14 },
    ], catalogo, reglas);
    expect(r.avisos.every(a => a.severidad === 'ok')).toBe(true);
  });
});
