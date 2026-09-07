/**
 * Emitir factura y remito en InfoManager, que es lo que hoy hace Jorgelina a mano desde IM.
 *
 * 🔴 ES LA ÚNICA PARTE IRREVERSIBLE DE TODO EL CIRCUITO. Un presupuesto se anula y no pasa
 * nada; una factura consume numeración fiscal y toca la cuenta corriente del cliente, y un
 * remito con `mueve_stock` descuenta stock de verdad. Todo lo de acá se escribió para fallar
 * del lado seguro: verificar antes, emitir de a uno, y frenar apenas algo no cierra.
 *
 * Todo lo que sabe este archivo salió de probarlo contra IM el 07/09/2026 (comprobantes de
 * prueba 58230-58232 y remito 77290, todos anulados). Ver
 * `reference_im_api_facturar_remitos_20260907` en la memoria.
 */
import { imClient, fetchVentas, fechaArgentina, horaArgentina } from './infomanager.js';

/** Cómo factura cada tipo de cliente. Sale de 3.887 facturas reales de la semana del 01/09. */
export type CategoriaIva = 'CF' | 'RI' | 'RM' | string;

/**
 * Qué letra de factura le corresponde a un cliente.
 *
 * 🔴 ESTO ES UNA REGLA FISCAL, no una preferencia. Medido sobre las facturas que emitió la
 * oficina por el punto de venta 777 (Casa Central): CF → B, RI → A, RM → A.
 *
 * 🪤 Devuelve `null` cuando la categoría no es una de esas tres. NO se elige una por defecto:
 * emitir la letra equivocada es un problema impositivo, no un renglón mal puesto. Sin letra,
 * el pedido no se factura y se avisa para que lo haga una persona.
 */
export function letraDeFactura(categoriaIva: CategoriaIva | null | undefined): 'A' | 'B' | null {
  const c = String(categoriaIva ?? '').trim().toUpperCase();
  if (c === 'RI' || c === 'RM') return 'A';
  if (c === 'CF') return 'B';
  return null;
}

export interface ItemAFacturar {
  cod_articulo: number;
  cantidad: number;
  precio: number;
  cod_lista_precios?: number | null;
  descuento_porc?: number | null;
  iva_por?: number | null;
}

export interface DatosComprobante {
  cod_empresa: number;
  cod_cliente: number;
  cod_vendedor: number;
  categoria_iva: CategoriaIva | null | undefined;
  cod_lista_precios: number;
  usuario: string;
  observaciones?: string;
  /** Id del presupuesto de origen. Viaja en `cod_compatibilidad`, que es lo único que IM guarda. */
  origen_id?: string | number | null;
  total: number;
  items: ItemAFacturar[];
  /** Depósito de donde sale la mercadería. Sin esto el remito no descuenta de donde debe. */
  cod_deposito?: number;
  /**
   * Número de factura ya calculado. Al facturar una hoja entera se calcula UNA vez y se va
   * incrementando: consultarlo por cada factura son 6 s de más cada vez.
   */
  numero?: number | null;
}

export type ResultadoEmision =
  | { ok: true; id: string; numero: number | null; tipo: string; raw?: any }
  | { ok: false; error: string; sinRespuesta?: boolean; raw?: any };

/**
 * Punto de venta de Casa Central para cada comprobante, de `GET /puntos-de-venta`.
 * 🪤 La combinación empresa + tipo + id_destino tiene que EXISTIR o IM contesta
 * "no está relacionado a un punto de venta existente".
 */
const PTO_VENTA_FACTURA = Number(process.env.IM_PTO_VENTA_FACTURA || 777);
const PTO_VENTA_REMITO = Number(process.env.IM_PTO_VENTA_REMITO || 7);
const ID_DESTINO = Number(process.env.IM_ID_DESTINO_FACTURA || 1);
const CUENTA_VENTA = process.env.IM_CUENTA_VENTA_PEDIDOS || '4100002';

/**
 * Unidad de negocio del renglón.
 *
 * 🪤 La cuenta de ventas de IM (4100002, "Ventas de Bienes de Cambio") tiene
 * `cod_unidad_negocio: 0` en el plan de cuentas, o sea SIN ASIGNAR. Al facturar por API eso
 * hace que IM rechace: *"La cuenta de venta [4100002] del artículo [661] no tiene unidad de
 * negocio"*. Mandándola en el renglón, pasa.
 *
 * ⚠️ El 1 es el valor con el que se comprobó que IM acepta, NO una decisión contable
 * verificada: la unidad de negocio define cómo se imputa la venta. Está en una variable de
 * entorno para poder cambiarlo sin tocar código en cuanto la oficina confirme cuál va.
 */
const UNIDAD_NEGOCIO = Number(process.env.IM_UNIDAD_NEGOCIO || 1);

/**
 * El próximo número de factura de un talonario.
 *
 * 🪤 IM **no asigna el correlativo de las facturas**. Probado el 07/09/2026: mandar `numero: 0`
 * —que es lo que funciona en presupuestos y remitos— da *"Ya existe una factura con los
 * siguientes datos: tipo_factura [B], punto_de_venta [777], numero: [0]"*, y omitir el campo
 * es lo mismo (lo toma como 0). Con `null` ni siquiera pasa la validación del JSON.
 *
 * Así que hay que calcularlo. Se mira una ventana de 30 días del mismo talonario: si en ese
 * tiempo no se emitió ninguna, devuelve `null` y NO se inventa un número — arrancar una
 * numeración por las nuestras es peor que no facturar.
 */
export async function proximoNumeroFactura(
  letra: 'A' | 'B', puntoDeVenta: number, dias = 30,
): Promise<number | null> {
  const hasta = fechaArgentina();
  const desde = fechaArgentina(Date.now() - dias * 864e5);
  const ventas = await fetchVentas(desde, hasta);
  const nums = ventas
    .filter((v: any) =>
      String(v.tipo_comprobante ?? '').trim() === 'FA' &&
      String(v.tipo_factura ?? '').trim() === letra &&
      Number(v.punto_de_venta) === puntoDeVenta)
    .map((v: any) => Number(v.numero))
    .filter((n) => Number.isFinite(n));
  if (!nums.length) return null;
  return Math.max(...nums) + 1;
}

function interpretar(data: any, tipo: string): ResultadoEmision {
  const v = data?.venta ?? data?.remito ?? data;
  // La regla de oro de IM: 200 con el error adentro. Éxito real = isCreated o un id.
  if (data?.isCreated === true || v?.id) {
    return { ok: true, id: String(v?.id ?? data?.id ?? ''), numero: v?.numero ?? data?.numero ?? null, tipo, raw: data };
  }
  const msg = data?.detalles ?? data?.mensaje ?? 'IM no confirmó la emisión (sin isCreated)';
  return { ok: false, error: typeof msg === 'string' ? msg : JSON.stringify(msg), raw: data };
}

function comoError(err: any): ResultadoEmision {
  const raw = err?.response?.data;
  const detalle = raw?.detalles ?? raw?.mensaje ?? err?.message ?? 'unknown';
  return {
    ok: false,
    error: `HTTP ${err?.response?.status ?? '?'}: ${typeof detalle === 'string' ? detalle : JSON.stringify(detalle)}`,
    // Sin `response` IM nunca contestó: NO se sabe si el comprobante se emitió.
    sinRespuesta: !err?.response,
    raw,
  };
}

/** Cabecera común de factura y remito. */
function cabecera(d: DatosComprobante, fecha: string) {
  return {
    fecha,
    numero: 0,                       // IM asigna el correlativo
    id_destino: ID_DESTINO,
    cod_cliente: d.cod_cliente,
    cod_vendedor: d.cod_vendedor,
    cod_empresa: d.cod_empresa,
    usuario: d.usuario,
    usuario_fecha: fecha,
    usuario_hora: horaArgentina(),
    tag: 'S',
    moneda: 'P', cotizacion: 1, moneda_2: 'P', cotizacion_2: 1,
    observaciones: (d.observaciones ?? '').slice(0, 500),
    anulada: 'N',                    // sin esto IM lo deja en NULL y no pasa los filtros
    fac_electronica: 0,
    cod_lista_precios: d.cod_lista_precios,
    // Lo único que IM guarda de nuestro lado: el presupuesto del que salió.
    cod_compatibilidad: String(d.origen_id ?? '').slice(0, 8),
  };
}

function renglones(items: ItemAFacturar[]) {
  return items.map((it) => ({
    cod_articulo: it.cod_articulo,
    cantidad: it.cantidad,
    precio: it.precio,
    iva_por: it.iva_por ?? 0,
    cod_cuenta: Number(CUENTA_VENTA),
    // 🪤 Sin esto IM rechaza: "La cuenta de venta [4100002] del artículo [N] no tiene unidad
    // de negocio" — la cuenta la tiene en 0 en el plan de cuentas.
    cod_unidad_negocio: UNIDAD_NEGOCIO,
    ...(it.cod_lista_precios != null ? { cod_lista_precios: it.cod_lista_precios } : {}),
    ...(it.descuento_porc ? { descuento_porc: it.descuento_porc } : {}),
  }));
}

/**
 * POST /ventas — emite la FACTURA.
 *
 * 🪤 La letra sale de la condición de IVA del cliente y **no tiene default**: si no se puede
 * determinar, no se emite nada.
 */
export async function emitirFactura(d: DatosComprobante): Promise<ResultadoEmision> {
  const letra = letraDeFactura(d.categoria_iva);
  if (!letra) {
    return { ok: false, error: `No se puede saber qué letra de factura le corresponde al cliente ${d.cod_cliente} (condición de IVA: ${d.categoria_iva ?? 'sin cargar'}). Facturalo a mano.` };
  }
  // El número lo calculamos nosotros: IM no lo asigna (ver proximoNumeroFactura). Se puede
  // pasar ya calculado para no consultarlo una vez por factura al facturar una hoja entera.
  let numero = d.numero ?? await proximoNumeroFactura(letra, PTO_VENTA_FACTURA);
  if (numero == null) {
    return { ok: false, error: `No pude averiguar el próximo número de factura ${letra} del punto de venta ${PTO_VENTA_FACTURA}: no hay ninguna emitida en los últimos 30 días. Facturá a mano.` };
  }

  const fecha = fechaArgentina();
  const cli = await imClient();
  // 🔑 Hasta 3 intentos subiendo el número. La oficina puede estar facturando desde IM al
  // mismo tiempo y quedarse con el correlativo; IM valida la unicidad y contesta "Ya existe
  // una factura...", así que un choque se resuelve con el siguiente número, no duplicando.
  for (let intento = 0; intento < 3; intento++) {
    const payload = {
      ...cabecera(d, fecha),
      tipo_comprobante: 'FA',
      tipo_factura: letra,
      numero,
      punto_de_venta: PTO_VENTA_FACTURA,
      condicion_venta_tipo: 2,        // 2 = cuenta corriente
      no_grabado: 0,
      cod_deposito: d.cod_deposito ?? 1,
      items: renglones(d.items),
    };
    try {
      const { data } = await cli.post('/ventas', payload);
      const r = interpretar(data, `FA ${letra}`);
      // 🪤 El "ya existe" viene como 200 con el error adentro: hay que leerlo del texto.
      if (!r.ok && /ya existe una factura/i.test(r.error) && intento < 2) { numero += 1; continue; }
      return r.ok ? { ...r, numero: r.numero ?? numero } : r;
    } catch (err: any) {
      const e = comoError(err);
      if (!e.ok && /ya existe una factura/i.test(e.error) && intento < 2) { numero += 1; continue; }
      return e;
    }
  }
  return { ok: false, error: `No se pudo emitir la factura ${letra}: el número ${numero} y los dos siguientes ya estaban usados.` };
}

/**
 * POST /remitos — emite el REMITO, que es lo que después viaja en la hoja de ruta.
 *
 * ⚠️ `mueve_stock: 'S'` descuenta stock de verdad. Anularlo lo devuelve.
 */
export async function emitirRemito(d: DatosComprobante): Promise<ResultadoEmision> {
  const fecha = fechaArgentina();
  const payload = {
    ...cabecera(d, fecha),
    fecha_entrega: fecha,
    tipo_comprobante: 'RE',
    tipo_factura: 'X',
    punto_de_venta: PTO_VENTA_REMITO,
    // 🪤 En remitos sólo vale 'A' (automático) o 'M'. Con 'N' —lo que usan los presupuestos—
    // IM contesta "Talonario manual no válido".
    talonario_manual: 'A',
    mueve_stock: 'S',
    cod_deposito: d.cod_deposito ?? 1,
    total: d.total, neto: d.total,
    iva_importe: 0, importe_iva_10_5: 0, importe_iva_27: 0,
    cod_unidad_negocio_cab: 0, numero_cai: 0,
    cod_jurisdiccion: 0, cod_jurisdiccion_comerc: 0, genero_re_auto: 'N',
    items: renglones(d.items),
  };
  try {
    const cli = await imClient();
    const { data } = await cli.post('/remitos', payload);
    return interpretar(data, 'RE');
  } catch (err: any) {
    return comoError(err);
  }
}
