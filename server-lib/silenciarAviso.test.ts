import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `silenciarSiElPrecioYaEstaBien` apaga el aviso "le estás cobrando de más" cuando el renglón
 * lleva un descuento que ya lo deja en el precio de la lista que le corresponde (en los
 * cereales, L1 −30% da exactamente L3). Para eso tiene que mirar el descuento DE ESE renglón.
 *
 * 🪤 Buscaba el renglón con `items.find(x => x.cod_articulo === a.cod_articulo)`. Desde que el
 * mismo artículo puede ir en dos renglones, eso agarra siempre el PRIMERO: el descuento de uno
 * decide si se silencia el aviso del otro. El caso caro es el segundo test.
 */

const PRECIOS: Record<string, number> = {
  // ALPISTE: L1 $1.000, L3 $700. Un 30% sobre L1 da exactamente L3.
  '1001|12': 1000,
  '1001|14': 700,
};
const getPrecioLista = vi.fn(async (cod: number, lista: number) => {
  const p = PRECIOS[`${cod}|${lista}`];
  return p == null ? null : { precio_vta: p };
});

vi.mock('./supabase.js', () => ({
  TENANT_ID: 't',
  sb: () => ({
    from: (tabla: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => Promise.resolve({
            // Una sola regla: desde 2 bultos de alpiste corresponde L3.
            data: tabla === 'listas_reglas'
              ? [{
                  nombre: 'ALPISTE', match_tipo: 'articulo', match_valor: '1001', cod_lista: 14,
                  condicion: 'min', umbral: 2, unidad: 'bultos', ambito: 'articulo',
                }]
              : [],
            error: null,
          }),
        }),
      }),
    }),
  }),
}));

vi.mock('./infomanager.js', () => ({
  getPrecioLista,
  fetchArticulosCatalogo: async () => new Map([[1001, {
    descripcion: 'ALPISTE X 20 KG', subrubro: 'ALPISTE', unidad_de_medida: 'Bolsas', equivalencia_um: 20,
  }]]),
  crearPresupuesto: vi.fn(), anularComprobante: vi.fn(), getDisponibleCliente: vi.fn(),
  fetchClientesIMCached: vi.fn(), fetchArticulosDeDeposito: vi.fn(), getItemsComprobante: vi.fn(),
  presupuestoFacturado: vi.fn(), actualizarPresupuestoCantidades: vi.fn(),
  fechaComprobante: vi.fn(), fechaArgentina: vi.fn(), fetchVendedores: vi.fn(),
  fetchPreciosDeLista: vi.fn(),
}));

const { validarListasPedido } = await import('./pedidos.js');

/** Corre POST /api/pedidos/validar con estos renglones y devuelve el body de la respuesta. */
async function validar(items: Array<{ cod_articulo: number; cantidad: number; cod_lista: number; descuento_porc: number }>) {
  let body: any;
  const req: any = { body: { items }, on: () => {} };
  const res: any = { json: (b: any) => { body = b; }, status: () => res };
  await validarListasPedido(req, res);
  return body;
}

describe('🪤 el aviso se silencia con el descuento DE SU renglón (Mati 27/08)', () => {
  beforeEach(() => { getPrecioLista.mockClear(); });

  it('el renglón con descuento suficiente se silencia', async () => {
    // Dos bultos de alpiste ⇒ le corresponde L3. El segundo renglón está en L1 pero con 30%,
    // o sea que ya está pagando el precio de L3: no hay nada que avisar.
    const r = await validar([
      { cod_articulo: 1001, cantidad: 1, cod_lista: 12, descuento_porc: 0 },
      { cod_articulo: 1001, cantidad: 1, cod_lista: 12, descuento_porc: 30 },
    ]);
    expect(r.avisos[1].severidad).toBe('ok');
  });

  it('🔴 y el renglón SIN descuento conserva su aviso: no hereda el del otro', async () => {
    // El mismo caso dado vuelta. Al segundo renglón le están cobrando L1 sin ningún descuento
    // teniendo derecho a L3: ese aviso TIENE que llegarle al vendedor. Con .find() por código
    // se tomaba el 30% del PRIMER renglón y el aviso desaparecía en silencio.
    const r = await validar([
      { cod_articulo: 1001, cantidad: 1, cod_lista: 12, descuento_porc: 30 },
      { cod_articulo: 1001, cantidad: 1, cod_lista: 12, descuento_porc: 0 },
    ]);
    expect(r.avisos[1].severidad).toBe('cliente');
    expect(r.avisos[1].mensaje).toBeTruthy();
  });
});
