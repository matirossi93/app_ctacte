/**
 * Quién puede qué, escrito como lista BLANCA.
 *
 * 🔴 01/09/2026. Hasta hoy los permisos de la app se escribían así:
 *
 *     if (user.rol === 'vendedor') q = q.eq('cod_vendedor', ...)
 *
 * 26 veces, en 7 archivos. Es una lista NEGRA: dice a quién frenar, así que **todo el que no
 * sea `vendedor` pasa**. Cada rol nuevo entró por la puerta de atrás sin que nadie lo
 * decidiera — `administrativo` y `socio` el 28/08, `encargado` el 31/08 — y quedaron
 * anulando presupuestos en InfoManager y abriendo fotos de cheques de todo el equipo.
 *
 * 🔑 La forma correcta es al revés: **decir a quién SÍ**. Un rol que se cree mañana no hereda
 * nada hasta que alguien lo nombre acá.
 *
 * Vive en un archivo propio para que la regla esté en UN lugar y se pueda testear sin montar
 * ni el server ni la base.
 */

/** Los que corrigen lo que carga el resto. En dos de los tres casos de abajo, los docstrings
 *  del código YA decían "admin y gerencia" — sólo que nadie lo había implementado. */
const MANDO = new Set<string>(['admin', 'gerente']);

/** Lo mínimo del usuario que hace falta para decidir. */
export interface QuienPregunta {
    rol: string;
    /** `sub` del JWT: el id del usuario. */
    sub?: string;
    cod_vendedor?: number | null;
}

/** Lo mínimo del pedido que hace falta para decidir. */
export interface PedidoDeQuien {
    cod_vendedor?: number | null;
    created_by?: string | null;
}

/**
 * ¿Puede EDITAR o ANULAR este pedido? Anular toca InfoManager de verdad, así que es la
 * pregunta más cara del archivo.
 *
 * 🪤 No alcanza con mirar el rol. Los usuarios de sucursal (mostrador, encargados) CARGAN
 * pedidos, y tienen que poder corregir los suyos: si esto fuera sólo admin/gerente, el que
 * cargó el pedido no podría tocarlo. Por eso el que no es de mando queda atado a lo que
 * cargó ÉL (`created_by`), y el vendedor a su propia cartera, que es como venía.
 */
export function puedeTocarPedido(user: QuienPregunta, pedido: PedidoDeQuien): boolean {
    if (MANDO.has(user.rol)) return true;
    if (user.rol === 'vendedor') {
        return user.cod_vendedor != null && Number(pedido.cod_vendedor) === Number(user.cod_vendedor);
    }
    return !!user.sub && String(pedido.created_by ?? '') === String(user.sub);
}

/**
 * ¿Puede editar o borrar una actividad (visita, nota, PROMESA DE PAGO) que cargó otro?
 *
 * 🪤 El comentario de `deleteActivity` decía "solo propia o admin" y el código dejaba borrar
 * la de cualquiera a todo el que no fuera vendedor. Y borra la fila, no la marca.
 */
export function puedeTocarActividadAjena(rol: string): boolean {
    return MANDO.has(rol);
}

/**
 * ¿Ve las cobranzas de TODO el equipo, con la foto del cheque o la transferencia?
 *
 * La lista blanca sale de lo que ya estaba documentado como deliberado:
 *  · admin y gerente — mando;
 *  · `administrativo` — Susana y Rodrigo son los que imputan; `auth.ts` dice que ven como
 *    gerente, y Mati lo confirmó el 01/09;
 *  · `repartidor` — documentado en `recibos.ts`: el backoffice imputa y él consulta;
 *  · el dueño de toda la empresa (`usuarios.ve_toda_la_empresa`, migración 030).
 *
 * El resto ve lo suyo. Un `encargado` no tiene cartera propia, así que no ve ninguna: es lo
 * que pidió Mati el 01/09 ("nada de cuenta corriente" para los encargados de sucursal).
 */
export function veCobranzasDeTodos(rol: string, veTodaLaEmpresa = false): boolean {
    return MANDO.has(rol) || rol === 'administrativo' || rol === 'repartidor' || veTodaLaEmpresa;
}
