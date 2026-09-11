import { describe, expect, it } from 'vitest';
import { clasificarArticulo, evaluarPedido, type ReglaLista } from './listas.js';

const regla = (cod_lista: number, condicion: ReglaLista['condicion'], umbral: number | null = null): ReglaLista => ({ nombre: 'LINEA FLECKY + FULLCAT', match_tipo: 'subrubro', match_valor: 'Flecky', cod_lista, condicion, umbral, unidad: condicion === 'promo_general' ? 'bulto' : 'unidad', ambito: condicion === 'promo_general' ? 'pedido' : 'linea' });
const reglas = [regla(12, 'libre'), regla(13, 'promo_general', 10), regla(14, 'min', 20), regla(15, 'min', 30)];
const catalogo = new Map([
  [163, clasificarArticulo({ cod_articulo: 163, descripcion: 'FLECKY ADULTO MIX X 15 KG', subrubro: 'Flecky', unidad_de_medida: 'Bolsa', equivalencia_um: 15 })],
  [166, clasificarArticulo({ cod_articulo: 166, descripcion: 'FLECKY ADULTO CARNE X 20 KG', subrubro: 'Flecky', unidad_de_medida: 'BOLSA', equivalencia_um: 21 })],
  [281, clasificarArticulo({ cod_articulo: 281, descripcion: 'FULL CAT PESCADO CARNE FRESCA X 10 KG', subrubro: 'Flecky', unidad_de_medida: 'BOLSA', equivalencia_um: 10 })],
  [10244, clasificarArticulo({ cod_articulo: 10244, descripcion: 'FULLCAT X KG', subrubro: 'Flecky' })],
  [1, clasificarArticulo({ cod_articulo: 1, descripcion: 'BEBE X 25 KG - GANAVE', subrubro: 'Ganave', unidad_de_medida: 'Bolsas', equivalencia_um: 25 })],
]);
const item = (cod_articulo: number, cantidad: number, cod_lista = 14) => ({ cod_articulo, cantidad, cod_lista });

describe('aclaración de Matías: línea y presupuesto completo son conteos distintos', () => {
  it.each([[10, 10, 14], [15, 15, 15]])('Flecky %i + Full Cat %i habilitan la lista %i en ambos', (a, b, lista) => {
    const r = evaluarPedido([item(163, a, lista), item(281, b, lista)], catalogo, reglas);
    expect(r.avisos.every(a => a.severidad === 'ok')).toBe(true);
    expect(r.lineas).toHaveLength(1);
    expect(r.lineas?.[0].unidades).toBe(a + b);
  });
  it('cuenta unidades de las presentaciones, no sus kilos ni renglones', () => {
    const r = evaluarPedido([item(163, 1, 15), item(166, 10, 15), item(281, 19, 15)], catalogo, reglas);
    expect(r.lineas?.[0].unidades).toBe(30);
    expect(r.avisos.every(a => a.severidad === 'ok')).toBe(true);
  });
  it('divide un artículo en dos renglones sin cambiar el beneficio del surtido', () => {
    const r = evaluarPedido([item(163, 8), item(281, 10), item(163, 2)], catalogo, reglas);
    expect(r.avisos.map(a => a.idx)).toEqual([0, 1, 2]);
    expect(r.avisos.every(a => a.severidad === 'ok')).toBe(true);
    expect(r.lineas?.[0].unidades).toBe(20);
  });
  it('otra línea suma para promo general, pero no para L3 de Flecky', () => {
    const r = evaluarPedido([item(163, 9), item(1, 11, 12)], catalogo, reglas);
    expect(r.promo_general).toBe(true);
    expect(r.lineas?.[0].unidades).toBe(9);
    expect(r.avisos[0]).toMatchObject({ severidad: 'margen', lista_sugerida: 13 });
  });
  it('los kilos del espejo minorista no se cuentan como unidades de bolsa de la línea', () => {
    const r = evaluarPedido([item(163, 10), item(10244, 10, 9)], catalogo, reglas);
    expect(r.lineas?.[0].unidades).toBe(10);
    expect(r.avisos[0].severidad).toBe('margen');
    expect(r.avisos[1].severidad).toBe('sin_regla');
  });
  it('códigos explícitos y subrubros con el mismo nombre comercial también acumulan', () => {
    const cat = new Map(catalogo);
    cat.set(281, { ...catalogo.get(281)!, subrubro: 'Otro subrubro IM' });
    const especiales = reglas.map(r => ({ ...r, nombre: ' linea flecky + fullcat ', match_tipo: 'articulo' as const, match_valor: '281' }));
    const r = evaluarPedido([item(163, 10), item(281, 10)], cat, [...reglas, ...especiales]);
    expect(r.avisos.every(a => a.severidad === 'ok')).toBe(true);
    expect(r.lineas).toHaveLength(1);
    expect(r.lineas?.[0].unidades).toBe(20);
  });
});
