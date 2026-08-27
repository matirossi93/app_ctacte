import { describe, it, expect, vi } from 'vitest';

// Los dos módulos que pedidos.ts arrastra cortan el proceso si les falta config, y el valor
// de IM_USUARIO_PEDIDOS es justo lo que este test necesita fijar. vi.hoisted corre ANTES de
// los imports estáticos (mismo patrón que precioLista.test.ts).
vi.hoisted(() => {
  process.env.INFOMANAGER_CLIENT_SECRET = 'test-secret';
  process.env.IM_USUARIO_PEDIDOS = 'susana';
});

const { usuarioIM } = await import('./pedidos.js');

/**
 * En InfoManager el campo `usuario` del comprobante es el OPERADOR que lo carga, no el
 * vendedor (el vendedor viaja aparte, en cod_vendedor). Hasta el 27/08 todos los pedidos de
 * la app salían con el mismo usuario. Mati confirmó que los vendedores tienen login propio
 * en IM, así que ahora se usa el suyo cuando está cargado.
 */
describe('usuarioIM — con qué usuario de IM se crea el presupuesto', () => {
  it('usa el login del vendedor cuando lo tiene cargado', () => {
    expect(usuarioIM({ im_usuario: 'sebastian' })).toBe('sebastian');
  });

  it('cae al usuario único de la app cuando el vendedor no tiene login propio', () => {
    // 🪤 El fallback no es cosmético: un usuario que IM no reconozca puede hacer que
    // rechace el presupuesto entero. Vacío = usar el que ya sabemos que funciona.
    expect(usuarioIM({ im_usuario: null })).toBe('susana');
    expect(usuarioIM({})).toBe('susana');
    expect(usuarioIM(null)).toBe('susana');
    expect(usuarioIM(undefined)).toBe('susana');
  });

  it('un valor en blanco no se manda a IM: cuenta como vacío', () => {
    expect(usuarioIM({ im_usuario: '' })).toBe('susana');
    expect(usuarioIM({ im_usuario: '   ' })).toBe('susana');
  });

  it('recorta los espacios de los costados (copiar y pegar desde IM los arrastra)', () => {
    expect(usuarioIM({ im_usuario: '  brian  ' })).toBe('brian');
  });
});
