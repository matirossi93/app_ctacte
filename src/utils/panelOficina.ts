/**
 * Quién entra al panel de la oficina y cuándo se muestra.
 *
 * El panel vive en la MISMA app que el resto, bajo la ruta `/reparto`. Así comparte el login,
 * los usuarios, los clientes y la cartera: un dominio propio puede apuntar acá y entrar
 * directo, sin que haya que mantener dos aplicaciones, dos sesiones y dos deploys.
 *
 * El permiso real lo aplica el backend (`puedeArmarHojasDeRuta`); esto sólo decide qué
 * pantalla dibujar. Nunca al revés: esconder un botón no es un permiso.
 */

/** admin y gerente son mando; `administrativo` es el rol de Jorgelina y Susana. */
const ROLES_OFICINA = new Set(['admin', 'gerente', 'administrativo']);

export function puedeVerPanelOficina(rol: string | null | undefined): boolean {
    return ROLES_OFICINA.has(String(rol ?? ''));
}

/**
 * ¿La URL actual pide el panel de la oficina?
 *
 * Se acepta `/reparto` y cualquier cosa colgando de ahí (`/reparto/hojas`), pero NO
 * `/repartidor`, que es otra cosa: el shell del repartidor. Un `startsWith('/reparto')` a secas
 * se llevaría puesta esa ruta.
 */
export function pidePanelOficina(pathname: string): boolean {
    const p = String(pathname ?? '').replace(/\/+$/, '');   // sin la barra final
    return p === '/reparto' || p.startsWith('/reparto/');
}

/**
 * ¿Ve el selector de vendedores del panel y puede filtrar la cartera, los objetivos y la
 * actividad por vendedor? Es la misma gente que trabaja la oficina.
 *
 * 26/09/2026: Anto pasó de gerente a `administrativo` y seguía viendo la cartera de todos,
 * pero sin poder elegir vendedor. Esto es sólo para MIRAR: editar objetivos, feriados y el
 * menú de administración siguen siendo de admin/gerente (`isAdmin` en VendorShell).
 * El backend ya acepta `cod_vendedor`/`cods` de cualquiera que no sea vendedor.
 */
export function filtraPorVendedor(rol: string | null | undefined): boolean {
    return ROLES_OFICINA.has(String(rol ?? ''));
}
