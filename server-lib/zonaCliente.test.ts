import { describe, it, expect } from 'vitest';
import { zonaDeCliente, agruparPorZona, NOMBRE_ZONA } from './zonaCliente.js';

/**
 * La zona es lo que agrupa las hojas de ruta. La hoja real nº 3394 (07/09/2026) eran todos
 * clientes de la zona 9 — Lules y Manantial.
 *
 * El mapa de zonas se dedujo cruzando `cod_zona` con los nombres de cliente de IM.
 */

describe('zonaDeCliente', () => {
  it('🔴 usa el cod_zona de IM cuando está', () => {
    const z = zonaDeCliente({ cod_zona: 9, razon_social: 'AMADO, Graciela (Lules)' });
    expect(z.cod_zona).toBe(9);
    expect(z.nombre).toBe('Lules / Manantial');
    expect(z.origen).toBe('im');
  });

  it('🔴 el cod_zona MANDA sobre el nombre y sobre la localidad', () => {
    // Caso real: AMADO, Graciela figura "(Lules)" y zona 9, pero su localidad en IM dice
    // "San Miguel de Tucumán". La localidad no es confiable; la zona sí.
    const z = zonaDeCliente({ cod_zona: 9, razon_social: 'AMADO, Graciela (Lules)', localidad: 'San Miguel de Tucumán' });
    expect(z.cod_zona).toBe(9);
  });

  it('🔴 sin cod_zona, cae al paréntesis del nombre', () => {
    const z = zonaDeCliente({ cod_zona: null, razon_social: 'PEREZ, Marcos (Yerba Buena)' });
    expect(z.cod_zona).toBe(13);
    expect(z.origen).toBe('nombre');   // para poder desconfiar en la pantalla
  });

  it('🔴 el paréntesis NO siempre es una zona: no se inventa', () => {
    // "VARGAS, Cintia (Julio)" y "(Marcelo)" son clientes reales, y el paréntesis es el
    // titular, no la zona. Adivinar acá manda un pedido al camión equivocado.
    for (const nombre of ['VARGAS, Cintia (Julio)', 'VARGAS, Cintia (Marcelo)', 'ACOSTA (contado)']) {
      const z = zonaDeCliente({ cod_zona: 0, razon_social: nombre });
      expect(z.cod_zona).toBeNull();
      expect(z.nombre).toBe('Sin zona');
    }
  });

  it('🔴 cod_zona 0 es "no tiene", no la zona cero', () => {
    expect(zonaDeCliente({ cod_zona: 0, razon_social: 'X' }).cod_zona).toBeNull();
    expect(zonaDeCliente({ cod_zona: '', razon_social: 'X' }).cod_zona).toBeNull();
    expect(zonaDeCliente(null).cod_zona).toBeNull();
  });

  it('una zona sin nombre conocido igual se muestra', () => {
    const z = zonaDeCliente({ cod_zona: 99 });
    expect(z.cod_zona).toBe(99);
    expect(z.nombre).toBe('Zona 99');
  });

  it('el mapa cubre las 13 zonas que usan', () => {
    for (let i = 1; i <= 13; i++) expect(NOMBRE_ZONA[i]).toBeTruthy();
  });
});

describe('agruparPorZona', () => {
  const cli = (f: any) => f;

  it('🔴 agrupa y ordena por código de zona', () => {
    const g = agruparPorZona(
      [{ cod_zona: 9 }, { cod_zona: 4 }, { cod_zona: 9 }, { cod_zona: 13 }],
      cli,
    );
    expect(g.map(x => x.cod_zona)).toEqual([4, 9, 13]);
    expect(g.find(x => x.cod_zona === 9)!.filas).toHaveLength(2);
  });

  it('🔴 los SIN zona van al final, no se descartan', () => {
    // Si se perdieran, un pedido no entraría en ninguna hoja y nadie se enteraría hasta que
    // el cliente llame preguntando dónde está su mercadería.
    const g = agruparPorZona(
      [{ cod_zona: null, razon_social: 'NUEVO SA' }, { cod_zona: 4 }],
      cli,
    );
    expect(g).toHaveLength(2);
    expect(g[g.length - 1].cod_zona).toBeNull();
    expect(g[g.length - 1].nombre).toBe('Sin zona');
    expect(g[g.length - 1].filas).toHaveLength(1);
  });

  it('sin filas devuelve una lista vacía', () => {
    expect(agruparPorZona([], cli)).toEqual([]);
  });
});
