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
import { imClient, fetchVentas, fetchVentasParaNumeracion, fechaArgentina, horaArgentina } from './infomanager.js';

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

/**
 * 🔗 CÓMO MARCA INFOMANAGER QUE UN REMITO ES DE UNA FACTURA.
 *
 * Mati (09/09/2026): *"no se están asociando los comprobantes entre sí... si queremos hacer una
 * nota de crédito el sistema te pide que esté asociada a la factura porque tiene que ver con el
 * movimiento de mercadería. Tenemos un recuadro en las ventanas que cuando está asociado se hace
 * un tilde, y no se está haciendo"*.
 *
 * Leído de un remito REAL que generó IM (el 77298, de la factura 50362): el vínculo lo escribe
 * **en las observaciones**, con el id INTERNO de la factura:
 *
 *   observaciones: " [Remito Automático -FA:58764473]"
 *
 * 🪤 No hay ningún campo para esto: `VentasRemitosCrear` no tiene uno, `/comprobantes-relacion`
 * es de sólo lectura, y `genero_re_auto: 'S'` —que es lo que dispara el remito automático desde
 * la pantalla de IM— la API lo DESCARTA (probado el 09/09/2026: se manda 'S' y queda 'N').
 * Así que se replica la convención de IM, que es lo único que queda escrito del vínculo.
 */
export function marcaDeFactura(idFactura: string | number | null | undefined): string {
  const id = String(idFactura ?? '').trim();
  return id ? ` [Remito Automático -FA:${id}]` : '';
}

export interface DatosComprobante {
  /**
   * 🔑 Con qué fecha se emite. Mati (09/09/2026): *"necesitamos poder cambiar la fecha cuando se
   * va a facturar"* — la oficina factura pedidos de días anteriores y el comprobante tiene que
   * llevar esa fecha, no la de hoy. Sin esto, el reparto del lunes salía facturado el miércoles.
   */
  fecha?: string | null;
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
  /**
   * 🔗 El id INTERNO en IM de la factura de la que sale este remito. Va a las observaciones con
   * la misma convención que usa InfoManager (ver `marcaDeFactura`), que es lo único que deja
   * escrito el vínculo entre los dos comprobantes.
   */
  im_factura_id?: string | number | null;
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
/**
 * 🔴 PUNTO DE VENTA DE LAS NOTAS DE CRÉDITO Y DÉBITO: EL 999, NO EL 777 DE LAS FACTURAS.
 *
 * IM valida la unicidad del número **sin mirar el tipo de comprobante**. Como cada tipo lleva su
 * propia serie y la de facturas B va por 50.422 mientras la de NC B va por 30.073, cada NC choca
 * contra una factura vieja del mismo número. Probado contra IM el 08 y el 09/09/2026:
 *
 *   NC B pv777 numero 0      -> ✗ "Ya existe una factura con ... numero = 30073"
 *   NC B pv777 numero 30073  -> ✗ el mismo error (no es el número que mandamos)
 *   ND B pv777 numero 0      -> ✗ "... numero = 742"
 *   **NC B pv999 destino 3** -> ✅ sale, y ahí IM sí le asigna el número solo
 *   **ND B pv999 destino 3** -> ✅ sale igual
 *
 * ⚠️ Emitir por otra serie es una DECISIÓN DE NEGOCIO, no técnica: es otro punto de venta ante
 * AFIP. Se le planteó así a Mati el 09/09/2026 y la tomó él (*"usemos ese punto de venta, no hay
 * problema"*). Queda en variables de entorno para volver al 777 sin deploy el día que Sistec
 * arregle la validación — y ese día `IM_NUMERO_NC_AUTO` vuelve a 0.
 */
const PTO_VENTA_NC = Number(process.env.IM_PTO_VENTA_NC || 999);
/**
 * 🪤 El destino va atado al punto de venta: la combinación empresa+comprobante+destino+pv tiene
 * que EXISTIR en `/puntos-de-venta` o IM contesta "no está relacionado a un punto de venta
 * existente". El 999 de la empresa 1 es destino 3; el 777 es destino 1.
 */
const ID_DESTINO_NC = Number(process.env.IM_ID_DESTINO_NC || (PTO_VENTA_NC === 999 ? 3 : 1));
/**
 * En el 999 IM asigna el correlativo solo con `numero: 0` (probado: NC B nº2, ND B nº1). En el
 * 777 no, y ahí hay que calcularlo. Con la variable en 0 se usa el camino de calcular.
 */
const NUMERO_NC_AUTO = String(process.env.IM_NUMERO_NC_AUTO ?? '1') === '1';
/**
 * ⚠️ La NC real de la oficina viene con `genero_re_auto: 'S'`, pero esa la creó la pantalla de
 * IM, no la API. El remito y el presupuesto —los dos verificados por API— mandan 'N', y una 'S'
 * podría hacer que IM intente generar un remito automático y falte el punto de venta. Se manda
 * 'N' por prudencia, en una variable para cambiarlo sin deploy si IM se queja.
 */
const NC_GENERO_RE_AUTO = process.env.IM_NC_GENERO_RE_AUTO || 'N';
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
  letra: 'A' | 'B', puntoDeVenta: number, dias = 30, tipo: 'FA' | 'NC' | 'ND' = 'FA',
): Promise<number | null> {
  // 🪤 `hasta` mira ADELANTE (ver DIAS_ADELANTE_REMITO): la oficina factura hoy el reparto de
  // mañana, y esas facturas ya tienen número.
  const hasta = fechaArgentina(Date.now() + DIAS_ADELANTE_REMITO * 864e5);
  const maxDe = async (diasAtras: number): Promise<number | null> => {
    const ventas = await fetchVentasParaNumeracion(fechaArgentina(Date.now() - diasAtras * 864e5), hasta);
    const nums = ventas
      .filter((v: any) =>
        String(v.tipo_comprobante ?? '').trim() === tipo &&
        String(v.tipo_factura ?? '').trim() === letra &&
        Number(v.punto_de_venta) === puntoDeVenta)
      .map((v: any) => Number(v.numero))
      .filter((n) => Number.isFinite(n));
    return nums.length ? Math.max(...nums) + 1 : null;
  };
  /**
   * ⏱️ Primero la ventana corta. Medido contra IM el 09/09/2026: 30 días son 58.119 filas y
   * **31 s**; 7 días son 14.118 y **5 s**. Y esto es lo PRIMERO que corre al apretar Facturar,
   * así que esa espera la mira la oficina. La oficina factura todos los días, o sea que en una
   * semana siempre hay comprobantes del talonario; la ventana larga queda para el caso raro
   * (talonario nuevo, feriados) y es el único que paga los 31 s.
   */
  return (await maxDe(Math.min(DIAS_BUSQUEDA_CORTA, dias))) ?? (dias > DIAS_BUSQUEDA_CORTA ? await maxDe(dias) : null);
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
/**
 * La fecha con la que se emite: la que mandó la pantalla, o hoy.
 *
 * 🪤 Se valida el formato acá y no en el handler: esto lo llaman tres emisiones distintas y una
 * fecha inventada sale impresa en un comprobante fiscal.
 */
function fechaPedida(d: DatosComprobante): string {
  const f = String(d.fecha ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(f) ? f : fechaArgentina();
}

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
    observaciones: ((d.observaciones ?? '') + marcaDeFactura(d.im_factura_id)).slice(0, 500),
    anulada: 'N',                    // sin esto IM lo deja en NULL y no pasa los filtros
    fac_electronica: 0,
    cod_lista_precios: d.cod_lista_precios,
    // Lo único que IM guarda de nuestro lado: el presupuesto del que salió.
    cod_compatibilidad: String(d.origen_id ?? '').slice(0, 8),
  };
}

/**
 * 🔴 EL VENDEDOR VA EN LA CABECERA, **NO** EN LOS RENGLONES. Es contraintuitivo: acá está por qué.
 *
 * Mati (09/09/2026) pidió que figurara *"ítem por ítem el vendedor, porque después la aplicación
 * toma quién es el que hizo la venta"*. Se probó, y por la API de IM **no se puede tener los
 * dos** — cinco comprobantes de prueba ese día (cliente 1093, todos anulados):
 *
 *   · FA con `cod_vendedor` en los renglones -> items ✅ · **cabecera queda en 0** ❌
 *   · FA sin vendedor en los renglones       -> items ✘ · cabecera ✅
 *   · FA con vendedor en renglones + `PUT /ventas/{id}` con `cod_vendedor` después
 *                                            -> el PUT contesta "se actualizó correctamente"
 *                                               y la cabecera SIGUE en 0 (no está en
 *                                               `VentasActualizar`) ❌
 *   · RE con vendedor en los renglones (texto o número) -> lo ignora, items en 0; cabecera ✅
 *   · RE masivo, vendedor en cabecera        -> lo ignora, queda en 0 ❌ (no hay forma)
 *
 * Y el desempate lo da nuestro propio código: `comisiones.ts` arma el vendedor de cada
 * comprobante desde **la cabecera** (`cabPorId`, línea ~156), y un 0 lo trata como mostrador y lo
 * descarta. O sea que mandarlo en los renglones dejaba la cabecera en 0 y **la venta sin comisión
 * para nadie**. Entre "se ve lindo en la pantalla de IM" y "el vendedor cobra", gana la cabecera.
 *
 * ⚠️ Lo que hace la oficina desde las pantallas de IM sí tiene las dos cosas (FA 50362 y RE 77298
 * con `cod_vendedor: 12` arriba y abajo). Esa pantalla escribe la base directo; la API no lo
 * expone. Para tenerlo por API hay que pedírselo a Sistec.
 */
function renglones(items: ItemAFacturar[], _codVendedor: number) {
  return items.map((it) => ({
    // 🔴 Siempre un artículo del catálogo: `cod_articulo` es int64 obligatorio en el schema de
    // facturas y remitos. `""` no deserializa y `0` no existe (probado el 09/09/2026). Los
    // renglones sin artículo se filtran ANTES, en facturarPresupuestos.
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
/**
 * 🔴 LOS CAMPOS AFIP DE LA FACTURA. Sin ellos IM la imprime como comprobante FISCAL.
 *
 * Mati (09/09/2026): *"quisimos imprimir una de las facturas generadas por la app y nos lleva
 * directamente a imprimir un comprobante fiscal desde InfoManager... nosotros no pasamos por
 * AFIP, lo declaramos por otro lado. Fijate en los comprobantes anteriores y replicá eso"*.
 *
 * Comparadas las 75 facturas B del punto 777 hechas en IM contra las 23 del panel, la diferencia
 * era exactamente ésta: las de IM traen los cuatro campos cargados y las nuestras en null/0.
 * Verificado que la API SÍ los guarda (están en el schema `VentasCrear`).
 *
 * | comprobante | comprobantes_fe | conceptos | tipdoc | cond_vta |
 * |-------------|-----------------|-----------|--------|----------|
 * | FA A        | "1"             | 1         | 96     | 1 ó 4    |
 * | FA B        | "6"             | 1         | 96     | 1 ó 4    |
 * | NC / ND / RE| ""              | 0 ó 1     | 0      | 0        |
 *
 * `cond_vta` sigue a `condicion_venta_tipo`: 1 (contado) → 1, 2 (cuenta corriente) → 4.
 *
 * ⚠️ `talonario_manual: 'S'` —que también tienen las de IM— NO se puede mandar: no está en el
 * schema de creación ni en el de actualización, y probado el 09/09/2026 IM lo descarta en
 * silencio. Si con los campos AFIP no alcanza, eso hay que pedírselo a Sistec.
 */
function camposAfip(letra: 'A' | 'B', condicionVenta: number) {
  return {
    afip_comprobantes_fe: letra === 'A' ? '1' : '6',
    afip_conceptos_fe: 1,        // 1 = productos
    afip_tipdoc_fe: 96,          // 96 = DNI, que es lo que usan todas las de la oficina
    afip_cond_vta: condicionVenta === 2 ? 4 : 1,
    afip_cod_barra: '',
  };
}

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

  const fecha = fechaPedida(d);
  const cli = await imClient();
  /**
   * 🔑 Hasta 10 intentos subiendo el número. La oficina puede estar facturando desde IM al mismo
   * tiempo y quedarse con el correlativo; IM valida la unicidad y contesta "Ya existe una
   * factura...", así que un choque se resuelve con el siguiente número, no duplicando.
   *
   * 🪤 Eran 3 y NO ALCANZARON: el 09/09/2026 había 4 facturas seguidas fechadas para mañana y
   * PASTERIS se quedó sin facturar. Cada intento es una request, así que el tope existe — pero
   * tiene que cubrir un día entero de reparto adelantado.
   */
  const INTENTOS = 10;
  // Ya se sabe que no es null (el guard de arriba); TypeScript lo pierde dentro del closure.
  let num: number = numero;
  // Los renglones que se mandan: se les puede sacar la lista a los que IM rechace (ver abajo).
  let items = renglones(d.items, d.cod_vendedor);
  for (let intento = 0; intento < INTENTOS; intento++) {
    const payload = {
      ...cabecera(d, fecha),
      tipo_comprobante: 'FA',
      tipo_factura: letra,
      numero: num,
      punto_de_venta: PTO_VENTA_FACTURA,
      condicion_venta_tipo: 2,        // 2 = cuenta corriente
      no_grabado: 0,
      cod_deposito: d.cod_deposito ?? 1,
      // Sin esto IM la imprime como comprobante fiscal (ver camposAfip).
      ...camposAfip(letra, 2),
      items,
    };
    /** Un solo lugar para decidir si el rechazo se reintenta y cómo. */
    const reintentar = (error: string): boolean => {
      if (esChoqueDeNumero(error)) { num += 1; return true; }
      const art = articuloFueraDeLista(error);
      if (art != null) { items = sinListaDelArticulo(items, art); return true; }
      return false;
    };
    try {
      const { data } = await cli.post('/ventas', payload);
      const r = interpretar(data, `FA ${letra}`);
      // 🪤 El "ya existe" viene como 200 con el error adentro: hay que leerlo del texto.
      if (!r.ok && intento < INTENTOS - 1 && reintentar(r.error)) continue;
      return r.ok ? { ...r, numero: r.numero ?? num } : r;
    } catch (err: any) {
      const e = comoError(err);
      if (!e.ok && intento < INTENTOS - 1 && reintentar(e.error)) continue;
      return e;
    }
  }
  return { ok: false, error: `No se pudo emitir la factura ${letra}: los ${INTENTOS} números desde el ${num - INTENTOS + 1} ya estaban usados.` };
}

/**
 * POST /remitos — emite el REMITO, que es lo que después viaja en la hoja de ruta.
 *
 * ⚠️ `mueve_stock: 'S'` descuenta stock de verdad. Anularlo lo devuelve.
 */
export async function emitirRemito(d: DatosComprobante): Promise<ResultadoEmision> {
  const fecha = fechaPedida(d);
  const payload = {
    ...cabecera(d, fecha),
    fecha_entrega: fecha,
    tipo_comprobante: 'RE',
    tipo_factura: 'X',
    punto_de_venta: PTO_VENTA_REMITO,
    // 🪤 En remitos sólo vale 'A' (automático) o 'M'. Con 'N' —lo que usan los presupuestos—
    // IM contesta "Talonario manual no válido".
    talonario_manual: 'A',
    /**
     * 🪤 `mueve_stock: 'S'` descuenta stock y ES LO QUE DISPARA LA VALIDACIÓN de este endpoint: si
     * a algún artículo no le alcanza, IM rechaza el remito entero. Cuando pasa eso, quien llama
     * reintenta por `emitirRemitoMasivo`, que sí lo deja salir (y descuenta igual).
     */
    mueve_stock: 'S',
    cod_deposito: d.cod_deposito ?? 1,
    total: d.total, neto: d.total,
    iva_importe: 0, importe_iva_10_5: 0, importe_iva_27: 0,
    cod_unidad_negocio_cab: 0, numero_cai: 0,
    cod_jurisdiccion: 0, cod_jurisdiccion_comerc: 0, genero_re_auto: 'N',
    items: renglones(d.items, d.cod_vendedor),
  };
  const cli = await imClient();
  // 🪤 Igual que la factura: si un artículo no está en la lista del pedido —el COSTO DE
  // DISTRIBUCION no está en ninguna— se le saca la lista a ese renglón y se reintenta. Sin esto
  // la factura salía y el remito quedaba colgado, que es el peor de los dos estados.
  for (let intento = 0; intento < 3; intento++) {
    try {
      const { data } = await cli.post('/remitos', payload);
      const r = interpretar(data, 'RE');
      const art = r.ok ? null : articuloFueraDeLista(r.error);
      if (art != null && intento < 2) { payload.items = sinListaDelArticulo(payload.items, art); continue; }
      return r;
    } catch (err: any) {
      const e = comoError(err);
      const art = e.ok ? null : articuloFueraDeLista(e.error);
      if (art != null && intento < 2) { payload.items = sinListaDelArticulo(payload.items, art); continue; }
      return e;
    }
  }
  return { ok: false, error: 'No pude emitir el remito: InfoManager sigue rechazando artículos por la lista de precios.' };
}

/**
 * Cuántos días HACIA ADELANTE mira la búsqueda del próximo número, de facturas y de remitos.
 *
 * 🔴 LA NUMERACIÓN NO SIGUE A LA FECHA, y esto rompió LAS DOS COSAS el 09/09/2026. La oficina
 * factura hoy el reparto de MAÑANA, así que los comprobantes salen con la fecha de mañana y una
 * ventana que termina hoy no los ve: devuelve un número ya usado.
 *
 *  · Remitos: el 77377 y el 77378 estaban fechados el 10/09. El masivo salió con el 77377, IM
 *    contestó *"El número de comprobante [77377] ya existe para el punto de venta [7] y empresa
 *    [1]"* y LEAL y DIAZ quedaron con la factura emitida y sin remito.
 *  · Facturas: las B 50403 a 50406 del punto 777 también estaban fechadas el 10/09 — las había
 *    emitido este mismo panel. Se proponía la 50403 y los tres intentos chocaban; PASTERIS no se
 *    pudo facturar y el mensaje era *"Ya existe una factura ... numero: [50405]"*.
 *
 * O sea que cada comprobante que emitíamos para mañana se escondía de nuestro propio contador.
 */
const DIAS_ADELANTE_REMITO = Number(process.env.IM_DIAS_ADELANTE_REMITO || 30);

/**
 * ⏱️ Cuántos días hacia atrás se miran ANTES de abrir la ventana larga.
 *
 * `fetchVentas` cuesta proporcional al rango: 7 días son ~5 s y 30 días ~31 s (medido contra IM
 * el 09/09/2026). Buscar el próximo número es lo primero que pasa al apretar Facturar.
 */
const DIAS_BUSQUEDA_CORTA = 7;

/**
 * El próximo número del talonario de REMITOS. Igual que las facturas, IM no lo asigna en el
 * endpoint masivo: `numero: 0` da *"El número de comprobante [0] debe ser un número mayor que 0"*.
 *
 * 🪤 La ventana va de `dias` atrás a `DIAS_ADELANTE_REMITO` adelante (ver arriba). Aun así el
 * número puede estar tomado —la oficina emite desde IM al mismo tiempo—, y por eso quien lo usa
 * reintenta con el siguiente.
 */
export async function proximoNumeroRemito(puntoDeVenta: number, dias = 7): Promise<number | null> {
  const ventas = await fetchVentasParaNumeracion(
    fechaArgentina(Date.now() - dias * 864e5),
    fechaArgentina(Date.now() + DIAS_ADELANTE_REMITO * 864e5),
  );
  const nums = ventas
    .filter((v: any) =>
      String(v.tipo_comprobante ?? '').trim() === 'RE' && Number(v.punto_de_venta) === puntoDeVenta)
    .map((v: any) => Number(v.numero))
    .filter((n) => Number.isFinite(n));
  return nums.length ? Math.max(...nums) + 1 : null;
}

/**
 * Qué artículo rechazó IM por no estar en la lista de precios, o `null` si el error es otro.
 *
 * 🪤 IM contesta *"El artículo código [13819] no pertenece a la lista de precios [13]"*. Pasa con
 * el COSTO DE DISTRIBUCION, que no pertenece a ninguna lista: el renglón se guarda con la lista
 * que estaba abierta en el editor, `/presupuestos` lo acepta y `/ventas` lo rechaza. NAVARRO
 * (PR 58317) se quedó sin facturar así el 09/09/2026.
 */
function articuloFueraDeLista(error: string): number | null {
  const m = String(error).match(/art[ií]culo c[óo]digo \[(\d+)\][^.]*no pertenece a la lista de precios/i);
  return m ? Number(m[1]) : null;
}

/**
 * Los mismos renglones, pero sin `cod_lista_precios` en el que IM rechazó.
 *
 * Se le saca la lista SÓLO a ese: el resto la conserva. El precio va explícito en el renglón, así
 * que sacarla no cambia lo que se factura — la lista es el dato de dónde salió ese precio.
 */
function sinListaDelArticulo(items: any[], codArticulo: number): any[] {
  return items.map((it) => {
    if (Number(it.cod_articulo) !== codArticulo) return it;
    const { cod_lista_precios, ...resto } = it;
    return resto;
  });
}

/** ¿IM rechazó por número repetido? Es lo único que se reintenta subiendo el correlativo. */
function esChoqueDeNumero(error: string): boolean {
  return /n[uú]mero de comprobante \[\d+\] ya existe|ya existe una factura/i.test(String(error));
}

/**
 * POST /remitos/masivo — EL REMITO QUE SALE AUNQUE EL STOCK ESTÉ EN NEGATIVO.
 *
 * 🔑 Mati (09/09/2026): *"necesito por favor que se remita la mercadería aunque esté en negativo"*.
 * `POST /remitos` no lo permite: valida stock y rechaza el remito entero. Se probaron cinco
 * caminos contra IM con un artículo en −570 (todos los comprobantes anulados después):
 *
 *   · `/remitos` normal              -> ❌ rechaza · descuenta cuando hay
 *   · `/remitos` con mueve_stock 'N' -> ✅ sale · ✘ NO descuenta
 *   · `/ventas` con tipo RE          -> ✅ sale · ✘ NO descuenta (ignora mueve_stock)
 *   · talonario 'M' con nº propio    -> ❌ rechaza (no era el talonario)
 *   · **`/remitos/masivo`**          -> ✅ SALE · ✅ DESCUENTA (−570 quedó en −571)
 *
 * Este endpoint ni siquiera expone `mueve_stock`: IM lo crea con 'S' por su cuenta y no valida.
 * Es el mismo remito, con el mismo talonario y el mismo punto de venta.
 *
 * 🪤 DOS TRAMPAS, las dos verificadas:
 *  1. **No aplica `descuento_porc`**: lo guarda escrito pero calcula el importe con el precio
 *     entero. Un renglón con 35% salía por 89.894,68 en vez de 58.431,54, y el remito terminaba
 *     por MÁS que su factura. Por eso acá va el precio NETO y el descuento en cero.
 *  2. **Contesta 200 con el body VACÍO**: no devuelve ni id ni número. Hay que ir a buscar el
 *     remito por su número, y si no aparece se dice que no se sabe — no se inventa un id.
 */
export async function emitirRemitoMasivo(d: DatosComprobante): Promise<ResultadoEmision> {
  const fecha = fechaPedida(d);
  let numero = await proximoNumeroRemito(PTO_VENTA_REMITO);
  if (numero == null) {
    return { ok: false, error: `No pude averiguar el próximo número de remito del punto ${PTO_VENTA_REMITO}: no hay ninguno emitido en la última semana. Hacelo a mano.` };
  }
  const cuerpoCon = (num: number) => ({
    cabecera: [{
      id_aux: 1,
      punto_de_venta: PTO_VENTA_REMITO,
      numero: num,
      fecha,
      cod_cliente: d.cod_cliente,
      observaciones: ((d.observaciones ?? '') + marcaDeFactura(d.im_factura_id)).slice(0, 500),
      // Lo único que queda del lado de IM apuntando al presupuesto: el masivo no tiene
      // `cod_compatibilidad`, así que el origen viaja acá.
      observaciones_aux: String(d.origen_id ?? '').slice(0, 500),
      cotizacion: 1,
      tag: 'S',
      cod_deposito: d.cod_deposito ?? 1,
      usuario: d.usuario,
      cod_empresa: d.cod_empresa,
      cod_transporte: 0,
      cod_origen_sistema: 0,
      /**
       * ⚠️ IM LO IGNORA: no está en el schema `VentasRemitosMasivo` y el remito queda con vendedor
       * 0 igual (probado el 09/09/2026, remito 77393 anulado). Se manda porque no cuesta nada y
       * el día que Sistec lo acepte funciona solo. El remito forzado por stock negativo es, por
       * ahora, el único comprobante del circuito que sale sin vendedor — no afecta comisiones,
       * que se calculan sobre facturas y notas de crédito.
       */
      cod_vendedor: d.cod_vendedor,
    }],
    items: d.items.map((it) => {
      // 🪤 NETO: este endpoint no aplica el descuento (ver arriba).
      const desc = Number(it.descuento_porc) || 0;
      const neto = Number(it.precio) * (1 - desc / 100);
      return {
        id_comprobante_aux: 1,
        cod_articulo: it.cod_articulo,
        cantidad: it.cantidad,
        cant_uni_venta: 0,
        precio: Math.round(neto * 10000) / 10000,
        descuento_porc: 0,
        detalle: '',
        detalle_aux: '',
      };
    }),
  });

  /**
   * 🔑 Hasta 5 intentos subiendo el número, igual que las facturas. El correlativo lo calculamos
   * nosotros y la oficina emite remitos desde IM al mismo tiempo, así que un choque es normal;
   * lo que NO puede pasar es que el pedido se quede sin remito por eso. Verificado el 09/09/2026:
   * los números 77377 a 77381 estaban tomados de una sola vez, por eso 5 y no 3.
   */
  const cli = await imClient();
  for (let intento = 0; ; intento++) {
    try {
      await cli.post('/remitos/masivo', cuerpoCon(numero));
      break;
    } catch (err: any) {
      const e = comoError(err);
      // 🪤 `sinRespuesta` NO se reintenta: sin respuesta de IM el remito puede haber salido igual
      // y el reintento emitiría un segundo remito por la misma mercadería.
      if (!e.ok && !e.sinRespuesta && esChoqueDeNumero(e.error) && intento < 4) { numero += 1; continue; }
      return e;
    }
  }
  // Contestó 200 y sin cuerpo: el remito hay que ir a buscarlo para saber que existe de verdad.
  try {
    // 🪤 Sin cache: se acaba de emitir y una lista de hace un minuto no lo tendría.
    const ventas = await fetchVentas(fecha, fecha, { sinCache: true });
    const re = ventas.find((v: any) =>
      String(v.tipo_comprobante ?? '').trim() === 'RE' &&
      Number(v.punto_de_venta) === PTO_VENTA_REMITO &&
      Number(v.numero) === numero &&
      Number(v.cod_cliente) === Number(d.cod_cliente));
    if (!re) {
      return { ok: false, error: `InfoManager aceptó el remito ${numero} pero después no lo encontré. Verificalo en InfoManager antes de reintentar: puede haberse emitido igual.` };
    }
    return { ok: true, id: String((re as any).id), numero, tipo: 'RE', raw: re };
  } catch (e: any) {
    // Salió, pero no se pudo confirmar cuál. NO se reintenta a ciegas: sería un segundo remito.
    return { ok: false, error: `Se mandó el remito ${numero} pero no pude confirmarlo (${e?.message ?? 'sin respuesta de IM'}). Verificalo en InfoManager antes de reintentar.` };
  }
}

/**
 * POST /ventas — emite una NOTA DE CRÉDITO por lo que no se entregó.
 *
 * Es lo que hace la oficina cuando vuelve el repartidor: el cliente no estaba, no quiso la
 * mercadería, faltó stock. Mati (08/09/2026): *"una vez que vuelve el repartidor se hacen NC o
 * facturas por dif de mercadería y eso impacta en el num final de la hoja"*.
 *
 * 🔴 ES IRREVERSIBLE, igual que la factura: consume numeración fiscal del talonario de NC y
 * descuenta de la cuenta corriente del cliente.
 *
 * 📌 Los campos salen de una NC REAL de Casa Central (leída de IM el 08/09/2026, punto de venta
 * 777): `condicion_venta_tipo: 2`, `talonario_manual: 'S'`, `tag: 'S'`, `genero_re_auto: 'S'`,
 * `cod_unidad_negocio_cab: 0` y, en el renglón, `cod_cuenta: 4100002`.
 *
 * ⚠️ `mueve_stock: 'N'` es lo que usa la oficina en sus NC, así que se copia tal cual: la
 * mercadería que vuelve NO reingresa al stock por este camino. Es su criterio actual, no una
 * decisión nuestra — si algún día quieren que reingrese, es cambiar esta letra.
 *
 * 🪤 La API de IM **no tiene ningún campo** para relacionar la NC con su factura (verificado por
 * tres caminos el 08/09/2026). Lo que sí hace la oficina es escribirlo en las observaciones:
 * de 724 NC en 90 días, 287 dicen "SEGUN HR 3210". Se respeta esa convención —así se lee igual
 * desde IM— y además el vínculo exacto se guarda de nuestro lado.
 */
export async function emitirNotaCredito(
  d: DatosComprobante & { numero?: number | null; observaciones?: string },
): Promise<ResultadoEmision> {
  return emitirNota('NC', d);
}

/**
 * POST /ventas — emite una NOTA DE DÉBITO.
 *
 * Es la otra mitad de corregir una factura: lo que hay que cobrarle DE MÁS al cliente porque
 * faltó un producto en la factura o porque se le cargó una lista más barata de la que iba.
 * Mismo payload que la NC salvo `tipo_comprobante`, igual que la FA y la NC entre sí.
 */
export async function emitirNotaDebito(
  d: DatosComprobante & { numero?: number | null; observaciones?: string },
): Promise<ResultadoEmision> {
  return emitirNota('ND', d);
}

/**
 * El cuerpo común de las dos. Se comparte porque la única diferencia real es la letra del tipo:
 * las NC y ND reales de la oficina tienen exactamente los mismos campos.
 *
 * 🔴 ES IRREVERSIBLE: consume numeración fiscal y toca la cuenta corriente del cliente.
 *
 * 📌 Los campos salen de una NC REAL de Casa Central (leída de IM el 08/09/2026):
 * `condicion_venta_tipo: 2`, `talonario_manual: 'S'`, `tag: 'S'`, `cod_unidad_negocio_cab: 0` y,
 * en el renglón, `cod_cuenta: 4100002`.
 *
 * ⚠️ `mueve_stock: 'N'`: la mercadería que vuelve NO reingresa al stock por este camino. Es el
 * criterio actual de la oficina, copiado tal cual — si algún día quieren que reingrese, es
 * cambiar esta letra.
 *
 * 🪤 La API de IM **no tiene ningún campo** para relacionar la nota con su factura (verificado por
 * tres caminos el 08/09/2026). Lo que sí hace la oficina es escribirlo en las observaciones, así
 * que quien llama manda ahí "SEGUN FACTURA 50401" y el vínculo exacto se guarda de nuestro lado.
 */
/**
 * 🔴 LOS CAMPOS AFIP DE LA NOTA. Sin ellos IM la manda al CONTROLADOR FISCAL.
 *
 * Mati (10/09/2026): *"la NC se está generando en controlador fiscal, debería seguir la misma
 * suerte de todo el otro circuito, que no involucre a AFIP, es interno"*.
 *
 * Es el mismo problema que tuvieron las facturas el 09/09 y la misma solución: `emitirNota` no
 * mandaba ninguno de estos campos y quedaban en `null`. Leídas 45 notas de la oficina del 15/08
 * al 10/09/2026 —las que salen internas— el patrón es éste, y la única diferencia con las
 * nuestras eran justamente estos cinco campos.
 *
 * `conceptos_fe` es lo único que cambia entre las dos: 1 en las 35 NC leídas, 0 en las 4 ND.
 *
 * ⚠️ `talonario_manual` y `mueve_stock` NO son los que deciden: la factura A 1630 del panel los
 * tiene en `null` —IM los descarta al crear por API— y aun así sale interna.
 */
function camposAfipNota(tipo: 'NC' | 'ND') {
  return {
    afip_comprobantes_fe: '',
    afip_conceptos_fe: tipo === 'NC' ? 1 : 0,
    afip_tipdoc_fe: 0,
    afip_cond_vta: 0,
    afip_cod_barra: '',
  };
}

async function emitirNota(
  tipo: 'NC' | 'ND',
  d: DatosComprobante & { numero?: number | null; observaciones?: string },
): Promise<ResultadoEmision> {
  const que = tipo === 'NC' ? 'nota de crédito' : 'nota de débito';
  const letra = letraDeFactura(d.categoria_iva);
  if (!letra) {
    return { ok: false, error: `No se puede saber qué letra de ${que} le corresponde al cliente ${d.cod_cliente} (condición de IVA: ${d.categoria_iva ?? 'sin cargar'}). Hacela a mano.` };
  }
  /**
   * 🔑 En el punto 999 IM asigna el correlativo solo con `numero: 0` — probado el 09/09/2026
   * (NC B nº2, ND B nº1). En el 777 no lo asigna y hay que calcularlo, así que ese camino se
   * conserva detrás de `IM_NUMERO_NC_AUTO` para el día que se vuelva allá.
   */
  let numero = d.numero ?? (NUMERO_NC_AUTO ? 0 : await proximoNumeroFactura(letra, PTO_VENTA_NC, 30, tipo));
  if (numero == null) {
    return { ok: false, error: `No pude averiguar el próximo número de ${que} ${letra} del punto ${PTO_VENTA_NC}: no hay ninguna emitida en los últimos 30 días. Hacela a mano.` };
  }

  const fecha = fechaPedida(d);
  const cli = await imClient();
  let items = renglones(d.items, d.cod_vendedor);
  // Mismo criterio que la factura: si otro tomó el número mientras tanto, se sube al siguiente.
  for (let intento = 0; intento < 3; intento++) {
    const payload = {
      ...cabecera(d, fecha),
      // 🪤 El destino va atado al punto de venta, no al de las facturas (ver ID_DESTINO_NC).
      id_destino: ID_DESTINO_NC,
      tipo_comprobante: tipo,
      tipo_factura: letra,
      numero,
      punto_de_venta: PTO_VENTA_NC,
      // 🔴 Sin esto la nota sale por el controlador fiscal (ver camposAfipNota).
      ...camposAfipNota(tipo),
      condicion_venta_tipo: 2,
      talonario_manual: 'S',
      mueve_stock: 'N',
      no_grabado: 0,
      cod_deposito: d.cod_deposito ?? 1,
      cod_unidad_negocio_cab: 0,
      genero_re_auto: NC_GENERO_RE_AUTO,
      // 🪤 La nota NO puede llevar el `cod_compatibilidad` del presupuesto: ya lo usó la factura, y
      // IM rechaza un código repetido incluso contra comprobantes anulados. El vínculo vive de
      // nuestro lado y, para leerlo desde IM, en las observaciones.
      cod_compatibilidad: '',
      items,
    };
    /** Un solo lugar para decidir si el rechazo se reintenta y cómo. Igual que en la factura. */
    const reintentar = (error: string): boolean => {
      // 🪤 Sólo el choque de NUMERACIÓN sube el número. Un "ya existe" por otra cosa haría subir
      // tres veces y terminar diciendo "los números ya estaban usados", que sería mentira.
      if (/ya existe una nota/i.test(error)) { numero = Number(numero) + 1; return true; }
      const art = articuloFueraDeLista(error);
      if (art != null) { items = sinListaDelArticulo(items, art); return true; }
      return false;
    };
    try {
      const { data } = await cli.post('/ventas', payload);
      const r = interpretar(data, `${tipo} ${letra}`);
      if (!r.ok && intento < 2 && reintentar(r.error)) continue;
      return r.ok ? { ...r, numero: r.numero ?? numero } : r;
    } catch (err: any) {
      const e = comoError(err);
      if (!e.ok && intento < 2 && reintentar(e.error)) continue;
      return e;
    }
  }
  return { ok: false, error: `No se pudo emitir la ${que} ${letra}: InfoManager rechazó los tres intentos.` };
}
