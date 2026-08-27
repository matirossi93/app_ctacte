import { describe, it, expect, vi, beforeEach } from 'vitest';

const PRECIOS: Record<string, number> = { '1001|12': 1000, '1001|14': 700 };
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
            data: tabla === 'listas_reglas'
              ? [{ nombre: 'ALPISTE', match_tipo: 'articulo', match_valor: '1001', cod_lista: 14,
                   condicion: 'min', umbral: 2, unidad: 'bultos', ambito: 'articulo' }]
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

async function correr(items: any[]) {
  let out: any;
  const req: any = { body: { items }, on: () => {} };
  const res: any = { json: (b: any) => { out = b; }, status: () => res };
  await validarListasPedido(req, res);
  return out;
}

describe('silenciarSiElPrecioYaEstaBien con el MISMO articulo en dos renglones', () => {
  beforeEach(() => getPrecioLista.mockClear());

  it('A: [desc 0, desc 30] -> el renglon con 30% ya esta al precio de L3, deberia silenciarse', async () => {
    const r = await correr([
      { cod_articulo: 1001, cantidad: 1, cod_lista: 12, descuento_porc: 0 },
      { cod_articulo: 1001, cantidad: 1, cod_lista: 12, descuento_porc: 30 },
    ]);
    console.log('A bultos=', r.bultos, JSON.stringify(r.avisos.map((a: any) => ({ idx: a.idx, sev: a.severidad, sug: a.lista_sugerida, msg: !!a.mensaje }))));
    expect(r.avisos[1].severidad).toBe('ok');
  });

  it('B: [desc 30, desc 0] -> el renglon SIN descuento le cobra de mas: el aviso debe SOBREVIVIR', async () => {
    const r = await correr([
      { cod_articulo: 1001, cantidad: 1, cod_lista: 12, descuento_porc: 30 },
      { cod_articulo: 1001, cantidad: 1, cod_lista: 12, descuento_porc: 0 },
    ]);
    console.log('B bultos=', r.bultos, JSON.stringify(r.avisos.map((a: any) => ({ idx: a.idx, sev: a.severidad, sug: a.lista_sugerida, msg: !!a.mensaje }))));
    expect(r.avisos[1].severidad).toBe('cliente');
    expect(r.avisos[1].mensaje).toBeTruthy();
  });
});
