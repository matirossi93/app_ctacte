import { describe, it, expect } from 'vitest';
import { buscarClientes, norm, TOPE_CLIENTES } from './buscarClientes';

/**
 * El 27/08/2026 Sebastián no encontraba clientes en el módulo de pedidos. La causa de fondo
 * eran dos bugs de datos (el lookup se leía del campo equivocado y el prop traía sólo
 * deudores), pero con el maestro entero cargado el buscador pasa a filtrar cientos de
 * clientes en vez de decenas, y ahí aparecen estos dos problemas propios.
 */

const c = (cod: string, name: string) => ({ cod, name });

describe('norm — acentos y Ñ', () => {
  it('saca tildes', () => {
    expect(norm('RODRÍGUEZ')).toBe('rodriguez');
    expect(norm('MARTÍNEZ S.A.')).toBe('martinez s.a.');
  });

  it('la Ñ queda como N: nadie tipea Ñ en el celular', () => {
    expect(norm('PEÑA')).toBe('pena');
  });

  it('recorta espacios de los costados', () => {
    expect(norm('  Almacén  ')).toBe('almacen');
  });
});

describe('buscarClientes — encontrar al cliente', () => {
  const lista = [
    c('101', 'ALMACEN DON JOSE'),
    c('102', 'PEÑA HERMANOS SRL'),
    c('103', 'RODRÍGUEZ Y CIA'),
    c('104', 'SUPERMERCADO LA ESQUINA'),
  ];

  it('buscar sin acentos encuentra al que sí los tiene', () => {
    expect(buscarClientes(lista, 'pena').resultados.map(x => x.cod)).toEqual(['102']);
    expect(buscarClientes(lista, 'rodriguez').resultados.map(x => x.cod)).toEqual(['103']);
  });

  it('busca por código', () => {
    expect(buscarClientes(lista, '103').resultados.map(x => x.cod)).toEqual(['103']);
  });

  it('busca por el medio del nombre, no sólo por el principio', () => {
    expect(buscarClientes(lista, 'esquina').resultados.map(x => x.cod)).toEqual(['104']);
  });

  it('sin búsqueda devuelve la lista tal cual, recortada al tope', () => {
    expect(buscarClientes(lista, '').resultados).toHaveLength(4);
    expect(buscarClientes(lista, '   ').deMas).toBe(0);
  });

  it('no encontrar nada no rompe', () => {
    expect(buscarClientes(lista, 'zzz')).toEqual({ resultados: [], deMas: 0 });
  });
});

describe('buscarClientes — el tope no puede tapar al que buscás', () => {
  // 🪤 El bug real: `filter().slice(0, 30)` cortaba por orden ALFABÉTICO. Con cientos de
  // clientes que contienen "sa" (SA, S.A., CASA, ROSARIO...), el que arranca con "SA"
  // quedaba afuera mientras se mostraban 30 peores.
  const muchos = Array.from({ length: 80 }, (_, i) =>
    c(String(200 + i), `AAA CASA ${String(i).padStart(2, '0')}`),
  );
  const elBuscado = c('999', 'SANCHEZ DISTRIBUCIONES');
  const lista = [...muchos, elBuscado];

  it('el que arranca con la búsqueda gana a los 80 que sólo la contienen', () => {
    const { resultados } = buscarClientes(lista, 'sa');
    expect(resultados[0].cod).toBe('999');
  });

  it('el código exacto va primero de todo', () => {
    const { resultados } = buscarClientes([...lista, c('sa', 'CLIENTE RARO')], 'sa');
    expect(resultados[0].name).toBe('CLIENTE RARO');
  });

  it('avisa cuántos quedaron afuera del tope', () => {
    const { resultados, deMas } = buscarClientes(lista, 'casa');
    expect(resultados).toHaveLength(TOPE_CLIENTES);
    expect(deMas).toBe(80 - TOPE_CLIENTES);
  });

  it('empate de puntaje se desempata alfabético', () => {
    const { resultados } = buscarClientes(
      [c('1', 'ZETA SRL'), c('2', 'ALFA SRL')], 'srl',
    );
    expect(resultados.map(x => x.name)).toEqual(['ALFA SRL', 'ZETA SRL']);
  });
});

describe('buscarClientes — los nombres reales son "APELLIDO, Nombre (Localidad)"', () => {
  // 🪤 Así están cargadas las razones sociales en InfoManager. Buscar la frase entera
  // ("bustos sebastian") no matchea nunca porque la coma está en el medio: el vendedor
  // tiene que acertar apellido O nombre, nunca los dos.
  const lista = [
    c('501', 'BUSTOS, Sebastián (Este)'),
    c('502', 'MORENO, José María (Sur)'),
    c('503', 'VILLALBA, Iris (Ciudadela)'),
    c('504', 'BUSTOS, Ana (Norte)'),
  ];

  it('apellido + nombre encuentra al cliente', () => {
    expect(buscarClientes(lista, 'bustos sebastian').resultados.map(x => x.cod)).toEqual(['501']);
  });

  it('el orden de las palabras no importa', () => {
    expect(buscarClientes(lista, 'sebastian bustos').resultados.map(x => x.cod)).toEqual(['501']);
  });

  it('funciona sin acentos, que es como se tipea', () => {
    expect(buscarClientes(lista, 'moreno jose').resultados.map(x => x.cod)).toEqual(['502']);
  });

  it('buscar por localidad + apellido también', () => {
    expect(buscarClientes(lista, 'bustos norte').resultados.map(x => x.cod)).toEqual(['504']);
  });

  it('exige TODAS las palabras: una sola que falle no matchea', () => {
    expect(buscarClientes(lista, 'bustos rodriguez').resultados).toEqual([]);
  });

  it('el match multi-palabra va ÚLTIMO: no le gana a los directos', () => {
    // "villalba iris" matchea el nombre completo de 503 por `includes` de la frase? No:
    // la frase con coma no está. Pero un match directo de una palabra tiene que ganar igual.
    const conDirecto = [...lista, c('505', 'BUSTOS SEBASTIAN SRL')];
    expect(buscarClientes(conDirecto, 'bustos sebastian').resultados[0].cod).toBe('505');
  });
});
