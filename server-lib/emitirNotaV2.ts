import { postV2 } from './imApiV2.js';
import { camposAfipNota } from './camposAfipNota.js';

/**
 * EMITIR UNA NOTA DE CRÉDITO O DÉBITO POR LA API NUEVA DE INFOMANAGER.
 *
 * 🔴 ES LO ÚNICO IRREVERSIBLE DEL CIRCUITO: consume numeración fiscal y toca la cuenta corriente
 * del cliente. Todo lo que no se puede acreditar, NO se emite: es preferible un error en pantalla
 * a una nota que después hay que anular.
 *
 * Lo que agrega sobre el emisor v1 (`facturarIM.ts` → `emitirNota`):
 *
 *   · `id_comp_asoc` — la factura que la nota acredita, **atada en InfoManager**. Hasta hoy eso
 *     era un texto en las observaciones ("SEGUN FACTURA 50401") y un vínculo guardado de nuestro
 *     lado, que no existe para nadie más.
 *   · `id_item_origen` — qué renglón de la factura corrige cada línea. Con él, un `precio` en 0
 *     hace que IM tome el del renglón original y desaparece toda una familia de errores nuestros
 *     (el bruto contra el neto, el descuento aplicado dos veces, el redondeo).
 *   · `numero: 0` — lo numera el sistema. Calcularlo nosotros fue el choque de serie que dejó
 *     rechazada la NC B 30079 el 11/09/2026.
 *
 * ⚠️ DOS COSAS A CONFIRMAR EN LA PRIMERA EMISIÓN REAL (21/09/2026):
 *
 *  1. `id_destino`. Una NC de la oficina leída ese día (NC B 30116) sale con **1**, pero el spec
 *     de v2 sólo documenta `2 electrónica interna | 3 controlador fiscal | 11 mostrador CC2`. Se
 *     manda el 1 —lo que usa la oficina— y NO se omite: omitirlo dejaría que IM elija, y una de
 *     las opciones es el controlador fiscal, que Mati rechazó explícitamente el 10/09/2026. Si IM
 *     rechaza el 1, falla la emisión, que es el lado seguro.
 *  2. `tipo_nc`. Es obligatorio en v2 y NO existe en v1, así que no hay forma de deducir cuál usa
 *     la oficina leyendo lo que ya emitió. Lo decide quien llama. El spec avisa que `FI` y `DC`
 *     dependen de las tareas 37 y 49 del usuario de IM: si no las tiene, van a rechazar.
 */
export type TipoNota = 'NC' | 'ND';
/** DE devolución · FI financiera · DC diferencia de cotización. Obligatorio en la NC. */
export type SubtipoNC = 'DE' | 'FI' | 'DC';
/** De qué cubeta de la factura salen los ítems. Sólo con subtipo DE. */
export type CodControl = 'C_RE' | 'S_RE' | 'C_IR';

/** La factura que la nota acredita: por id interno, o por punto de venta + número. */
export interface FacturaAsociada {
  im_id?: string | number | null;
  punto_de_venta?: number | null;
  numero?: number | null;
}

export interface RenglonNotaV2 {
  cod_articulo: number;
  cantidad: number;
  /** En 0 o sin informar, con `id_item_origen`, IM usa el precio del renglón de la factura. */
  precio?: number | null;
  descuento_porc?: number | null;
  /** El renglón de la factura que este corrige. */
  id_item_origen?: number | null;
}

export interface NotaV2Input {
  tipo: TipoNota;
  /** yyyy-MM-dd. Sin ella, la pone InfoManager. */
  fecha?: string | null;
  /** Letra del comprobante: A | B | C | E | M | X. */
  letra: string;
  cod_cliente: number;
  cod_empresa: number;
  cod_vendedor?: number | null;
  observaciones: string;
  tipo_nc?: SubtipoNC;
  factura: FacturaAsociada;
  items: RenglonNotaV2[];
  cod_control?: CodControl;
  /** Genera la recepción por devolución (IR) y reingresa el stock. Sólo con DE + C_RE. */
  genero_re_auto?: boolean;
  cod_deposito?: number | null;
  cod_lista_precios?: number | null;
  /** 🔴 Única por operación: es lo que impide duplicar la nota si se corta la conexión. */
  idempotencyKey: string;
}

export type ResultadoNotaV2 =
  | { ok: true; im_id: string; numero: number | null; recepcion?: { im_id: string; numero: number | null } }
  | { ok: false; error: string; traceId?: string | null; raw?: unknown };

/**
 * El punto de venta y el destino NO son configurables desde afuera, igual que en el emisor v1:
 * el 999 es el controlador fiscal y no se usa como salida alternativa a un rechazo.
 */
const PTO_VENTA = 777;
const ID_DESTINO = 1;
/**
 * 🪤 El spec marca `cod_deposito` como opcional —"en 0 toma el predeterminado del usuario"—
 * pero el usuario con el que entra la API NO tiene uno: la primera emisión de prueba del
 * 21/09/2026 rebotó con *"El usuario 'api_servicio' no tiene un depósito predeterminado
 * asignado"*. Así que para nosotros es obligatorio. Va el Depósito General, igual que el emisor v1.
 */
const DEPOSITO = Number(process.env.PEDIDO_DEPOSITO || 1);

const entero = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
};

export async function emitirNotaV2(input: NotaV2Input): Promise<ResultadoNotaV2> {
  const que = input.tipo === 'NC' ? 'nota de crédito' : 'nota de débito';

  /**
   * 🔴 IDENTIFICAR LA FACTURA ES EL MOTIVO DE TODO ESTO. Una nota v2 sin comprobante asociado no
   * es mejor que una v1: queda suelta igual y encima por un camino nuevo sin probar.
   */
  const idFactura = entero(input.factura?.im_id);
  const pv = entero(input.factura?.punto_de_venta);
  const num = entero(input.factura?.numero);
  if (idFactura == null && (pv == null || num == null)) {
    return { ok: false, error: `No se puede emitir la ${que}: falta identificar la factura que acredita (id, o punto de venta y número). No se envió nada.` };
  }

  if (input.tipo === 'NC' && !input.tipo_nc) {
    return { ok: false, error: 'No se puede emitir la nota de crédito: falta el subtipo (DE devolución, FI financiera o DC diferencia de cotización). InfoManager lo exige y adivinarlo cambia qué hace la nota.' };
  }

  if (!Array.isArray(input.items) || !input.items.length) {
    return { ok: false, error: `No se puede emitir la ${que} sin renglones.` };
  }
  for (const it of input.items) {
    if (!(Number(it?.cantidad) > 0)) {
      return { ok: false, error: `Hay un renglón con una cantidad que no es un número positivo (artículo ${it?.cod_articulo ?? '?'}). No se envió la ${que}.` };
    }
    if (entero(it?.cod_articulo) == null || Number(it.cod_articulo) <= 0) {
      return { ok: false, error: `Hay un renglón sin código de artículo válido. No se envió la ${que}.` };
    }
  }

  /**
   * 🔴 Reingresar stock sólo vale con una devolución de mercadería remitida. Mandarlo con otro
   * subtipo haría que InfoManager reingrese —o no— mercadería que nadie devolvió, y el stock no
   * se arregla desde acá.
   */
  if (input.genero_re_auto && !(input.tipo_nc === 'DE' && input.cod_control === 'C_RE')) {
    return { ok: false, error: 'Reingresar el stock sólo vale en una nota de crédito por devolución (subtipo DE) sobre ítems remitidos (C_RE). No se envió nada.' };
  }

  const cuerpo: Record<string, unknown> = {
    // 🔑 0 = lo numera InfoManager. No volvemos a calcular el correlativo.
    numero: 0,
    punto_de_venta: PTO_VENTA,
    id_destino: ID_DESTINO,
    tipo_factura: input.letra,
    moneda: 'P',
    cotizacion: 1,
    tag: 'S',
    cod_cliente: input.cod_cliente,
    cod_empresa: input.cod_empresa,
    observaciones: input.observaciones ?? '',
    // Cuenta corriente: es lo que viene mandando el emisor v1 y lo que corresponde al circuito.
    condicion_venta_tipo: 2,
    /**
     * 🔴 SIN ESTO LA NOTA SALE POR EL CONTROLADOR FISCAL.
     *
     * Mati (22/09/2026): *"al emitir, querer imprimir esa NC en IM te llevaba a la impresora
     * fiscal cuando en realidad era una NC manual no fiscal"*. Es el MISMO problema que ya había
     * reportado el 10/09 sobre el emisor v1 —*"debería seguir la misma suerte de todo el otro
     * circuito, que no involucre a AFIP, es interno"*— y que ahí se resolvió con estos campos.
     * Este emisor nació sin ellos y lo repitió: la NC B 30117 del 21/09 salió con
     * `afip_comprobantes_fe: null` y `afip_conceptos_fe: 0`, contra `""` y `1` de las que hace
     * la oficina.
     *
     * 🔑 Se reusa la función del emisor v1 a propósito: son la misma regla fiscal y tener dos
     * copias garantiza que un día queden distintas.
     */
    ...camposAfipNota(input.tipo),
    tipo_comp_asoc: 'FA',
    ...(input.fecha ? { fecha: input.fecha } : {}),
    ...(input.cod_vendedor != null ? { cod_vendedor: input.cod_vendedor } : {}),
    cod_deposito: input.cod_deposito ?? DEPOSITO,
    ...(input.cod_lista_precios != null ? { cod_lista_precios: input.cod_lista_precios } : {}),
    ...(input.tipo_nc ? { tipo_nc: input.tipo_nc } : {}),
    ...(input.cod_control ? { cod_control: input.cod_control } : {}),
    ...(input.genero_re_auto ? { genero_re_auto: 'S' } : {}),
    // Por id si lo tenemos; si no, por punto de venta + número (la letra desambigua).
    ...(idFactura != null ? { id_comp_asoc: idFactura } : { pto_vta_comp_asoc: pv, num_comp_asoc: num }),
    items: input.items.map(it => ({
      cod_articulo: Number(it.cod_articulo),
      cantidad: Number(it.cantidad),
      ...(it.precio != null ? { precio: Number(it.precio) } : {}),
      ...(it.descuento_porc != null ? { descuento_porc: Number(it.descuento_porc) } : {}),
      ...(it.id_item_origen != null ? { id_item_origen: Number(it.id_item_origen) } : {}),
    })),
  };

  try {
    const d: any = await postV2(
      input.tipo === 'NC' ? '/api/v2/notas-credito' : '/api/v2/notas-debito',
      cuerpo, input.idempotencyKey);
    const nota = d?.venta ?? d?.nota ?? d?.nota_de_credito ?? d?.nota_de_debito ?? d;
    /**
     * 🔴 Éxito es `isCreated`, no "vino un 200". Es el mismo patrón que `crearPresupuesto` en v1:
     * InfoManager puede contestar 200 devolviendo el comprobante que YA existía, y tomar eso por
     * una emisión nueva duplicaría el crédito en la cuenta del cliente.
     */
    if (d?.isCreated !== true) {
      return { ok: false, error: `InfoManager no creó la ${que} (isCreated distinto de true). No se avanzó la numeración.`, raw: d };
    }
    const im_id = String(nota?.id ?? '');
    if (!im_id) return { ok: false, error: `InfoManager dijo que creó la ${que} pero no devolvió su id. Verificá en InfoManager antes de reintentar.`, raw: d };
    const rec = d?.recepcion;
    return {
      ok: true,
      im_id,
      numero: entero(nota?.numero),
      ...(rec ? { recepcion: { im_id: String(rec.id ?? ''), numero: entero(rec.numero) } } : {}),
    };
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err), traceId: err?.traceId ?? null };
  }
}
