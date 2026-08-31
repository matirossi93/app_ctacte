/**
 * Qué tarjeta de objetivo le corresponde a cada usuario.
 *
 * Vive acá y no adentro de VendorShell porque la regla se decide en DOS lugares
 * (el widget "Tu avance" del Hoy y la pantalla Objetivos) y tiene que poder
 * probarse sin montar React — mismo motivo que `buscarClientes.ts`.
 */

export interface UsuarioObjetivo {
    rol: string;
    cod_vendedor: number | null;
}

export type ModoObjetivo =
    /** Se muestra la tarjeta de UN vendedor. */
    | 'vendedor'
    /** Se muestra el agregado del equipo. */
    | 'equipo'
    /** No hay nada propio que mostrar: estado vacío, NUNCA el objetivo de otro. */
    | 'ninguno';

export type SeleccionObjetivo<T> =
    | { modo: 'vendedor'; item: T | null }
    | { modo: 'equipo' }
    | { modo: 'ninguno' };

/**
 * El modo solo, sin la lista. Lo usan el rótulo de la tarjeta y el ranking, que
 * necesitan la misma regla pero no el item: tener UNA sola función evita que las
 * condiciones se dupliquen y se vayan separando (que es como nació este bug).
 */
export function modoObjetivo(user: UsuarioObjetivo | null | undefined, selectedVendor: number | null): ModoObjetivo {
    if (!user) return 'ninguno';

    // Hay un vendedor concreto en foco: el suyo (vendedor) o el tildado (admin).
    if (selectedVendor != null) return 'vendedor';

    if (user.rol === 'admin' || user.rol === 'gerente') return 'equipo';

    // Roles sin cartera propia (socio, administrativo, encargado): miran el equipo.
    // Antes caían en la rama del vendedor y se llevaban items[0] — el objetivo de
    // Sebastián — bajo el título "Tu avance".
    if (user.rol !== 'vendedor' && user.cod_vendedor == null) return 'equipo';

    // Vendedor sin cod_vendedor cargado: no tiene nada propio, y no hereda lo de otro.
    return 'ninguno';
}

export function elegirObjetivo<T extends { cod_vendedor: number }>(
    user: UsuarioObjetivo | null | undefined,
    selectedVendor: number | null,
    items: readonly T[],
): SeleccionObjetivo<T> {
    const modo = modoObjetivo(user, selectedVendor);
    if (modo !== 'vendedor') return { modo };
    return { modo, item: items.find(i => i.cod_vendedor === selectedVendor) ?? null };
}
