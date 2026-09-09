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
 * Punto de venta de las notas de crédito. Verificado en `GET /puntos-de-venta` el 08/09/2026:
 * los comprobantes 41 (NC A) y 42 (NC B) de la empresa 1 con `id_destino: 1` salen por el 777,
 * el mismo de las facturas. Va en su propia variable para poder corregirlo sin deploy.
 */
const PTO_VENTA_NC = Number(process.env.IM_PTO_VENTA_NC || 777);
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
    observaciones: (d.observaciones ?? '').slice(0, 500),
    anulada: 'N',                    // sin esto IM lo deja en NULL y no pasa los filtros
    fac_electronica: 0,
    cod_lista_precios: d.cod_lista_precios,
    // Lo único que IM guarda de nuestro lado: el presupuesto del que salió.
    cod_compatibilidad: String(d.origen_id ?? '').slice(0, 8),
  };
}

/**
 * 🔴 EL VENDEDOR VA EN CADA RENGLÓN, no sólo en la cabecera.
 *
 * Mati (09/09/2026): *"tiene que figurar ítem por ítem el vendedor, eso es importantísimo porque
 * después la aplicación toma quién es el que hizo la venta"*. Verificado contra IM ese día: lo
 * que factura la oficina desde las pantallas de IM trae el vendedor repetido en cada renglón
 * (FA 50362 y RE 77298 → `cod_vendedor: 12` arriba Y en los items), y lo nuestro traía 0.
 *
 * 🪤 Va como STRING: así lo declara `VentasItemsCrear` en el swagger de IM.
 */
function renglones(items: ItemAFacturar[], codVendedor: number) {
  return items.map((it) => ({
    cod_vendedor: String(codVendedor),
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
      observaciones: (d.observaciones ?? '').slice(0, 500),
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
       * 🪤 NO está en el schema `VentasRemitosMasivo` del swagger, igual que el `cod_vendedor` de
       * los renglones. Se manda porque el remito tiene que decir de quién es la venta y IM ignora
       * lo que no conoce: sin esto, todo remito forzado por stock negativo salía sin vendedor.
       */
      cod_vendedor: d.cod_vendedor,
    }],
    items: d.items.map((it) => {
      // 🪤 NETO: este endpoint no aplica el descuento (ver arriba).
      const desc = Number(it.descuento_porc) || 0;
      const neto = Number(it.precio) * (1 - desc / 100);
      return {
        id_comprobante_aux: 1,
        cod_vendedor: String(d.cod_vendedor),
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
    const ventas = await fetchVentas(fecha, fecha);
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
  const letra = letraDeFactura(d.categoria_iva);
  if (!letra) {
    return { ok: false, error: `No se puede saber qué letra de nota de crédito le corresponde al cliente ${d.cod_cliente} (condición de IVA: ${d.categoria_iva ?? 'sin cargar'}). Hacela a mano.` };
  }
  let numero = d.numero ?? await proximoNumeroFactura(letra, PTO_VENTA_FACTURA, 30, 'NC');
  if (numero == null) {
    return { ok: false, error: `No pude averiguar el próximo número de nota de crédito ${letra} del punto ${PTO_VENTA_FACTURA}: no hay ninguna emitida en los últimos 30 días. Hacela a mano.` };
  }

  const fecha = fechaPedida(d);
  const cli = await imClient();
  // Mismo criterio que la factura: si otro tomó el número mientras tanto, se sube al siguiente.
  for (let intento = 0; intento < 3; intento++) {
    const payload = {
      ...cabecera(d, fecha),
      tipo_comprobante: 'NC',
      tipo_factura: letra,
      numero,
      punto_de_venta: PTO_VENTA_NC,
      condicion_venta_tipo: 2,
      talonario_manual: 'S',
      mueve_stock: 'N',
      no_grabado: 0,
      cod_deposito: d.cod_deposito ?? 1,
      cod_unidad_negocio_cab: 0,
      genero_re_auto: NC_GENERO_RE_AUTO,
      // 🪤 La NC NO puede llevar el `cod_compatibilidad` del presupuesto: ya lo usó la factura, y
      // IM rechaza un código repetido incluso contra comprobantes anulados. El vínculo con la
      // hoja vive en `hojas_ruta_ajustes` y, para leerlo desde IM, en las observaciones.
      cod_compatibilidad: '',
      items: renglones(d.items, d.cod_vendedor),
    };
    try {
      const { data } = await cli.post('/ventas', payload);
      const r = interpretar(data, `NC ${letra}`);
      // 🪤 Sólo se reintenta cuando el choque es de NUMERACIÓN. Un "ya existe" por otra cosa
      // (por ejemplo un cod_compatibilidad repetido) haría subir el número tres veces y
      // terminar diciendo "el número y los dos siguientes ya estaban usados", que sería falso.
      if (!r.ok && /ya existe una nota/i.test(r.error) && intento < 2) { numero += 1; continue; }
      return r.ok ? { ...r, numero: r.numero ?? numero } : r;
    } catch (err: any) {
      const e = comoError(err);
      if (!e.ok && /ya existe una nota/i.test(e.error) && intento < 2) { numero += 1; continue; }
      return e;
    }
  }
  return { ok: false, error: `No se pudo emitir la nota de crédito ${letra}: el número ${numero} y los dos siguientes ya estaban usados.` };
}
