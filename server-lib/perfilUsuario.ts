import { sb, TENANT_ID } from './supabase.js';
import { sucursalDe, type Sucursal } from './sucursales.js';

/**
 * La configuración del usuario que vive en la BASE, no en el token.
 *
 * 🪤 Todo esto es CONFIGURACIÓN, no credenciales, y por eso se lee en cada request en vez de
 * viajar en el JWT: el token dura 8 h, así que cambiar un valor por SQL no haría efecto hasta
 * que la persona vuelva a loguearse. Ya nos pasó con `im_usuario`.
 */
export interface FilaUsuario {
  im_usuario: string | null;
  cod_empresa: number | null;
  ve_todos_los_clientes: boolean;
}

const VACIA: FilaUsuario = { im_usuario: null, cod_empresa: null, ve_todos_los_clientes: false };

export async function filaUsuario(user?: { sub?: string } | null): Promise<FilaUsuario> {
  if (!user?.sub) return VACIA;
  try {
    const { data } = await sb().from('usuarios')
      .select('im_usuario, cod_empresa, ve_todos_los_clientes')
      .eq('tenant_id', TENANT_ID).eq('id', user.sub).maybeSingle();
    return {
      im_usuario: data?.im_usuario ?? null,
      cod_empresa: data?.cod_empresa ?? null,
      ve_todos_los_clientes: data?.ve_todos_los_clientes === true,
    };
  } catch (e: any) {
    console.warn('[filaUsuario] no pude leer usuarios:', e?.message);
    return VACIA;
  }
}

/**
 * La unidad del usuario (empresa + depósito + punto de venta de InfoManager).
 * Sin `cod_empresa` cargado da CASA CENTRAL, que es como venía funcionando todo.
 */
export async function sucursalDelUsuario(user?: { sub?: string } | null): Promise<Sucursal> {
  return sucursalDe((await filaUsuario(user)).cod_empresa);
}

/**
 * Si este usuario ve TODOS los clientes en vez de su cartera.
 *
 * Es un mostrador, no una cartera: al vendedor de una sucursal le entra cualquier cliente por
 * la puerta, así que filtrarle por `cod_vendedor` le esconde justo al que tiene enfrente.
 * Va como flag explícito y NO deducido de tener sucursal: que BRS tenga mostrador hoy no
 * significa que mañana no pueda tener vendedores con cartera propia.
 */
export async function veTodosLosClientes(user?: { sub?: string } | null): Promise<boolean> {
  return (await filaUsuario(user)).ve_todos_los_clientes;
}
