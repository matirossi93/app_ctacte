import { describe, it, expect, beforeEach } from 'vitest';
import {
    parsearBorrador, guardarBorrador, leerBorrador, borrarBorrador,
    cuandoSeGuardo, CLAVE_BORRADOR, VERSION_BORRADOR,
    type BorradorNuevo,
} from './borradorPedido';

/**
 * Estos tests son la red que evita que se repita el 31/08/2026: un vendedor cargó un pedido
 * grande, vio un cartel de "sin conexión" y perdió todo.
 *
 * Lo que se prueba acá es lo que decide si el pedido vuelve o no vuelve, y —igual de
 * importante— que no vuelva ROTO ni le vuelva al vendedor equivocado.
 */

/** localStorage de mentira: vitest corre en node, donde no existe. */
class StorageFalso {
    datos = new Map<string, string>();
    romper = false;
    getItem(k: string) { if (this.romper) throw new Error('denied'); return this.datos.get(k) ?? null; }
    setItem(k: string, v: string) { if (this.romper) throw new Error('QuotaExceeded'); this.datos.set(k, v); }
    removeItem(k: string) { if (this.romper) throw new Error('denied'); this.datos.delete(k); }
}
let store: StorageFalso;
beforeEach(() => {
    store = new StorageFalso();
    (globalThis as any).localStorage = store;
});

const RENGLON = {
    uid: 'u1', cod_articulo: 4030, descripcion: 'ALIMENTO PERRO 20KG',
    cantidad: 10, precio: 18500, cod_lista: 13, descuento: 0,
};
const BORRADOR: BorradorNuevo = {
    email: 'seba@semillero.com',
    cliente: { cod: '1234', name: 'DESPENSA LA ESQUINA', localidad: 'Concepción', cod_lista: 13 },
    listaCliente: 13,
    cart: [RENGLON],
    obs: 'entregar el jueves',
    editando: null,
    idempotencyKey: 'key-abc',
};
const guardado = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ ...BORRADOR, v: VERSION_BORRADOR, ts: 1_756_600_000_000, ...extra });

describe('parsearBorrador — cuándo SÍ se recupera', () => {
    it('devuelve el pedido entero tal como estaba', () => {
        const b = parsearBorrador(guardado(), 'seba@semillero.com');
        expect(b?.cart).toEqual([RENGLON]);
        expect(b?.cliente.name).toBe('DESPENSA LA ESQUINA');
        expect(b?.obs).toBe('entregar el jueves');
        expect(b?.listaCliente).toBe(13);
    });

    // 🔑 Es lo que evita el presupuesto duplicado en InfoManager: al reintentar el envío, el
    // backend encuentra esta clave y devuelve el pedido que ya existe en vez de crear otro.
    it('conserva la idempotency_key del intento anterior', () => {
        expect(parsearBorrador(guardado(), 'seba@semillero.com')?.idempotencyKey).toBe('key-abc');
    });

    it('conserva el id del pedido que se estaba editando', () => {
        const b = parsearBorrador(guardado({ editando: 'ped-9' }), 'seba@semillero.com');
        expect(b?.editando).toBe('ped-9');
    });
});

describe('parsearBorrador — cuándo NO se recupera', () => {
    it('sin nada guardado', () => {
        expect(parsearBorrador(null, 'seba@semillero.com')).toBeNull();
        expect(parsearBorrador('', 'seba@semillero.com')).toBeNull();
    });

    it('con el JSON roto (escritura cortada a la mitad)', () => {
        expect(parsearBorrador('{"v":1,"cart":[', 'seba@semillero.com')).toBeNull();
        expect(parsearBorrador('null', 'seba@semillero.com')).toBeNull();
    });

    // Los renglones de una versión vieja pueden no tener los campos que hoy se mandan a IM.
    it('con un formato de otra versión', () => {
        expect(parsearBorrador(guardado({ v: 0 }), 'seba@semillero.com')).toBeNull();
        expect(parsearBorrador(guardado({ v: 99 }), 'seba@semillero.com')).toBeNull();
    });

    // 🔴 El celular se comparte. El pedido de Seba no puede aparecerle a Brian, que lo
    // mandaría a IM con SU código de vendedor y a un cliente que no es suyo.
    it('si es de OTRO usuario', () => {
        expect(parsearBorrador(guardado(), 'brian@semillero.com')).toBeNull();
    });

    it('si no se sabe quién está logueado', () => {
        expect(parsearBorrador(guardado(), '')).toBeNull();
    });

    it('sin cliente o sin renglones no hay nada que recuperar', () => {
        expect(parsearBorrador(guardado({ cliente: null }), 'seba@semillero.com')).toBeNull();
        expect(parsearBorrador(guardado({ cliente: { name: 'X' } }), 'seba@semillero.com')).toBeNull();
        expect(parsearBorrador(guardado({ cart: [] }), 'seba@semillero.com')).toBeNull();
        expect(parsearBorrador(guardado({ cart: 'no-es-array' }), 'seba@semillero.com')).toBeNull();
    });

    // 🪤 Acá es donde un borrador "recuperado a medias" sería peor que ninguno: el vendedor
    // ve su pedido de vuelta, no nota que le falta un renglón, y lo manda así.
    it('descarta el borrador ENTERO si un solo renglón está corrupto', () => {
        const conRoto = (roto: Record<string, unknown>) =>
            parsearBorrador(guardado({ cart: [RENGLON, { ...RENGLON, uid: 'u2', ...roto }] }), 'seba@semillero.com');
        expect(conRoto({ cantidad: 0 })).toBeNull();
        expect(conRoto({ cantidad: NaN })).toBeNull();
        expect(conRoto({ cantidad: '10' })).toBeNull();
        expect(conRoto({ precio: -1 })).toBeNull();
        expect(conRoto({ cod_articulo: 0 })).toBeNull();
        expect(conRoto({ cod_lista: 0 })).toBeNull();
        expect(conRoto({ descuento: 101 })).toBeNull();
        expect(conRoto({ uid: '' })).toBeNull();
    });

    it('sin idempotency_key: reenviarlo podría duplicar el presupuesto', () => {
        expect(parsearBorrador(guardado({ idempotencyKey: '' }), 'seba@semillero.com')).toBeNull();
    });

    it('un precio en 0 sí es válido (artículo sin precio en la lista, el backend lo frena)', () => {
        expect(parsearBorrador(guardado({ cart: [{ ...RENGLON, precio: 0 }] }), 'seba@semillero.com')).not.toBeNull();
    });

    it('acepta cantidades decimales (el granel se vende por kilo)', () => {
        expect(parsearBorrador(guardado({ cart: [{ ...RENGLON, cantidad: 2.5 }] }), 'seba@semillero.com')).not.toBeNull();
    });
});

describe('guardar / leer / borrar', () => {
    it('guarda y devuelve el mismo pedido', () => {
        guardarBorrador(BORRADOR);
        expect(leerBorrador('seba@semillero.com')?.cart).toEqual([RENGLON]);
    });

    it('le pone la fecha de guardado', () => {
        guardarBorrador(BORRADOR, 1_756_600_000_000);
        expect(leerBorrador('seba@semillero.com')?.ts).toBe(1_756_600_000_000);
    });

    it('el borrador nuevo pisa al anterior: cada vendedor tiene UN pedido en curso, no una pila', () => {
        guardarBorrador(BORRADOR);
        guardarBorrador({ ...BORRADOR, obs: 'otra cosa' });
        expect(store.datos.size).toBe(1);
        expect(leerBorrador('seba@semillero.com')?.obs).toBe('otra cosa');
    });

    // 🔴 En el mostrador de una sucursal el teléfono es de todos. Con una clave sola, el que
    // entraba segundo le borraba el pedido a medio cargar al primero — el mismo problema que
    // esto vino a resolver, mudado de lugar.
    it('el pedido de un vendedor no pisa ni borra el del otro en el mismo teléfono', () => {
        guardarBorrador(BORRADOR);
        guardarBorrador({ ...BORRADOR, email: 'brian@semillero.com', obs: 'el de Brian' });
        expect(leerBorrador('seba@semillero.com')?.obs).toBe('entregar el jueves');
        expect(leerBorrador('brian@semillero.com')?.obs).toBe('el de Brian');

        borrarBorrador('brian@semillero.com');
        expect(leerBorrador('brian@semillero.com')).toBeNull();
        expect(leerBorrador('seba@semillero.com')).not.toBeNull();
    });

    it('sin usuario no se guarda: no se sabría a quién devolvérselo', () => {
        guardarBorrador({ ...BORRADOR, email: '' });
        expect(store.datos.size).toBe(0);
    });

    it('borrar lo deja sin nada que recuperar', () => {
        guardarBorrador(BORRADOR);
        borrarBorrador('seba@semillero.com');
        expect(store.datos.size).toBe(0);
        expect(leerBorrador('seba@semillero.com')).toBeNull();
    });

    it('guarda bajo una clave propia por usuario', () => {
        guardarBorrador(BORRADOR);
        expect([...store.datos.keys()]).toEqual([`${CLAVE_BORRADOR}:seba@semillero.com`]);
    });

    // Modo privado de Safari, cuota llena, storage bloqueado: la app tiene que seguir andando.
    // Se pierde la red de seguridad, no la pantalla.
    it('no tira nunca aunque el storage falle', () => {
        store.romper = true;
        expect(() => guardarBorrador(BORRADOR)).not.toThrow();
        expect(() => borrarBorrador('seba@semillero.com')).not.toThrow();
        expect(leerBorrador('seba@semillero.com')).toBeNull();
    });
});

describe('cuandoSeGuardo', () => {
    // Con cero adelante y en 24 horas en cualquier teléfono: `toLocaleString('es-AR')` devuelve
    // "31/8, 02:32 p. m." según el ICU del dispositivo.
    it('muestra día y hora para que el vendedor sepa si el borrador es viejo', () => {
        expect(cuandoSeGuardo(new Date(2026, 7, 31, 14, 32).getTime())).toBe('31/08 14:32');
        expect(cuandoSeGuardo(new Date(2026, 0, 5, 9, 4).getTime())).toBe('05/01 09:04');
    });
    it('sin fecha no inventa una', () => {
        expect(cuandoSeGuardo(0)).toBe('');
        expect(cuandoSeGuardo(NaN)).toBe('');
    });
});
