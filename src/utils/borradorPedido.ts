/**
 * El pedido a medio cargar, guardado en el celular del vendedor.
 *
 * 🔴 31/08/2026: un vendedor cargó un pedido grande, le apareció un cartel de "sin conexión"
 * y perdió TODO — tuvo que llamar al cliente y pedírselo de nuevo. El carrito vivía sólo en
 * el `useState` de PedidosApp: cualquier cosa que desmontara esa pantalla (cerrar el modal,
 * que iOS descarte la pestaña mientras atiende una llamada, recargar, un error de React) se
 * llevaba el pedido entero sin dejar rastro.
 *
 * Vive acá y no adentro del componente por el mismo motivo que `buscarClientes.ts`: es lo que
 * decide si un pedido se recupera o se pierde, y tiene que poder probarse sin montar React.
 */

/**
 * Versión del formato. Si cambia la forma del renglón, se sube este número y los borradores
 * viejos se descartan en vez de restaurarse a medias: un pedido mutilado que el vendedor
 * manda sin darse cuenta es peor que un pedido perdido.
 */
export const VERSION_BORRADOR = 1;

/**
 * Un borrador POR USUARIO.
 *
 * 🪤 Con una clave sola, en un teléfono compartido —el mostrador de una sucursal— el que
 * entra segundo le borra el pedido a medio cargar al primero: exactamente el problema que
 * esto vino a resolver, mudado de lugar. El email va en la clave y además adentro del
 * borrador: la clave separa, el campo verifica.
 */
export const CLAVE_BORRADOR = 'pedido_borrador';
const claveDe = (email: string) => `${CLAVE_BORRADOR}:${email}`;

/** Un renglón del carrito. Misma forma que `CartItem` de PedidosApp. */
export interface RenglonBorrador {
    uid: string;
    cod_articulo: number;
    descripcion: string;
    cantidad: number;
    precio: number;
    cod_lista: number;
    descuento: number;
}

/** El cliente del pedido. Misma forma que `ClienteOpt` de PedidosApp. */
export interface ClienteBorrador {
    cod: string;
    name: string;
    localidad?: string;
    cod_lista?: number;
}

/** Lo que hace falta para dejar al vendedor exactamente donde estaba. */
export interface Borrador {
    v: number;
    /** Dueño del borrador: el celular puede ser compartido y el pedido de uno no es del otro. */
    email: string;
    /** Cuándo se guardó (epoch ms). Se le muestra al vendedor: un borrador de anteayer tiene precios viejos. */
    ts: number;
    cliente: ClienteBorrador;
    listaCliente: number;
    cart: RenglonBorrador[];
    obs: string;
    /** id del pedido que se estaba editando. null = pedido nuevo. */
    editando: string | null;
    /**
     * 🔑 La MISMA clave con la que ya se intentó enviar, no una nueva.
     *
     * Si la red se cortó después de que el POST salió, el pedido pudo haber entrado a
     * InfoManager igual. Al recuperar el borrador y volver a confirmar, el backend encuentra
     * esta clave (índice único en `pedidos_vendedor`) y devuelve el pedido que ya existe en
     * vez de crear un segundo presupuesto. Regenerarla acá sería fabricar el duplicado que
     * toda esta pantalla viene tratando de evitar.
     */
    idempotencyKey: string;
}

/** Lo que el componente le pasa a `guardarBorrador`: el resto lo pone esta función. */
export type BorradorNuevo = Omit<Borrador, 'v' | 'ts'>;

const textoOk = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
const numOk = (x: unknown, min: number): x is number =>
    typeof x === 'number' && Number.isFinite(x) && x >= min;

/**
 * Un renglón sólo sirve si se puede mandar a InfoManager tal cual está.
 *
 * 🪤 No se "arregla" un renglón roto poniéndole valores por defecto: el vendedor no ve la
 * diferencia y termina mandándole al cliente una cantidad o un precio que él no cargó.
 */
function renglonValido(r: any): r is RenglonBorrador {
    return !!r
        && textoOk(r.uid)
        && numOk(r.cod_articulo, 1)
        && typeof r.descripcion === 'string'
        && numOk(r.cantidad, Number.MIN_VALUE)
        && numOk(r.precio, 0)
        && numOk(r.cod_lista, 1)
        && numOk(r.descuento, 0) && r.descuento <= 100;
}

/**
 * Convierte lo que había guardado en un borrador usable, o `null` si no sirve.
 *
 * Devuelve null —y el vendedor arranca de cero, que es como estaba antes de todo esto— cuando:
 * no hay nada guardado, el JSON está roto, el formato es de otra versión, el borrador es de
 * OTRO usuario, no tiene cliente o no tiene ni un renglón. Si UN renglón está corrupto se
 * descarta el borrador ENTERO: entregar un pedido al que le falta un producto, sin avisar,
 * es peor que no entregar ninguno.
 */
export function parsearBorrador(raw: string | null, email: string): Borrador | null {
    if (!raw) return null;
    let b: any;
    try { b = JSON.parse(raw); } catch { return null; }
    if (!b || typeof b !== 'object') return null;
    if (b.v !== VERSION_BORRADOR) return null;
    // Sin email no se puede saber de quién es: no se restaura. Vale también para el borrador
    // guardado antes de que el usuario se deslogueara y entrara otro en el mismo teléfono.
    if (!textoOk(email) || b.email !== email) return null;
    if (!b.cliente || !textoOk(b.cliente.cod)) return null;
    if (!Array.isArray(b.cart) || !b.cart.length) return null;
    if (!b.cart.every(renglonValido)) return null;
    if (!textoOk(b.idempotencyKey)) return null;
    if (!numOk(b.listaCliente, 1)) return null;
    return {
        v: VERSION_BORRADOR,
        email: b.email,
        ts: numOk(b.ts, 0) ? b.ts : 0,
        cliente: {
            cod: String(b.cliente.cod),
            name: String(b.cliente.name ?? ''),
            localidad: b.cliente.localidad ?? undefined,
            cod_lista: numOk(b.cliente.cod_lista, 1) ? b.cliente.cod_lista : undefined,
        },
        listaCliente: b.listaCliente,
        cart: b.cart,
        obs: typeof b.obs === 'string' ? b.obs : '',
        editando: textoOk(b.editando) ? b.editando : null,
        idempotencyKey: b.idempotencyKey,
    };
}

/**
 * Guarda el borrador. Nunca tira: si el navegador no deja escribir (modo privado, cuota
 * llena), el vendedor sigue cargando el pedido igual que antes — se pierde la red de
 * seguridad, no la pantalla.
 */
export function guardarBorrador(b: BorradorNuevo, ahora: number = Date.now()): void {
    if (!textoOk(b.email)) return;   // sin dueño no se guarda: no se sabría a quién devolvérselo
    try {
        localStorage.setItem(claveDe(b.email), JSON.stringify({ ...b, v: VERSION_BORRADOR, ts: ahora }));
    } catch { /* sin borrador, como antes */ }
}

/** El borrador de ESTE usuario, o null. */
export function leerBorrador(email: string): Borrador | null {
    try { return parsearBorrador(localStorage.getItem(claveDe(email)), email); }
    catch { return null; }
}

export function borrarBorrador(email: string): void {
    try { localStorage.removeItem(claveDe(email)); }
    catch { /* ignore */ }
}

/**
 * "31/08 14:32" para el cartel de recuperación. El vendedor tiene que poder darse cuenta solo
 * de si el borrador es de hace un rato o de hace tres días (los precios se movieron).
 *
 * 🪤 Armado a mano y no con `toLocaleString('es-AR', …)`: según el ICU del dispositivo, ese
 * mismo pedido devuelve "31/8, 02:32 p. m." — sin cero adelante y en 12 horas. Acá es un dato
 * de una línea que se lee de reojo en la calle, así que sale igual en todos los teléfonos.
 */
export function cuandoSeGuardo(ts: number): string {
    if (!numOk(ts, 1)) return '';
    const d = new Date(ts);
    const dd = (n: number) => String(n).padStart(2, '0');
    return `${dd(d.getDate())}/${dd(d.getMonth() + 1)} ${dd(d.getHours())}:${dd(d.getMinutes())}`;
}
