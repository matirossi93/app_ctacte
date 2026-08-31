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
  /**
   * Dueño de TODA la empresa, no de una unidad (migración 030).
   *
   * 🪤 No se deduce de `cod_empresa`: ese campo es desde dónde EMITE, no qué puede MIRAR.
   * Elvio tiene cod_empresa=2 (BRS) y sin embargo es dueño de todo.
   */
  ve_toda_la_empresa: boolean;
}

const VACIA: FilaUsuario = { im_usuario: null, cod_empresa: null, ve_todos_los_clientes: false, ve_toda_la_empresa: false };

export async function filaUsuario(user?: { sub?: string } | null): Promise<FilaUsuario> {
  if (!user?.sub) return VACIA;
  try {
    const { data, error } = await sb().from('usuarios')
      .select('im_usuario, cod_empresa, ve_todos_los_clientes, ve_toda_la_empresa')
      .eq('tenant_id', TENANT_ID).eq('id', user.sub).maybeSingle();
    // 🔴 supabase-js NO tira excepción: resuelve con {data:null, error}. Sin este chequeo, una
    // columna que falta (deploy hecho ANTES de correr su migración) devolvía la fila VACÍA en
    // silencio, y con ella todos los permisos en su valor más restrictivo o más laxo según el
    // caso: el usuario de mostrador perdía `ve_todos_los_clientes` y el socio dueño de toda la
    // empresa quedaba mirando Casa Central. Que se vea en el log.
    if (error) console.warn(`[filaUsuario] la consulta falló (¿falta correr una migración?): ${error.message}`);
    return {
      im_usuario: data?.im_usuario ?? null,
      cod_empresa: data?.cod_empresa ?? null,
      ve_todos_los_clientes: data?.ve_todos_los_clientes === true,
      ve_toda_la_empresa: data?.ve_toda_la_empresa === true,
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
