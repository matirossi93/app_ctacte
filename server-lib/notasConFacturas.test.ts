import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * QUÉ FACTURA ACREDITA CADA NOTA DE CRÉDITO — dicho por InfoManager, no deducido por nosotros.
 *
 * Hasta hoy el vínculo nota↔factura era nuestro: la app escribe "SEGUN FACTURA 50401" en las
 * observaciones al emitir y guarda la relación de su lado (`hojas_ruta_ajustes`, el journal de
 * correcciones). Eso deja afuera TODAS las notas que la oficina hace a mano en InfoManager, que
 * son la mayoría, y obliga a que alguien elija a ojo cuál corresponde.
 *
 * `GET /api/v2/ventas/notas-credito-con-facturas` lo devuelve nativo. Verificado en vivo el
 * 21/09/2026: NC 30026 → factura B 777-50095, NC 30028 → factura B 777-49836 (de otro mes que
 * la nota, que es justo el caso que a ojo se erra).
 */
const m = vi.hoisted(() => ({ get: vi.fn(), configurada: vi.fn(() => true) }));
vi.mock('./imApiV2.js', () => ({ getV2: m.get, imV2Configurada: m.configurada }));

const { fetchNotasConFacturas } = await import('./notasConFacturas.js');

const nota = (numero: number, facturas: any[], extra: any = {}) => ({
  id: 58000000 + numero, tipo_factura: 'B', punto_de_venta: 777, numero,
  fecha: '2026-09-01', cod_cliente: 395, cliente: 'JACOBO ALVARO', total: 281190.437,
  anulada: 'N', facturas, ...extra,
});
const factura = (numero: number, extra: any = {}) => ({
  id: 58600000 + numero, tipo_factura: 'B', punto_de_venta: 777, numero,
  fecha: '2026-09-01', total: 1941469.91, anulada: 'N', ...extra,
});

beforeEach(() => { vi.clearAllMocks(); m.configurada.mockReturnValue(true); });

describe('las notas de crédito con su factura', () => {
  it('🔑 devuelve el vínculo tal como lo da InfoManager', async () => {
    m.get.mockResolvedValue({ results: [nota(30026, [factura(50095)])], totalItems: 1, nextPage: null });
    const r = await fetchNotasConFacturas('2026-09-01', '2026-09-21');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ numero: 30026, im_id: '58030026', total: 281190.44, vigente: true });
    expect(r[0].facturas[0]).toMatchObject({ im_id: '58650095', numero: 50095, punto_de_venta: 777, tipo: 'B' });
  });

  it('🔑 pagina hasta traer todo: una nota que quede afuera es una nota que nadie concilia', async () => {
    m.get
      .mockResolvedValueOnce({ results: [nota(1, []), nota(2, [])], totalItems: 3, nextPage: 2 })
      .mockResolvedValueOnce({ results: [nota(3, [])], totalItems: 3, nextPage: null });
    const r = await fetchNotasConFacturas('2026-09-01', '2026-09-21');
    expect(r.map(x => x.numero)).toEqual([1, 2, 3]);
    expect(m.get).toHaveBeenCalledTimes(2);
    expect((m.get.mock.calls[1][1] as any).page).toBe(2);
  });

  it('🪤 corta si la paginación no avanza, en vez de girar para siempre', async () => {
    // Si el servidor repitiera nextPage, un while ingenuo cuelga la pantalla y funde la cuota.
    m.get.mockResolvedValue({ results: [nota(9, [])], totalItems: 999, nextPage: 1 });
    const r = await fetchNotasConFacturas('2026-09-01', '2026-09-21');
    expect(r.length).toBeGreaterThan(0);
    expect(m.get.mock.calls.length).toBeLessThan(30);
  });

  it('🔴 una nota anulada viaja marcada, no se descarta en silencio', async () => {
    // Descartarla acá haría que "no aparece" signifique dos cosas distintas: no existe, o existe
    // y está anulada. El que concilia necesita distinguirlas.
    m.get.mockResolvedValue({ results: [nota(30030, [factura(50100)], { anulada: 'S' })], totalItems: 1, nextPage: null });
    const r = await fetchNotasConFacturas('2026-09-01', '2026-09-21');
    expect(r[0].vigente).toBe(false);
  });

  it('una nota sin factura asociada se devuelve igual, con la lista vacía', async () => {
    m.get.mockResolvedValue({ results: [nota(30031, [])], totalItems: 1, nextPage: null });
    expect((await fetchNotasConFacturas('2026-09-01', '2026-09-21'))[0].facturas).toEqual([]);
  });

  it('🔴 sin credenciales cargadas devuelve vacío y NO rompe la pantalla que la llame', async () => {
    m.configurada.mockReturnValue(false);
    expect(await fetchNotasConFacturas('2026-09-01', '2026-09-21')).toEqual([]);
    expect(m.get).not.toHaveBeenCalled();
  });
});
