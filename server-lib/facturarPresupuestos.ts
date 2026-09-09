/**
 * ETAPA 2 DEL CIRCUITO: facturar los presupuestos aprobados.
 *
 * Mati (08/09/2026): *"una vez que los presupuestos ya están ok, recién ahí entra la parte de
 * facturación y de ahí, con la factura y el remito hecho, se arma la hoja de ruta (es el último
 * paso)"*. Antes esto colgaba de la hoja, que es donde NO va: cuando se factura, la hoja
 * todavía no existe.
 *
 * 🔴 ES LO ÚNICO IRREVERSIBLE DE TODO EL PANEL. Una factura consume numeración fiscal y toca la
 * cuenta corriente; el remito descuenta stock. Todo acá está escrito para fallar del lado
 * seguro:
 *
 *  · **De a un pedido por vez, nunca en paralelo.** Si algo se rompe a la mitad, quedan
 *    emitidos los que ya salieron y ni uno más.
 *  · **El id se guarda APENAS se emite.** Un comprobante emitido que no quedó registrado es un
 *    comprobante que alguien va a volver a emitir.
 *  · **`sinRespuesta` FRENA TODO**: si IM no contestó, no se sabe si la factura salió, y
 *    reintentar es facturarle dos veces al mismo cliente.
 *  · **Con la factura ya emitida y el remito no, se hace SÓLO el remito.**
 *  · **Sólo se factura lo aprobado** en la etapa 1.
 *
 * 🪤 Facturar por API NO vincula el comprobante con el presupuesto en InfoManager (probado el
 * 07/09/2026): la relación la guardamos nosotros en `presupuestos_facturados`, y al final se
 * desconfirma el presupuesto para que no quede en la ventana de facturación de la oficina.
 */
import type { Request, Response } from 'express';
import { sb, TENANT_ID } from './supabase.js';
import type { JwtPayload } from './auth.js';
import { puedeArmarHojasDeRuta } from './permisos.js';
import {
  fetchVentasItems, fetchClientesIMCached, cabeceraComprobante, desconfirmarPresupuesto,
  fetchVentas, fechaArgentina, fetchStockPorDeposito, fetchArticulosCatalogo,
} from './infomanager.js';
import { buscarFacturasYaEmitidas } from './facturaYaEmitida.js';
import { emitirFactura, emitirRemito, emitirRemitoMasivo, letraDeFactura, proximoNumeroFactura } from './facturarIM.js';
import type { DatosComprobante } from './facturarIM.js';
import { usuarioIM } from './pedidos.js';
import { vistaDeRango, invalidarVista } from './vistaPresupuestos.js';
// Emitir crea los remitos: la pantalla de hojas los tiene que ver ya mismo.
import { invalidarRemitos } from './vistaRemitos.js';

/**
 * Traduce el rechazo por stock del remito a nombres de productos.
 *
 * IM contesta: `Artículos sin stock suficiente: [{"cod_articulo":470,"cantidad":5,
 * "stock_disponible":-570.00000}]`. Devuelve `null` si el error es otro — así quien llama sabe
 * que tiene que mostrar el mensaje crudo en vez de inventar una explicación.
 */
export function articulosSinStockDelError(
  error: string, catalogo: Map<number, { descripcion?: string }>,
): string | null {
  if (!/stock/i.test(String(error))) return null;
  const bloque = String(error).match(/\[.*\]/s);
  if (!bloque) return null;
  let lista: any[];
  try { lista = JSON.parse(bloque[0]); } catch { return null; }
  if (!Array.isArray(lista) || !lista.length) return null;
  return lista.map((x: any) => {
    const cod = Number(x.cod_articulo);
    const nombre = catalogo.get(cod)?.descripcion ?? `artículo ${cod}`;
    const hay = Number(x.stock_disponible);
    return `${nombre} (piden ${Number(x.cantidad)}, hay ${Number.isFinite(hay) ? hay : '?'})`;
  }).join(' · ');
}

/** Sólo la oficina. Devuelve true si ya contestó el 403. */
function frenaSiNoPuede(req: Request & { user?: JwtPayload }, res: Response): boolean {
  if (!puedeArmarHojasDeRuta(String(req.user?.rol ?? ''))) {
    res.status(403).json({ error: 'La facturación la hace administración.' });
    return true;
  }
  return false;
}

const PEDIDO_EMPRESA_DEFAULT = Number(process.env.PEDIDO_EMPRESA_DEFAULT || 1);
const PEDIDO_LISTA_FALLBACK = Number(process.env.PEDIDO_LISTA_FALLBACK || 12);
/** Tope de días de renglones que se piden de una vez. Cada día es una consulta a IM. */
const MAX_DIAS_FACTURA = 6;
/** El depósito del que sale la mercadería: es contra el que el remito valida stock. */
const DEPOSITO_REMITO = Number(process.env.PEDIDO_DEPOSITO || 1);

/** Lo que le pasa a cada presupuesto cuando se apriete Facturar. */
export type EstadoFacturacion = 'listo' | 'falta_remito' | 'facturado' | 'no_se_puede';

export interface PresupuestoAFacturar {
  im_comprobante_id: string;
  im_numero: number | null;
  cod_cliente: number;
  cliente_nombre: string | null;
  cod_empresa?: number | null;
  fecha?: string | null;
  total?: number | null;
  bultos?: number | null;
  kg?: number | null;
  /** Lo que ya se emitió, si se emitió (viene de `presupuestos_facturados`). */
  im_factura_id?: string | null;
  im_factura_numero?: number | null;
  im_remito_id?: string | null;
  im_remito_numero?: number | null;
  facturado_at?: string | null;
  /** Ya existe la fila en `presupuestos_facturados` (aunque esté vacía: es un reclamo). */
  tiene_fila?: boolean;
  reclamado_at?: string | null;
  /** Si el pedido salió de la app, su id: hay que marcarlo facturado del lado del vendedor. */
  pedido_id?: string | null;
}

export interface Preparado {
  fila: PresupuestoAFacturar;
  estado: EstadoFacturacion;
  motivo: string | null;
  letra: 'A' | 'B' | null;
  datos: DatosComprobante | null;
  /**
   * Artículos que InfoManager va a rechazar al pedirle el REMITO por falta de stock. No impide
   * facturar: avisa antes de que la factura salga y el remito no.
   */
  sin_stock?: Array<{ cod_articulo: number; descripcion: string; pedido: number; disponible: number | null }>;
}

/**
 * Revisa contra IM qué se puede emitir — **sin emitir nada**.
 *
 * La usan la previsualización y la emisión, a propósito: si fueran dos caminos distintos, la
 * pantalla podría prometer algo que después no sale.
 *
 * 🪤 Los renglones se piden por la FECHA REAL de cada comprobante, no por una fecha común: se
 * factura una selección que puede abarcar varios días. Y se mira si el presupuesto sigue vivo:
 * la oficina anula comprobantes en IM todo el tiempo y facturar uno anulado deja una factura
 * sin respaldo.
 */
export async function prepararFacturacion(
  filas: PresupuestoAFacturar[], usuario: string,
): Promise<Preparado[]> {
  const clientes = await fetchClientesIMCached().catch(() => [] as any[]);
  const porCliente = new Map(clientes.map((c: any) => [Number(c.cod_cliente), c]));

  const aRevisar = filas.filter(f => !f.facturado_at);

  const cabeceras = new Map<string, { fecha: string | null; anulada: boolean | null; existe: boolean | null }>();
  await Promise.all(aRevisar.map(async (f) => {
    const k = String(f.im_comprobante_id);
    try { cabeceras.set(k, await cabeceraComprobante(k)); }
    catch { cabeceras.set(k, { fecha: null, anulada: null, existe: null }); }
  }));

  // Un día = una consulta de renglones. Con muchos días sueltos se pide el rango entero: truncar
  // la lista dejaría pedidos sin renglones y el error diría "no pude traerlos", que es mentira.
  const dias = [...new Set(aRevisar.map(f =>
    cabeceras.get(String(f.im_comprobante_id))?.fecha ?? String(f.fecha ?? '').slice(0, 10),
  ).filter(Boolean))].sort();
  const renglonesPorComp = new Map<string, any[]>();
  if (dias.length) {
    const tandas = dias.length > MAX_DIAS_FACTURA
      ? [await fetchVentasItems(dias[0], dias[dias.length - 1]).catch(() => [] as any[])]
      : await Promise.all(dias.map(d => fetchVentasItems(d, d).catch(() => [] as any[])));
    for (const it of tandas.flat()) {
      const k = String((it as any).id_comprobante);
      if (!renglonesPorComp.has(k)) renglonesPorComp.set(k, []);
      renglonesPorComp.get(k)!.push(it);
    }
  }

  /**
   * 🔴 EL REMITO VALIDA STOCK Y EL PANEL TIENE QUE SABERLO ANTES DE FACTURAR.
   *
   * `POST /remitos` contesta *"No se puede crear el presupuesto. Artículos sin stock suficiente:
   * [{cod_articulo, cantidad, stock_disponible}]"* y no emite nada. La factura, en cambio, no
   * valida stock: sale igual. Resultado, el 09/09/2026: pedidos con la factura emitida y sin
   * remito, que es el estado que no sirve para nada — la mercadería no puede salir y la hoja de
   * ruta se arma con remitos.
   *
   * Casi siempre el faltante es una diferencia de inventario (MEZCLA P/PAJARO figuraba en −570),
   * no que no haya mercadería. Por eso NO frena la facturación: la marca, para que se decida con
   * el dato a la vista en vez de descubrirlo con la factura ya emitida.
   */
  const stock = await fetchStockPorDeposito(DEPOSITO_REMITO).catch(() => null);
  const catalogo = await fetchArticulosCatalogo().catch(() => new Map());

  /**
   * 🔴 ¿Alguno de estos presupuestos YA está facturado en InfoManager?
   *
   * El 09/09/2026 se emitió una factura DUPLICADA real (la 50401) porque nadie preguntaba esto:
   * el panel sólo miraba lo que había facturado ÉL. InfoManager no marca el presupuesto al
   * facturarlo —medido: los 35 ya facturados y los 23 sin facturar están todos en
   * `tipo_presupuesto: 'C'`— así que se busca la factura real: mismo cliente, mismo importe.
   *
   * Se mira desde el día del presupuesto más viejo hasta hoy: un presupuesto del lunes se puede
   * haber facturado el miércoles.
   */
  const yaEmitidas = new Map<string, any>();
  if (aRevisar.length) {
    try {
      const desde = dias[0] ?? fechaArgentina();
      const ventas = await fetchVentas(desde, fechaArgentina());
      const facturasVigentes = ventas.filter((v: any) =>
        String(v.tipo_comprobante ?? '').trim() === 'FA' &&
        String(v.anulada ?? '').trim().toUpperCase() !== 'S');
      // Las que ya sabemos de qué presupuesto son: no pueden marcar a otro.
      const { data: nuestrasFilas } = await sb().from('presupuestos_facturados')
        .select('im_comprobante_id, im_factura_id, im_factura_numero, im_factura_tipo')
        .eq('tenant_id', TENANT_ID).not('im_factura_id', 'is', null);
      const nuestras = new Map((nuestrasFilas ?? []).map((n: any) => [String(n.im_comprobante_id), {
        im_factura_id: n.im_factura_id ?? null,
        im_factura_numero: n.im_factura_numero ?? null,
        im_factura_tipo: n.im_factura_tipo ?? null,
      }]));
      for (const [k, v] of buscarFacturasYaEmitidas(
        aRevisar.map(f => ({
          im_comprobante_id: String(f.im_comprobante_id),
          cod_cliente: Number(f.cod_cliente),
          total: Number(f.total ?? 0),
        })),
        facturasVigentes as any, nuestras,
      )) yaEmitidas.set(k, v);
    } catch (e: any) {
      // 🪤 No poder chequear no puede bloquear la facturación del día entero, pero tampoco puede
      // pasar callado: se avisa por log y la pantalla sigue con el resto de los controles.
      console.warn('[prepararFacturacion] no pude chequear facturas ya emitidas:', e?.message);
    }
  }

  return filas.map((f): Preparado => {
    const quien = `${f.cliente_nombre ?? 'cliente ' + f.cod_cliente} (PR ${f.im_numero ?? f.im_comprobante_id})`;
    const cliente = porCliente.get(Number(f.cod_cliente));
    const letra = letraDeFactura(cliente?.categoria_iva);
    const no = (motivo: string): Preparado => ({ fila: f, estado: 'no_se_puede', motivo, letra, datos: null });

    if (f.facturado_at) return { fila: f, estado: 'facturado', motivo: null, letra, datos: null };

    const cab = cabeceras.get(String(f.im_comprobante_id));
    if (cab?.existe === false) return no(`${quien}: el presupuesto ya no está en InfoManager.`);
    if (cab?.anulada === true) return no(`${quien}: el presupuesto está ANULADO en InfoManager.`);
    // 🪤 `null` en esos campos es "no pude preguntar", y NO es lo mismo que "está vigente"
    // (`cabeceraComprobante` lo documenta así). La oficina anula presupuestos en IM todo el
    // tiempo: emitir sin poder verificarlo deja una factura sin respaldo. Se cae del lado seguro.
    if (cab?.existe !== true || cab?.anulada !== false) {
      return no(`${quien}: no pude verificar en InfoManager si el presupuesto sigue vigente. Probá de nuevo en un rato.`);
    }

    /**
     * 🔴 Ya tiene factura en InfoManager: no se emite otra. Es el caso que dejó la factura 50401
     * duplicada el 09/09/2026.
     */
    /**
     * 🪤 NO aplica cuando ya sabemos cuál es su factura (`f.im_factura_id`): ése es el caso de
     * "la factura salió y el remito falló", y ahí hay que hacer el remito, no frenar. El guard es
     * para lo que NO tenemos registrado, que es justamente lo que se factura a mano en IM.
     */
    const ya = f.im_factura_id ? null : yaEmitidas.get(String(f.im_comprobante_id));
    if (ya) {
      return no(ya.origen === 'nuestra'
        ? `${quien}: ya se facturó desde el panel (${ya.tipo} ${ya.numero ?? ''}). No se factura de nuevo.`
        : `${quien}: parece que YA ESTÁ FACTURADO en InfoManager — hay una ${ya.tipo} ${ya.numero ?? ''} del mismo cliente por el mismo importe${ya.fecha ? ` del ${ya.fecha}` : ''}. Verificalo antes de emitir: si facturás igual, el cliente queda con dos facturas.`);
    }

    const todos = renglonesPorComp.get(String(f.im_comprobante_id)) ?? [];
    if (!todos.length) return no(`No pude traer los renglones del ${quien}. Facturalo a mano.`);
    /**
     * 🔴 Los renglones SIN artículo no se pueden facturar por la API: `cod_articulo` es int64
     * obligatorio en facturas y remitos, y `""` (como los guarda IM) o `0` se rechazan (probado
     * el 09/09/2026). La oficina los usa de dos formas:
     *  · como NOTA en $0 ("QUEBRADO GRUESO PENDIENTE"): no cambia el total, se saltea.
     *  · con importe (un costo de distribución escrito a mano): NO se puede emitir, porque
     *    saltearlo facturaría de menos. Se frena y se dice cómo cargarlo.
     */
    const sinArticulo = todos.filter((it: any) => !(Number(it.cod_articulo) > 0));
    const conPlata = sinArticulo.find((it: any) => Math.abs(Number(it.precio ?? 0) * Number(it.cantidad ?? 0)) >= 0.005);
    if (conPlata) {
      return no(`${quien}: tiene un renglón sin artículo con importe ("${String(conPlata.detalle ?? '').trim() || 'sin texto'}"), y la API de InfoManager no lo acepta en la factura. Cargalo con el artículo 13819 COSTO DE DISTRIBUCION (desde el panel: editar → "Agregar costo de distribución") y volvé a facturar.`);
    }
    const items = todos.filter((it: any) => Number(it.cod_articulo) > 0);
    if (!items.length) return no(`${quien}: no tiene ningún renglón con artículo, sólo notas. No hay qué facturar.`);

    // Lo que InfoManager va a rechazar cuando le pidamos el remito. `null` = no se pudo consultar
    // el stock, y ahí no se marca nada: no es lo mismo que "no hay".
    const sinStock = stock
      ? items
          .map((it: any) => ({
            cod_articulo: Number(it.cod_articulo),
            descripcion: (catalogo.get(Number(it.cod_articulo)) as any)?.descripcion ?? String(it.detalle ?? `Artículo ${it.cod_articulo}`),
            pedido: Number(it.cantidad),
            disponible: stock.get(Number(it.cod_articulo)) ?? null,
          }))
          .filter((x: any) => x.disponible != null && x.disponible < x.pedido)
      : [];

    // 🔴 Con la factura ya emitida NO se vuelve a emitir: falta sólo el remito, que es X y no
    // depende de la condición de IVA.
    const yaTieneFactura = !!f.im_factura_id;
    if (!yaTieneFactura && !letra) {
      return no(`${quien}: no se sabe qué letra de factura le corresponde (condición de IVA: ${cliente?.categoria_iva ?? 'sin cargar'}). Facturalo a mano.`);
    }

    return {
      fila: f,
      estado: yaTieneFactura ? 'falta_remito' : 'listo',
      motivo: null,
      sin_stock: sinStock,
      letra,
      datos: {
        cod_empresa: Number(f.cod_empresa) || PEDIDO_EMPRESA_DEFAULT,
        cod_cliente: Number(f.cod_cliente),
        cod_vendedor: Number(items[0]?.cod_vendedor ?? 0) || 1,
        categoria_iva: cliente?.categoria_iva,
        cod_lista_precios: Number(items[0]?.cod_lista_precios) || PEDIDO_LISTA_FALLBACK,
        usuario,
        observaciones: `Pedido ${f.im_numero ?? ''}`.trim(),
        origen_id: f.im_comprobante_id,
        total: Number(f.total ?? 0),
        cod_deposito: 1,
        // La fija el handler con lo que mandó la pantalla; si no viene, es hoy.
        fecha: null as string | null,
        items: items.map((it: any) => {
          /**
           * 🔴 EL DESCUENTO SE APLICABA DOS VECES. `/ventas/items` devuelve `precio` YA NETO
           * (con el descuento adentro) y `precio_orig` bruto. Mandábamos el neto **más** el
           * `descuento_porc`, así que InfoManager lo volvía a descontar.
           *
           * Medido sobre el PR 58288 (BIANCONI, 09/09/2026): el presupuesto era $587.301,97 y la
           * factura 50401 salió por **$514.237,59** — $73.064 de menos. El endpoint de remitos sí
           * valida que el total coincida con los ítems y por eso lo rechazó; el de facturas no
           * valida y la emitió mal en silencio.
           *
           * El precio va BRUTO (`precio_orig`) y el descuento aparte, que es lo que IM espera y
           * lo que ya hacía `crearPresupuesto` desde el 28/08/2026.
           */
          const desc = it.descuento_porc ? Number(it.descuento_porc) : null;
          const bruto = Number(it.precio_orig ?? 0);
          const neto = Number(it.precio ?? 0);
          return {
            cod_articulo: Number(it.cod_articulo), cantidad: Number(it.cantidad),
            // Sin descuento los dos precios son el mismo; con descuento manda el bruto.
            precio: desc && bruto > 0 ? bruto : neto,
            iva_por: Number(it.iva_por ?? 0),
            cod_lista_precios: it.cod_lista_precios != null ? Number(it.cod_lista_precios) : null,
            descuento_porc: desc,
          };
        }),
      },
    };
  });
}

/**
 * Los presupuestos elegidos, cruzados con lo que ya se les emitió.
 *
 * Los datos del pedido salen de la vista del rango (la misma que ve la oficina) y lo emitido de
 * `presupuestos_facturados`, que es nuestro único registro del vínculo.
 */
async function filasDe(ids: string[], desde: string, hasta: string): Promise<PresupuestoAFacturar[]> {
  const vista = await vistaDeRango(desde, hasta);
  const enVista = new Map<string, any>();
  for (const p of [...vista.pendientes, ...vista.asignados]) enVista.set(String(p.im_comprobante_id), p);

  // 🔴 ESTA CONSULTA ES EL ÚNICO GUARD CONTRA FACTURAR DOS VECES. Supabase no tira excepción
  // cuando falla: devuelve `{ data: null, error }`. Ignorar ese error convierte "no pude
  // preguntar" en "no hay nada facturado" y se emite todo de nuevo. Si no se puede leer, se
  // corta antes de tocar InfoManager.
  const { data: emitidos, error } = await sb().from('presupuestos_facturados')
    .select('*').eq('tenant_id', TENANT_ID).in('im_comprobante_id', ids);
  if (error) throw new Error(`no pude leer qué se facturó ya (${error.message})`);
  const porId = new Map((emitidos ?? []).map((e: any) => [String(e.im_comprobante_id), e]));

  return ids.map((id) => {
    const p = enVista.get(String(id));
    const e = porId.get(String(id));
    return {
      im_comprobante_id: String(id),
      im_numero: p?.im_numero ?? e?.im_numero ?? null,
      cod_cliente: Number(p?.cod_cliente ?? e?.cod_cliente ?? 0),
      cliente_nombre: p?.cliente_nombre ?? e?.cliente_nombre ?? null,
      cod_empresa: e?.cod_empresa ?? PEDIDO_EMPRESA_DEFAULT,
      fecha: p?.fecha ?? e?.fecha ?? hasta,
      total: p?.total ?? e?.total ?? 0,
      bultos: p?.bultos ?? e?.bultos ?? null,
      kg: p?.kg ?? e?.kg ?? null,
      im_factura_id: e?.im_factura_id ?? null,
      im_factura_numero: e?.im_factura_numero ?? null,
      im_remito_id: e?.im_remito_id ?? null,
      im_remito_numero: e?.im_remito_numero ?? null,
      facturado_at: e?.facturado_at ?? null,
      tiene_fila: !!e,
      reclamado_at: e?.reclamado_at ?? e?.created_at ?? null,
      pedido_id: p?.pedido_id ?? null,
      // El estado de la revisión: sólo se factura lo aprobado.
      ...(p ? { _revision: p.revision } : {}),
    } as any;
  });
}

/**
 * `?desde=&hasta=` para ubicar los presupuestos elegidos. Sin eso, hoy.
 *
 * 🪤 Se acota al mismo tope que la etapa 1 (`MAX_RANGO_DIAS`): con rangos distintos, las dos
 * pantallas hablarían de conjuntos distintos y cada una pagaría su propia consulta pesada a IM.
 */
const MAX_RANGO_DIAS = 31;

function rango(req: Request): { desde: string; hasta: string } {
  const ok = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : null;
  const q = req.method === 'GET' ? req.query : req.body;
  const hasta = ok(q?.hasta) ?? ok(q?.desde) ?? new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  let desde = ok(q?.desde) ?? hasta;
  if (desde > hasta) desde = hasta;
  const tope = new Date(new Date(hasta + 'T12:00:00Z').getTime() - MAX_RANGO_DIAS * 864e5).toISOString().slice(0, 10);
  if (desde < tope) desde = tope;
  return { desde, hasta };
}

/**
 * Tope de comprobantes por tanda.
 *
 * 🪤 No es estético: la consulta de lo ya facturado usa un `.in(...)`, y truncarla haría que los
 * de más allá del tope vuelvan como "sin facturar" y se emitan de nuevo. Se rechaza en vez de
 * cortar en silencio. Una tanda de 300 pedidos ya son ~10 minutos de emisión.
 */
const MAX_POR_TANDA = 300;

function idsDe(req: Request): string[] {
  const q = req.method === 'GET' ? req.query : req.body;
  const raw = q?.ids ?? q?.im_comprobante_ids;
  const lista = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  return [...new Set(lista.map(x => String(x).trim()).filter(Boolean))];
}

/**
 * GET /api/facturacion/previa?ids=&desde=&hasta= — qué se va a emitir, sin emitir nada.
 *
 * Es la pantalla de confirmación: quien aprieta el botón tiene que ver antes, comprobante por
 * comprobante, qué sale y con qué letra, y cuáles no se pueden y por qué.
 */
export async function previsualizarFacturacion(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  try {
    const ids = idsDe(req);
    if (!ids.length) { res.status(400).json({ error: 'No elegiste ningún presupuesto.' }); return; }
    if (ids.length > MAX_POR_TANDA) {
      res.status(400).json({ error: `Elegiste ${ids.length} pedidos y el máximo por tanda es ${MAX_POR_TANDA}. Hacelo en varias tandas.` });
      return;
    }
    const { desde, hasta } = rango(req);
    const filas = await filasDe(ids, desde, hasta);
    const preparados = await prepararFacturacion(filas, '');

    const listos = preparados.filter(p => p.estado === 'listo');
    res.json({
      ok: true,
      pedidos: preparados.map(p => ({
        im_comprobante_id: p.fila.im_comprobante_id,
        im_numero: p.fila.im_numero,
        cod_cliente: p.fila.cod_cliente,
        cliente_nombre: p.fila.cliente_nombre,
        total: Number(p.fila.total ?? 0),
        letra: p.letra,
        estado: p.estado,
        motivo: p.motivo,
        im_factura_numero: p.fila.im_factura_numero ?? null,
        im_remito_numero: p.fila.im_remito_numero ?? null,
        renglones: p.datos?.items.length ?? 0,
        /**
         * Los artículos que van a quedar en negativo al remitir. NO impide facturar —el remito
         * sale igual por `/remitos/masivo`—, pero conviene verlo antes: casi siempre es una
         * diferencia de inventario que alguien tiene que corregir.
         */
        sin_stock: p.sin_stock ?? [],
      })),
      a_emitir: {
        facturas: listos.length,
        remitos: listos.length + preparados.filter(p => p.estado === 'falta_remito').length,
        clientes: new Set(listos.map(p => Number(p.fila.cod_cliente))).size,
        total: Math.round(listos.reduce((s, p) => s + Number(p.fila.total ?? 0), 0) * 100) / 100,
        letras: { A: listos.filter(p => p.letra === 'A').length, B: listos.filter(p => p.letra === 'B').length },
      },
      no_se_puede: preparados.filter(p => p.estado === 'no_se_puede').length,
      ya_facturados: preparados.filter(p => p.estado === 'facturado').length,
      punto_de_venta: Number(process.env.IM_PTO_VENTA_FACTURA || 777),
    });
  } catch (err: any) {
    console.error('[previsualizarFacturacion]', err?.message);
    res.status(502).json({ error: `No pude consultar InfoManager para saber qué se puede facturar: ${err?.message ?? 'sin respuesta'}` });
  }
}

/**
 * Cuánto puede tardar una emisión antes de que su reclamo se considere abandonado.
 *
 * Referencia real: IM corta a los 25 s y se reintenta hasta 3 veces (75 s en el peor caso).
 */
const RECLAMO_VENCE_MS = 5 * 60_000;

/**
 * Marca el presupuesto como "lo estoy facturando yo", ANTES de tocar InfoManager.
 *
 * 🔴 Es el único freno cuando dos personas aprietan Facturar sobre la misma selección: el rol
 * administrativo lo tienen dos. El `insert` choca contra el índice único y la segunda no emite.
 *
 * 🪤 Una fila que ya existe SIN factura no se pisa nunca, ni siquiera vencida. Antes se
 * "retomaba" con un `update`, y un update no choca con ningún índice: dos personas con el
 * reclamo vencido lo tomaban las dos y emitían las dos (verificación adversarial del
 * 08/09/2026). Y hay un caso peor: que la factura SÍ se haya emitido y lo que falló haya sido el
 * registro. Desde afuera esas dos situaciones son idénticas, así que **la reanudación la
 * autoriza una persona** —después de mirar InfoManager— con "Liberar" en la pantalla.
 */
async function reclamar(f: PresupuestoAFacturar, base: Record<string, any>): Promise<{ ok: boolean; error?: string }> {
  if (f.tiene_fila) {
    const edad = Date.now() - new Date(f.reclamado_at ?? 0).getTime();
    if (Number.isFinite(edad) && edad < RECLAMO_VENCE_MS) {
      return { ok: false, error: 'lo está facturando alguien más en este momento. Actualizá la pantalla antes de reintentar.' };
    }
    return {
      ok: false,
      error: 'quedó un intento anterior sin terminar. **Puede que la factura se haya emitido igual**: buscala en InfoManager por el cliente y la fecha. Si no está, usá "Liberar" para poder reintentar.',
    };
  }
  const { error } = await sb().from('presupuestos_facturados')
    .insert({ ...base, reclamado_at: new Date().toISOString() });
  // El índice único es el que frena a la segunda persona.
  if (error) return { ok: false, error: 'otro usuario lo tomó primero. Actualizá la pantalla antes de reintentar.' };
  return { ok: true };
}

/**
 * DELETE /api/facturacion/reclamo/:comprobanteId — libera un intento que quedó a medias.
 *
 * 🔴 Lo aprieta una persona DESPUÉS de verificar en InfoManager que la factura no salió. Por eso
 * sólo borra filas sin factura registrada: lo que ya se emitió no se toca desde acá.
 */
export async function liberarReclamo(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  const id = String(req.params.comprobanteId);
  const { data, error } = await sb().from('presupuestos_facturados')
    .delete().eq('tenant_id', TENANT_ID).eq('im_comprobante_id', id)
    .is('im_factura_id', null).is('facturado_at', null).select();
  if (error) { res.status(500).json({ error: error.message }); return; }
  if (!(data ?? []).length) {
    res.status(409).json({ error: 'Ese pedido ya tiene comprobantes registrados: no es un intento a medias.' });
    return;
  }
  res.json({ ok: true, liberado: id });
}

/** Suelta el reclamo cuando la emisión falló, para poder reintentar sin esperar los 5 minutos. */
async function soltarReclamo(f: PresupuestoAFacturar): Promise<void> {
  const { error } = await sb().from('presupuestos_facturados')
    .delete().eq('tenant_id', TENANT_ID).eq('im_comprobante_id', String(f.im_comprobante_id))
    .is('im_factura_id', null);
  if (error) console.warn(`[facturarSeleccion] no pude soltar el reclamo del ${f.im_comprobante_id}:`, error.message);
}

/**
 * POST /api/facturacion — emite factura y remito de los presupuestos elegidos.
 *
 * 🔴 Acá se emiten comprobantes REALES. Ver la cabecera del archivo.
 */
export async function facturarSeleccion(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  try {
    const ids = idsDe(req);
    if (!ids.length) { res.status(400).json({ error: 'No elegiste ningún presupuesto.' }); return; }
    if (ids.length > MAX_POR_TANDA) {
      res.status(400).json({ error: `Elegiste ${ids.length} pedidos y el máximo por tanda es ${MAX_POR_TANDA}. Hacelo en varias tandas.` });
      return;
    }
    const { desde, hasta } = rango(req);
    let filas: PresupuestoAFacturar[];
    try {
      filas = await filasDe(ids, desde, hasta);
    } catch (e: any) {
      // Sin saber qué se emitió ya, no se emite NADA.
      res.status(502).json({ error: `No pude preparar la facturación: ${e?.message ?? 'sin respuesta'}` });
      return;
    }

    // 🔴 Sólo lo aprobado en la etapa 1: facturar sin revisar es justo lo que este panel vino a
    // evitar. Lo que ya se facturó pasa igual (se saltea más abajo).
    const sinAprobar = filas.filter((f: any) => !f.facturado_at && f._revision?.estado !== 'aprobado');
    if (sinAprobar.length) {
      res.status(409).json({
        error: `Hay ${sinAprobar.length} presupuesto(s) que no están aprobados: ${sinAprobar.map((f: any) => f.im_numero ?? f.im_comprobante_id).join(', ')}. Aprobalos en Presupuestos antes de facturar.`,
      });
      return;
    }

    /**
     * 🔑 Con qué fecha se emite. Mati (09/09/2026): *"necesitamos poder cambiar la fecha cuando
     * se va a facturar"*: la oficina factura pedidos de días anteriores y el comprobante tiene
     * que llevar esa fecha, no la de hoy.
     *
     * 🪤 Se valida el formato acá: una fecha inventada sale impresa en un comprobante fiscal.
     * Sin fecha válida se usa hoy, que es lo que hacía antes.
     */
    const fechaEmision = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.fecha_emision ?? ''))
      ? String(req.body.fecha_emision) : null;

    const usuario = await usuarioIM(req.user);
    const preparados = (await prepararFacturacion(filas, usuario)).filter(p => p.estado !== 'facturado');
    // La fecha elegida viaja a los tres comprobantes (factura, remito y su reintento).
    for (const p of preparados) if (p.datos) p.datos.fecha = fechaEmision;
    if (!preparados.length) { res.status(409).json({ error: 'No hay nada para facturar en lo que elegiste.' }); return; }

    const hechos: any[] = [];
    const fallados: string[] = [];
    let cortado: string | null = null;
    // Para poder decir QUÉ producto rechazó IM cuando el remito falla por stock. Ya está
    // cacheado (lo usó prepararFacturacion), así que no cuesta una llamada más.
    const catalogoEmision = await fetchArticulosCatalogo().catch(() => new Map());

    // 🔑 El número de factura se calcula UNA vez y después se incrementa: IM no lo asigna y
    // averiguarlo cuesta ~6 s. Si otro lo tomó mientras tanto, `emitirFactura` sube al siguiente.
    const numeros: Record<string, number | null> = { A: null, B: null };
    for (const letra of ['A', 'B'] as const) {
      if (preparados.some(p => p.estado === 'listo' && p.letra === letra)) {
        numeros[letra] = await proximoNumeroFactura(letra, Number(process.env.IM_PTO_VENTA_FACTURA || 777));
      }
    }

    for (const p of preparados) {
      if (cortado) break;
      if (p.estado === 'no_se_puede' || !p.datos) { fallados.push(p.motivo ?? 'no se pudo facturar'); continue; }
      const f = p.fila;
      const quien = `${f.cliente_nombre ?? 'cliente ' + f.cod_cliente} (PR ${f.im_numero ?? f.im_comprobante_id})`;

      // La fila existe desde antes de emitir: si algo se corta, queda el rastro de qué se intentó.
      const base = {
        tenant_id: TENANT_ID,
        im_comprobante_id: String(f.im_comprobante_id),
        im_numero: f.im_numero ?? null,
        cod_cliente: Number(f.cod_cliente),
        cliente_nombre: f.cliente_nombre ?? null,
        cod_empresa: Number(f.cod_empresa) || PEDIDO_EMPRESA_DEFAULT,
        fecha: f.fecha ? String(f.fecha).slice(0, 10) : null,
        total: Number(f.total ?? 0),
        bultos: f.bultos ?? null,
        kg: f.kg ?? null,
        facturado_por: req.user?.sub ?? null,
      };

      // 1) FACTURA — salvo que ya la tenga.
      let facturaNumero: number | null = f.im_factura_numero ?? null;
      let tipoFactura = `FA ${p.letra ?? ''}`.trim();
      if (!f.im_factura_id) {
        // 🔴 RECLAMO. El rol administrativo lo tienen dos personas: si las dos aprietan Facturar
        // sobre la misma selección, las dos leen "no está facturado" y las dos emiten. La fila se
        // escribe ANTES de llamar a IM, y el índice único hace que la segunda choque.
        const reclamo = await reclamar(f, base);
        if (!reclamo.ok) { fallados.push(`${quien}: ${reclamo.error}`); continue; }

        const letra = p.letra!;
        const fa = await emitirFactura({ ...p.datos, numero: numeros[letra] } as any);
        if (fa.ok && fa.numero != null) numeros[letra] = Number(fa.numero) + 1;
        if (!fa.ok) {
          // Al log también: en pantalla se pierde, y es lo único que dice POR QUÉ IM la rechazó.
          console.error(`[facturarSeleccion] FACTURA rechazada · ${quien}: ${fa.error}`, JSON.stringify(fa.raw ?? null).slice(0, 600));
          fallados.push(`${quien}: ${fa.error}`);
          // El reclamo se suelta para que se pueda reintentar; si no se puede soltar, queda y
          // vence solo a los 5 minutos.
          await soltarReclamo(f);
          // 🔴 Sin respuesta = NO se sabe si la factura salió. Se corta: seguir sería arriesgarse
          // a facturar dos veces al resto si IM está a medio camino.
          if (fa.sinRespuesta) cortado = `InfoManager no contestó al facturar ${quien}. NO se sabe si la factura se emitió: verificalo en IM antes de volver a intentar. Se frenó el resto.`;
          continue;
        }
        // Se guarda ANTES de seguir: un comprobante emitido sin registrar se vuelve a emitir.
        const { error: errFa } = await sb().from('presupuestos_facturados').upsert({
          ...base, im_factura_id: fa.id, im_factura_numero: fa.numero, im_factura_tipo: fa.tipo,
          reclamado_at: new Date().toISOString(),
        }, { onConflict: 'tenant_id,im_comprobante_id' });
        // 🔴 La factura YA SALIÓ en InfoManager. Si no se pudo registrar, nadie sabe que existe:
        // se frena todo y el mensaje lleva el número para poder ir a buscarla.
        if (errFa) {
          fallados.push(`${quien}: se emitió la FACTURA ${fa.numero} pero NO se pudo registrar (${errFa.message}).`);
          cortado = `Se emitió la factura ${fa.numero} de ${quien} y no se pudo guardar en la base (${errFa.message}). ANOTALA: hasta que se registre, el sistema la va a seguir viendo como pendiente. Se frenó el resto.`;
          continue;
        }
        facturaNumero = fa.numero;
        tipoFactura = fa.tipo;
      }

      // 2) REMITO
      // 🪤 Cuando la factura ya estaba emitida no se pasó por el reclamo de arriba, así que dos
      // reintentos superpuestos emitían DOS remitos — y el remito descuenta stock. Se reclama
      // acá con el mismo criterio.
      if (f.im_factura_id) {
        const edad = Date.now() - new Date(f.reclamado_at ?? 0).getTime();
        if (Number.isFinite(edad) && edad < RECLAMO_VENCE_MS) {
          fallados.push(`${quien}: le está haciendo el remito alguien más en este momento.`);
          continue;
        }
        const { error: errMarca } = await sb().from('presupuestos_facturados')
          .update({ reclamado_at: new Date().toISOString() })
          .eq('tenant_id', TENANT_ID).eq('im_comprobante_id', String(f.im_comprobante_id));
        if (errMarca) { fallados.push(`${quien}: no pude marcar el intento del remito (${errMarca.message}).`); continue; }
      }
      let re = await emitirRemito(p.datos as any);
      /**
       * 🔑 LA MERCADERÍA SE REMITE AUNQUE EL STOCK ESTÉ EN NEGATIVO.
       *
       * `POST /remitos` valida stock y rechaza el remito entero; en el depósito hay diferencias de
       * inventario grandes (MEZCLA P/PAJARO figuraba en −570), así que pedidos perfectamente
       * normales se quedaban con la factura emitida y sin remito — sin poder entrar a una hoja.
       * Mati (09/09/2026): *"necesito por favor que se remita la mercadería aunque esté en
       * negativo"*.
       *
       * `POST /remitos/masivo` sí lo deja salir **y descuenta stock igual** (probado contra IM: un
       * artículo en −570 quedó en −571). Es el mismo talonario y el mismo punto de venta, así que
       * el remito es indistinguible de los otros.
       *
       * 🪤 `sinRespuesta` NO se reintenta: si IM no contestó, el remito puede haber salido igual y
       * el reintento emitiría un segundo remito por la misma mercadería.
       */
      let remitoForzado: string | null = null;
      if (!re.ok && !re.sinRespuesta) {
        const faltantes = articulosSinStockDelError(re.error, catalogoEmision);
        if (faltantes) {
          console.warn(`[facturarSeleccion] ${quien}: IM rechazó el remito por stock (${faltantes}). Reintento por /remitos/masivo.`);
          const reintento = await emitirRemitoMasivo(p.datos as any);
          if (reintento.ok) { re = reintento; remitoForzado = faltantes; }
          else console.error(`[facturarSeleccion] ${quien}: el remito masivo tampoco salió: ${reintento.error}`);
        }
      }
      if (!re.ok) {
        console.error(`[facturarSeleccion] REMITO rechazado · ${quien} (factura ${facturaNumero}): ${re.error}`, JSON.stringify(re.raw ?? null).slice(0, 600));
        /**
         * 🔑 El motivo real casi siempre es stock: IM contesta *"Artículos sin stock suficiente:
         * [{cod_articulo, cantidad, stock_disponible}]"*. Ese JSON crudo en pantalla no le dice
         * nada a nadie, así que se traduce a los nombres de los productos.
         */
        const faltantes = articulosSinStockDelError(re.error, catalogoEmision);
        fallados.push(faltantes
          ? `${quien}: la FACTURA ${facturaNumero} se emitió, pero el REMITO no: InfoManager dice que no hay stock de ${faltantes}. Ajustá el stock en InfoManager y volvé a apretar Facturar (va a hacer sólo el remito), o hacelo a mano.`
          : `${quien}: la FACTURA ${facturaNumero} se emitió, pero el remito falló (${re.error}). Hacé el remito a mano.`);
        if (re.sinRespuesta) cortado = `InfoManager no contestó al emitir el remito de ${quien}. La factura ${facturaNumero} SÍ se emitió. Revisalo en IM. Se frenó el resto.`;
        continue;
      }
      const { error: errRe } = await sb().from('presupuestos_facturados').upsert({
        ...base,
        ...(f.im_factura_id ? { im_factura_id: f.im_factura_id } : {}),
        im_factura_numero: facturaNumero,
        im_factura_tipo: tipoFactura,
        im_remito_id: re.id, im_remito_numero: re.numero,
        facturado_at: new Date().toISOString(),
      }, { onConflict: 'tenant_id,im_comprobante_id' });
      // Los dos comprobantes salieron y no se pudieron registrar: mismo criterio que arriba.
      if (errRe) {
        fallados.push(`${quien}: salieron la factura ${facturaNumero} y el remito ${re.numero}, pero NO se pudieron registrar (${errRe.message}).`);
        cortado = `Se emitieron la factura ${facturaNumero} y el remito ${re.numero} de ${quien} y no se pudieron guardar en la base (${errRe.message}). ANOTALOS. Se frenó el resto.`;
        continue;
      }

      // Salió todo, pero con el stock en negativo: no es un error, y conviene saberlo igual.
      if (remitoForzado) {
        fallados.push(`${quien}: salieron la factura ${facturaNumero} y el remito ${re.numero}. Ojo que quedó stock en negativo: ${remitoForzado}.`);
      }

      // 3) El presupuesto sale de la ventana de facturación de la oficina.
      const desc = await desconfirmarPresupuesto(f.im_comprobante_id);
      if (!desc.ok) console.warn(`[facturarSeleccion] no pude desconfirmar el PR ${f.im_numero}:`, desc.error);

      // 4) Si el pedido vino de la app, el vendedor tiene que verlo facturado.
      // 🪤 El cron `marcarFacturados` NO lo cubre: pregunta por `/presupuestos/obtener_facturas`,
      // y facturar por API no crea ese vínculo en IM — el pedido quedaría "enviado" para siempre.
      if (f.pedido_id) {
        const { error: errPed } = await sb().from('pedidos_vendedor')
          .update({ estado: 'facturado' }).eq('id', f.pedido_id);
        if (errPed) console.warn(`[facturarSeleccion] no pude marcar el pedido ${f.pedido_id}:`, errPed.message);
      }

      hechos.push({ cliente: f.cliente_nombre, factura: facturaNumero, remito: re.numero, tipo: tipoFactura });
    }

    invalidarVista(); invalidarRemitos();
    res.json({
      ok: !fallados.length && !cortado,
      facturados: hechos.length, hechos, fallados, cortado,
      quedan_sin_facturar: preparados.length - hechos.length,
    });
  } catch (err: any) {
    console.error('[facturarSeleccion]', err?.message);
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/**
 * GET /api/facturacion?desde=&hasta= — el tablero de la etapa 2.
 *
 * Los presupuestos aprobados del rango, separados en lo que falta facturar y lo ya emitido.
 */
export async function tableroFacturacion(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  try {
    const { desde, hasta } = rango(req);
    const vista = await vistaDeRango(desde, hasta, req.query.refrescar === '1');
    const todos = [...vista.pendientes, ...vista.asignados];
    const aprobados = todos.filter((p: any) => p.revision?.estado === 'aprobado');

    const { data: emitidos, error: errEmitidos } = await sb().from('presupuestos_facturados')
      .select('*').eq('tenant_id', TENANT_ID)
      .in('im_comprobante_id', aprobados.map((p: any) => String(p.im_comprobante_id)));
    // Sin esto, la pantalla mostraría como "para facturar" cosas que ya se facturaron.
    if (errEmitidos) { res.status(502).json({ error: `No pude leer qué se facturó ya: ${errEmitidos.message}` }); return; }
    const porId = new Map((emitidos ?? []).map((e: any) => [String(e.im_comprobante_id), e]));

    const filas = aprobados.map((p: any) => {
      const e = porId.get(String(p.im_comprobante_id));
      return {
        ...p,
        im_factura_numero: e?.im_factura_numero ?? null,
        im_factura_tipo: e?.im_factura_tipo ?? null,
        im_remito_numero: e?.im_remito_numero ?? null,
        // Los ids son lo que necesita el botón de imprimir de esta pantalla.
        im_factura_id: e?.im_factura_id ?? null,
        im_remito_id: e?.im_remito_id ?? null,
        facturado_at: e?.facturado_at ?? null,
        // Con la factura emitida y sin remito: el reintento hace SÓLO el remito.
        falta_remito: !!e?.im_factura_id && !e?.facturado_at,
      };
    });

    const pendientes = filas.filter(f => !f.facturado_at);
    res.json({
      ok: true, desde, hasta,
      pendientes,
      facturados: filas.filter(f => f.facturado_at),
      totales: {
        pendientes: pendientes.length,
        importe_pendiente: Math.round(pendientes.reduce((s, f) => s + Number(f.total ?? 0), 0) * 100) / 100,
        facturados: filas.length - pendientes.length,
        falta_remito: filas.filter(f => f.falta_remito).length,
      },
      // Lo que todavía no se aprobó, para que se vea por qué no está en la lista.
      sin_aprobar: todos.length - aprobados.length,
    });
  } catch (err: any) {
    console.error('[tableroFacturacion]', err?.message);
    res.status(502).json({ error: `No se pudo armar el tablero de facturación: ${err?.message ?? 'sin respuesta de IM'}` });
  }
}
