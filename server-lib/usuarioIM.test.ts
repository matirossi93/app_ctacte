import { describe, it, expect, vi, beforeEach } from 'vitest';

// pedidos.ts importa infomanager.js a nivel módulo y ese módulo corta el proceso si le falta
// INFOMANAGER_CLIENT_SECRET. Se mockean los dos side-effects de import (mismo patrón que
// conciliacion.test.ts) para poder controlar qué devuelven /vendedores y la base.
vi.hoisted(() => { process.env.IM_USUARIO_PEDIDOS = 'susana'; });

const { fetchVendedores, sbMock } = vi.hoisted(() => ({
  fetchVendedores: vi.fn(),
  sbMock: vi.fn(),
}));
vi.mock('./infomanager.js', () => ({
  fetchVendedores,
  crearPresupuesto: vi.fn(), anularComprobante: vi.fn(), getPrecioLista: vi.fn(),
  getDisponibleCliente: vi.fn(), fetchClientesIMCached: vi.fn(),
  fetchArticulosCatalogo: vi.fn(), fetchArticulosDeDeposito: vi.fn(),
  getItemsComprobante: vi.fn(), presupuestoFacturado: vi.fn(),
  actualizarPresupuestoCantidades: vi.fn(), fechaComprobante: vi.fn(), fechaArgentina: vi.fn(),
}));
vi.mock('./supabase.js', () => ({ sb: sbMock, TENANT_ID: 'test-tenant', hasSupabase: () => true }));

import { usuarioIM } from './pedidos.js';

/** Arma el encadenado de supabase-js que usa usuarioIM: from().select().eq().eq().maybeSingle() */
function base(resultado: { im_usuario?: string | null } | null, tira?: Error) {
  const maybeSingle = tira
    ? vi.fn().mockRejectedValue(tira)
    : vi.fn().mockResolvedValue({ data: resultado, error: null });
  const eq = vi.fn(); eq.mockReturnValue({ eq, maybeSingle });
  sbMock.mockReturnValue({ from: () => ({ select: () => ({ eq, maybeSingle }) }) });
}

const SEBA = { sub: 'uuid-seba', cod_vendedor: 2 };

beforeEach(() => { fetchVendedores.mockReset(); sbMock.mockReset(); base(null); });

/**
 * En InfoManager el campo `usuario` del comprobante es el OPERADOR que lo carga, no el
 * vendedor (el vendedor viaja aparte, en cod_vendedor). Hasta el 27/08 todos los pedidos de
 * la app salían con el mismo usuario. La ficha del vendedor en IM tiene un campo `usuario`
 * que es justo su login, y `usuarios.im_usuario` es nuestro override.
 */
describe('usuarioIM — con qué usuario de IM se crea el presupuesto', () => {
  it('el override de nuestra base gana sobre todo lo demás', async () => {
    base({ im_usuario: 'sebastian' });
    fetchVendedores.mockResolvedValue([{ cod_vendedor: 2, nombre: 'SEBASTIAN', usuario: 'otro' }]);
    await expect(usuarioIM(SEBA)).resolves.toBe('sebastian');
    // Si ya lo tenemos, ni se le pregunta a IM.
    expect(fetchVendedores).not.toHaveBeenCalled();
  });

  it('🪤 se lee de la BASE, no del token: cambiarlo por SQL hace efecto sin volver a loguearse', async () => {
    base({ im_usuario: 'brian' });
    await expect(usuarioIM({ sub: 'uuid-brian', cod_vendedor: 12 })).resolves.toBe('brian');
    expect(sbMock).toHaveBeenCalled();
  });

  it('sin override, usa el login de la ficha del vendedor en IM', async () => {
    base({ im_usuario: null });
    fetchVendedores.mockResolvedValue([
      { cod_vendedor: 2, nombre: 'SEBASTIAN', usuario: 'sebastian' },
      { cod_vendedor: 12, nombre: 'BRIAN', usuario: 'brian' },
    ]);
    await expect(usuarioIM({ sub: 'uuid-brian', cod_vendedor: 12 })).resolves.toBe('brian');
  });

  it('recorta los espacios: copiar y pegar desde IM los arrastra', async () => {
    base({ im_usuario: '  sebastian  ' });
    await expect(usuarioIM(SEBA)).resolves.toBe('sebastian');
  });

  it('si en IM el campo está vacío, cae al usuario único de la app', async () => {
    // 🪤 Es el estado REAL al 27/08/2026: los 12 vendedores tienen usuario = null.
    base({ im_usuario: null });
    fetchVendedores.mockResolvedValue([{ cod_vendedor: 2, nombre: 'SEBASTIAN', usuario: null }]);
    await expect(usuarioIM(SEBA)).resolves.toBe('susana');
    fetchVendedores.mockResolvedValue([{ cod_vendedor: 2, nombre: 'SEBASTIAN', usuario: '   ' }]);
    await expect(usuarioIM(SEBA)).resolves.toBe('susana');
  });

  it('un vendedor que no está en la lista de IM no rompe nada', async () => {
    base({ im_usuario: null });
    fetchVendedores.mockResolvedValue([{ cod_vendedor: 2, nombre: 'SEBASTIAN', usuario: 'sebastian' }]);
    await expect(usuarioIM({ sub: 'uuid-x', cod_vendedor: 99 })).resolves.toBe('susana');
  });

  it('si IM no contesta, se sigue creando el pedido con el usuario de siempre', async () => {
    // 🪤 Lo importante: NO puede tirar. Quedarse sin usuario rompe el pedido entero.
    base({ im_usuario: null });
    fetchVendedores.mockRejectedValue(new Error('IM caído'));
    await expect(usuarioIM(SEBA)).resolves.toBe('susana');
  });

  it('si la base no contesta, tampoco rompe: sigue por IM y por el default', async () => {
    base(null, new Error('supabase caído'));
    fetchVendedores.mockResolvedValue([{ cod_vendedor: 2, nombre: 'SEBASTIAN', usuario: 'sebastian' }]);
    await expect(usuarioIM(SEBA)).resolves.toBe('sebastian');
  });

  it('sin usuario (o sin vendedor) cae al default sin consultar a IM', async () => {
    await expect(usuarioIM(null)).resolves.toBe('susana');
    await expect(usuarioIM(undefined)).resolves.toBe('susana');
    await expect(usuarioIM({ sub: 'uuid-admin' })).resolves.toBe('susana');
    expect(fetchVendedores).not.toHaveBeenCalled();
  });
});
