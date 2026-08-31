/**
 * Al abrir la app se le pregunta a `/api/me` si la sesión guardada sigue valiendo.
 * Esta es la regla que decide qué hacer con la respuesta.
 *
 * 🔴 31/08/2026: acá estaba el bug. `App.tsx` borraba la sesión ante CUALQUIER cosa que no
 * fuera un 200 — incluido el `catch` de red. O sea que un bache de señal al abrir la app
 * deslogueaba al vendedor y lo dejaba en el login con «Error de conexión con el servidor».
 * En la calle, con la PWA relanzándose cada vez que el celular la descarta, pasa seguido.
 *
 * 🔑 La distinción que faltaba: **no poder preguntar** si la sesión vale no es lo mismo que
 * una sesión que **no vale**.
 *
 * Vive acá y no adentro del componente porque es una regla de seguridad de tres líneas que
 * tiene que poder probarse sin montar React ni un navegador — mismo criterio que
 * `buscarClientes.ts` y `vistaObjetivo.ts`.
 */

/**
 * ¿La respuesta de `/api/me` dice que la sesión NO sirve más?
 *
 * @param status  código HTTP, o `null` cuando el `fetch` ni siquiera llegó a contestar
 *                (sin red, DNS caído, timeout del celular).
 * @param hayUsuario  si el cuerpo del 200 trajo un usuario. Sólo se mira en los 2xx.
 */
export function sesionRechazada(status: number | null, hayUsuario: boolean): boolean {
    // No hubo respuesta: el server no dijo NADA sobre el token. Borrarlo acá es inventar un
    // rechazo que nadie hizo.
    if (status === null) return false;
    // El único rechazo explícito de la credencial.
    if (status === 401 || status === 403) return true;
    // 200 sin usuario adentro: el server contestó que esta sesión no le sirve.
    if (status >= 200 && status < 300) return !hayUsuario;
    // 500, 502, 503, 504… el server (o el proxy) tiene un problema. El token no tiene la culpa
    // y el vendedor no tiene por qué pagarlo con su sesión.
    return false;
}
