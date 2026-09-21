import { describe, it, expect } from 'vitest';
import { clasificarArticulo, type ReglaLista } from './listas.js';
import { avisosDeListaPorPedido } from './listasPorCliente.js';

/**
 * LAS CANTIDADES PARA LA LISTA SE CUENTAN POR CLIENTE, NO POR PRESUPUESTO.
 *
 * Mati (21/09/2026): *"un cliente en particular que tiene dos o tres presupuestos... las listas
 * de precio van por presupuesto, las cantidades. Pero si un cliente tiene tres presupuestos, las
 * cantidades para acceder a esas listas de precio hay que considerar las tres, porque es el
 * mismo cliente. Esto pasa porque por ahí tienen varias sucursales"*.
 *
 * Se suman los pedidos del MISMO cliente con la MISMA fecha de entrega — los que se despachan
 * juntos. Es la agrupación que la pantalla ya usaba para avisar de pedidos duplicados
 * (`vivosPorClienteDia`), así que no se inventa un criterio nuevo.
 *
 * Medido el 21/09/2026 sobre 10 días: 47 de 296 presupuestos vivos (16%) son de clientes que
 * pidieron más de una vez el mismo día, en 22 grupos — uno de $3,1 millones repartido en tres.
 */
const regla = (cod_lista: number, condicion: ReglaLista['condicion'], umbral: number | null = null): ReglaLista => ({
  nombre: 'LINEA FLECKY + FULLCAT', match_tipo: 'subrubro', match_valor: 'Flecky', cod_lista, condicion, umbral,
  unidad: condicion === 'promo_general' ? 'bulto' : 'unidad',
  ambito: condicion === 'promo_general' ? 'pedido' : 'linea',
});
/** Las de Flecky vigentes desde el 21/09: L3 desde 10 bolsas de la línea, L4 desde 20. */
const REGLAS = [regla(12, 'libre'), regla(13, 'promo_general', 10), regla(14, 'min', 10), regla(15, 'min', 20)];
const CATALOGO = new Map([
  [163, clasificarArticulo({ cod_articulo: 163, descripcion: 'FLECKY ADULTO MIX X 15 KG', subrubro: 'Flecky', unidad_de_medida: 'Bolsa', equivalencia_um: 15 })],
]);
const pr = (id: string, cod_cliente: number, fecha: string) => ({ id, cod_cliente, fecha });
/** Un renglón de Flecky pidiendo la lista `cod_lista`. */
const ren = (cantidad: number, cod_lista = 14) => ({ cod_articulo: 163, cantidad, cod_lista_precios: cod_lista, descuento_porc: 0 });

const correr = (presupuestos: any[], renglones: Record<string, any[]>) =>
  avisosDeListaPorPedido(presupuestos, new Map(Object.entries(renglones)), CATALOGO, REGLAS, []);

describe('las cantidades se cuentan por cliente y fecha de entrega', () => {
  it('🔑 dos pedidos del mismo cliente y día: 6 + 6 bolsas alcanzan L3, y ninguno queda marcado', () => {
    // Por separado, 6 bolsas no llegan a las 10 de L3 y los dos saldrían con "pide una lista
    // que no le corresponde". Juntos son 12 y el derecho existe.
    const r = correr(
      [pr('A', 763, '2026-09-19'), pr('B', 763, '2026-09-19')],
      { A: [ren(6)], B: [ren(6)] });
    expect(r.gravedad.get('A')).toBeUndefined();
    expect(r.gravedad.get('B')).toBeUndefined();
  });

  it('🔴 fechas de entrega distintas NO se suman: son dos despachos', () => {
    const r = correr(
      [pr('A', 763, '2026-09-19'), pr('B', 763, '2026-09-22')],
      { A: [ren(6)], B: [ren(6)] });
    expect(r.gravedad.get('A')?.pierde_margen).toBe(1);
    expect(r.gravedad.get('B')?.pierde_margen).toBe(1);
  });

  it('🔴 clientes distintos el mismo día tampoco', () => {
    const r = correr(
      [pr('A', 763, '2026-09-19'), pr('B', 999, '2026-09-19')],
      { A: [ren(6)], B: [ren(6)] });
    expect(r.gravedad.get('A')?.pierde_margen).toBe(1);
  });

  it('🔑 el aviso dice que se contó el conjunto: si no, el número no cierra con lo que se ve', () => {
    // Con 4 + 4 siguen sin llegar a 10. El cartel tiene que explicar sobre qué se contó, o
    // Jorgelina mira un pedido de 4 bolsas y no entiende de dónde sale la cuenta.
    const r = correr(
      [pr('A', 763, '2026-09-19'), pr('B', 763, '2026-09-19')],
      { A: [ren(4)], B: [ren(4)] });
    const textos = r.avisos.get('A') ?? [];
    expect(textos.some(t => t.includes('2 pedidos'))).toBe(true);
  });

  it('un cliente con un solo pedido no lleva esa aclaración', () => {
    const r = correr([pr('A', 763, '2026-09-19')], { A: [ren(4)] });
    expect((r.avisos.get('A') ?? []).some(t => t.includes('pedidos de este cliente'))).toBe(false);
  });

  it('🪤 cada aviso queda en SU pedido, no todos en el primero', () => {
    // A pide L3 con derecho (12 juntas) y B pide L4 sin derecho: sólo B tiene que salir marcado.
    const r = correr(
      [pr('A', 763, '2026-09-19'), pr('B', 763, '2026-09-19')],
      { A: [ren(6, 14)], B: [ren(6, 15)] });
    expect(r.gravedad.get('A')).toBeUndefined();
    expect(r.gravedad.get('B')?.pierde_margen).toBe(1);
  });

  it('un pedido sin renglones no rompe el grupo', () => {
    const r = correr(
      [pr('A', 763, '2026-09-19'), pr('B', 763, '2026-09-19')],
      { A: [ren(12)] });
    expect(r.gravedad.get('A')).toBeUndefined();
    expect(r.avisos.has('B')).toBe(false);
  });
});
