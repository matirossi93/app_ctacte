import { describe, it, expect, vi, beforeEach } from 'vitest';

// pedidos.ts importa infomanager.js a nivel módulo y ese módulo corta el proceso si le falta
// INFOMANAGER_CLIENT_SECRET. Se mockea entero (mismo patrón que conciliacion.test.ts) para
// poder controlar qué devuelve /vendedores. IM_USUARIO_PEDIDOS se fija antes de los imports.
vi.hoisted(() => { process.env.IM_USUARIO_PEDIDOS = 'susana'; });

const { fetchVendedores } = vi.hoisted(() => ({ fetchVendedores: vi.fn() }));
vi.mock('./infomanager.js', () => ({
  fetchVendedores,
  crearPresupuesto: vi.fn(), anularComprobante: vi.fn(), getPrecioLista: vi.fn(),
  getDisponibleCliente: vi.fn(), fetchClientesIMCached: vi.fn(),
  fetchArticulosCatalogo: vi.fn(), fetchArticulosDeDeposito: vi.fn(),
  getItemsComprobante: vi.fn(), presupuestoFacturado: vi.fn(),
  actualizarPresupuestoCantidades: vi.fn(), fechaComprobante: vi.fn(), fechaArgentina: vi.fn(),
}));
vi.mock('./supabase.js', () => ({ sb: vi.fn(), TENANT_ID: 'test-tenant', hasSupabase: () => true }));

import { usuarioIM } from './pedidos.js';

beforeEach(() => { fetchVendedores.mockReset(); });

/**
 * En InfoManager el campo `usuario` del comprobante es el OPERADOR que lo carga, no el
 * vendedor (el vendedor viaja aparte, en cod_vendedor). Hasta el 27/08 todos los pedidos de
 * la app salían con el mismo usuario. La ficha del vendedor en IM tiene un campo `usuario`
 * que es justo su login, así que la app lo lee de ahí en vez de mantener una copia.
 */
describe('usuarioIM — con qué usuario de IM se crea el presupuesto', () => {
  it('el override manual de nuestra base gana sobre todo lo demás', async () => {
    fetchVendedores.mockResolvedValue([{ cod_vendedor: 2, nombre: 'SEBASTIAN', usuario: 'sebas.im' }]);
    await expect(usuarioIM({ im_usuario: 'a_mano', cod_vendedor: 2 })).resolves.toBe('a_mano');
    // Ni siquiera hace falta preguntarle a IM si ya tenemos el valor.
    expect(fetchVendedores).not.toHaveBeenCalled();
  });

  it('sin override, usa el login de la ficha del vendedor en IM', async () => {
    fetchVendedores.mockResolvedValue([
      { cod_vendedor: 2, nombre: 'SEBASTIAN', usuario: 'sebastian' },
      { cod_vendedor: 12, nombre: 'BRIAN', usuario: 'brian' },
    ]);
    await expect(usuarioIM({ cod_vendedor: 12 })).resolves.toBe('brian');
  });

  it('recorta los espacios: copiar y pegar desde IM los arrastra', async () => {
    fetchVendedores.mockResolvedValue([{ cod_vendedor: 2, nombre: 'SEBASTIAN', usuario: '  sebastian  ' }]);
    await expect(usuarioIM({ cod_vendedor: 2 })).resolves.toBe('sebastian');
  });

  it('si en IM el campo está vacío, cae al usuario único de la app', async () => {
    // 🪤 Es el estado REAL al 27/08/2026: los 12 vendedores tienen usuario = null.
    fetchVendedores.mockResolvedValue([{ cod_vendedor: 2, nombre: 'SEBASTIAN', usuario: null }]);
    await expect(usuarioIM({ cod_vendedor: 2 })).resolves.toBe('susana');
    fetchVendedores.mockResolvedValue([{ cod_vendedor: 2, nombre: 'SEBASTIAN', usuario: '  ' }]);
    await expect(usuarioIM({ cod_vendedor: 2 })).resolves.toBe('susana');
  });

  it('un vendedor que no está en la lista de IM no rompe nada', async () => {
    fetchVendedores.mockResolvedValue([{ cod_vendedor: 2, nombre: 'SEBASTIAN', usuario: 'sebastian' }]);
    await expect(usuarioIM({ cod_vendedor: 99 })).resolves.toBe('susana');
  });

  it('si IM no contesta, se sigue creando el pedido con el usuario de siempre', async () => {
    // 🪤 Lo importante de este caso: NO puede tirar. Un usuario que IM no reconozca hace que
    // rechace el presupuesto entero, y quedarse sin usuario es peor todavía.
    fetchVendedores.mockRejectedValue(new Error('IM caído'));
    await expect(usuarioIM({ cod_vendedor: 2 })).resolves.toBe('susana');
  });

  it('sin vendedor (admin, backoffice) ni siquiera consulta IM', async () => {
    await expect(usuarioIM({})).resolves.toBe('susana');
    await expect(usuarioIM(null)).resolves.toBe('susana');
    await expect(usuarioIM(undefined)).resolves.toBe('susana');
    await expect(usuarioIM({ cod_vendedor: null })).resolves.toBe('susana');
    expect(fetchVendedores).not.toHaveBeenCalled();
  });
});
