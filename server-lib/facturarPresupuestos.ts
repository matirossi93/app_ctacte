import { actualizarImportesFacturas } from './importesFacturas.js';
import { cabecerasCompartidas } from './cabecerasCompartidas.js';
import { EVIDENCIA, compararPar } from './evidenciaComprobantes.js';
import { textoControl } from './controlFacturaRemito.js';
import { leerComprobante, invalidarIM } from './infomanager.js';
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
import { diaValido } from './moverFechaComprobante.js';
import { randomUUID } from 'node:crypto';
import { huellaPresupuesto, exigirHuella, exigirTipoEmpresa, bloquearPresupuesto, desbloquearPresupuesto } from './versionPresupuesto.js';
import type { Request, Response } from 'express';
import { sb, TENANT_ID } from './supabase.js';
import type { JwtPayload } from './auth.js';
import { puedeArmarHojasDeRuta } from './permisos.js';
import {
  fetchVentasItems, fetchClientesIMCon, cabeceraComprobante, desconfirmarPresupuesto,
  fetchVentas, fechaArgentina, fetchStockPorDeposito, fetchArticulosCatalogo, comprobantesVigentes, getItemsComprobante,
} from './infomanager.js';
import { buscarFacturasYaEmitidas } from './facturaYaEmitida.js';
import { emitirFactura, emitirRemito, emitirRemitoMasivo, letraDeFactura, proximoNumeroFactura,
  claveDeSerie, ID_DESTINO as ID_DESTINO_FACTURA, type SerieComprobante } from './facturarIM.js';
import type { DatosComprobante } from './facturarIM.js';
import { usuarioIM } from './pedidos.js';
import { vistaDeRango, invalidarVista } from './vistaPresupuestos.js';
import { renglonesQueFaltan } from './remitoSigueALaFactura.js';
import { totalDeRenglones } from './totalFacturado.js';
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
export function frenaSiNoPuede(req: Request & { user?: JwtPayload }, res: Response): boolean {
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
/** Ventana explícita para adelantos: se limita emisión y se verifica el mismo horizonte. */
const MAX_ADELANTO_DIAS = Math.max(0, Math.min(31, Number(process.env.IM_MAX_ADELANTO_FACTURA_DIAS ?? 7) || 0));
const fechaMaximaEmision = () => fechaArgentina(Date.now() + MAX_ADELANTO_DIAS * 864e5);
/** El depósito del que sale la mercadería: es contra el que el remito valida stock. */
const DEPOSITO_REMITO = Number(process.env.PEDIDO_DEPOSITO || 1);

/**
 * 🪤 InfoManager corta las observaciones en 500 caracteres, y al remito se le concatena DESPUÉS
 * la marca `" [Remito Automático -FA:58785916]"` (~35), que es el único vínculo legible entre la
 * factura y su remito desde las pantallas de IM. Dejando el texto en 400 la marca siempre entra,
 * incluso si el vendedor escribió una novela en el pedido.
 */
const MAX_OBSERVACIONES = 400;

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
  im_factura_tipo?: string | null;
  im_remito_id?: string | null;
  im_remito_numero?: number | null;
  facturado_at?: string | null;
  /** Ya existe la fila en `presupuestos_facturados` (aunque esté vacía: es un reclamo). */
  tiene_fila?: boolean;
  reclamado_at?: string | null;
  estado_emision?: string | null;
  claim_token?: string | null;
  historial_remitos?: any[];
  /** Si el pedido salió de la app, su id: hay que marcarlo facturado del lado del vendedor. */
  pedido_id?: string | null;
}

export interface Preparado {
  fila: PresupuestoAFacturar;
  estado: EstadoFacturacion;
  motivo: string | null;
  huella?: string;
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
  filas: PresupuestoAFacturar[], usuario: string, fechaEmision?: string | null,
): Promise<Preparado[]> {
  /**
   * 🔑 Con los códigos de lo que se va a facturar. Sin el cliente en la lista no se sabe su
   * condición de IVA, y sin eso no se emite nada: un cliente creado hace un rato no se podía
   * facturar hasta que venciera el cache de 30 minutos (Mati, 09/09/2026).
   */
  const clientes = await fetchClientesIMCon(filas.map(f => f.cod_cliente)).catch(() => [] as any[]);
  const porCliente = new Map(clientes.map((c: any) => [Number(c.cod_cliente), c]));

  /**
   * 🔴 Lo anulado en InfoManager NO cuenta como emitido. Sin esto, un pedido cuya factura anularon
   * en IM se quedaría para siempre en "ya facturado" y no se podría volver a facturar.
   */
  await sincronizarAnulados(filas).catch((err: any) =>
    console.warn('[prepararFacturacion] no pude chequear anulados:', err?.message));

  const aRevisar = filas.filter(f => !f.facturado_at);

  const cabeceras = new Map<string, any /* Cabecera completa: identidad + huella. */>();
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
      ? [await fetchVentasItems(dias[0], dias[dias.length - 1], { sinCache: true }).catch(() => [] as any[])]
      : await Promise.all(dias.map(d => fetchVentasItems(d, d, { sinCache: true }).catch(() => [] as any[])));
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
      const hasta = [fechaMaximaEmision(), fechaEmision ?? '', ...dias].sort().at(-1)!;
      const ventas = await fetchVentas(desde, hasta, { sinCache: true });
      const facturasVigentes = ventas.filter((v: any) =>
        String(v.tipo_comprobante ?? '').trim() === 'FA' &&
        String(v.anulada ?? '').trim().toUpperCase() !== 'S');
      // Las que ya sabemos de qué presupuesto son: no pueden marcar a otro.
      const { data: nuestrasFilas, error: errNuestras } = await sb().from('presupuestos_facturados')
        .select('im_comprobante_id, im_factura_id, im_factura_numero, im_factura_tipo')
        .eq('tenant_id', TENANT_ID).not('im_factura_id', 'is', null);
      if (errNuestras) throw new Error(errNuestras.message);
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
      throw new Error(`No pude descartar facturas previas en InfoManager: ${e?.message ?? 'sin respuesta'}. No se emitió nada.`);
    }
  }

  return filas.map((f): Preparado => {
    const quien = `${f.cliente_nombre ?? 'cliente ' + f.cod_cliente} (PR ${f.im_numero ?? f.im_comprobante_id})`;
    const cliente = porCliente.get(Number(f.cod_cliente));
    const letra = letraDeFactura(cliente?.categoria_iva);
    const no = (motivo: string): Preparado => ({ fila: f, estado: 'no_se_puede', motivo, letra, datos: null });

    if (f.estado_emision === 'anulado' || f.estado_emision === 'incierto' || f.estado_emision === 'remito_emitiendo') return no(`${quien}: tiene una emisión en curso, anulada o por conciliar. Verificá los comprobantes en InfoManager antes de continuar.`);
    if (f.facturado_at) return { fila: f, estado: 'facturado', motivo: null, letra, datos: null };

    const cab = cabeceras.get(String(f.im_comprobante_id));
    try { exigirTipoEmpresa(cab, 'PR'); } catch (e: any) { return no(e.message); }
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

    /**
     * 🔴 DE QUIÉN ES LA VENTA. Sale de la CABECERA del presupuesto.
     *
     * 🪤 Salía de `items[0].cod_vendedor`, y los renglones de un presupuesto vienen SIN vendedor:
     * verificado contra IM el 09/09/2026, los 544 renglones de los 45 presupuestos del día
     * tenían 0. O sea que el `|| 1` de respaldo se activaba SIEMPRE y todo se facturaba a nombre
     * del vendedor 1 (FEDERICO): las facturas 50401 y 50402 salieron así, cuando sus
     * presupuestos eran del 3 (MARCELO) y del 2 (SEBASTIAN).
     *
     * Sin vendedor NO se emite. Es el mismo criterio que la letra de la factura: la comisión se
     * calcula con este número, y adivinarlo se la paga a la persona equivocada en silencio. Los
     * 337 presupuestos vivos del 31/08 al 12/09 tienen todos vendedor en la cabecera, así que
     * esto no frena nada real.
     */
    const codVendedor = Number(cab?.cod_vendedor ?? 0);
    if (!(codVendedor > 0)) {
      return no(`${quien}: el presupuesto no tiene vendedor cargado en InfoManager, y sin eso la venta quedaría a nombre de otro. Asignale el vendedor en InfoManager y volvé a apretar Facturar.`);
    }

    return {
      fila: f,
      estado: yaTieneFactura ? 'falta_remito' : 'listo',
      huella: huellaPresupuesto(String(f.im_comprobante_id), cab, todos),
      motivo: null,
      sin_stock: sinStock,
      letra,
      datos: {
        cod_empresa: Number(f.cod_empresa) || PEDIDO_EMPRESA_DEFAULT,
        cod_cliente: Number(f.cod_cliente),
        cod_vendedor: codVendedor,
        categoria_iva: cliente?.categoria_iva,
        cod_lista_precios: Number(items[0]?.cod_lista_precios) || PEDIDO_LISTA_FALLBACK,
        usuario,
        /**
         * 🔑 LO QUE ESCRIBIÓ EL VENDEDOR VA A LA FACTURA. Mati (10/09/2026): *"necesito que la
         * observación que los vendedores cargan en los presupuestos se pase a la factura
         * también"*. Es donde ponen "FACTURAR A NOMBRE DE LA SRL" o "entregar el jueves", y
         * hasta ahora se quedaba en el presupuesto. Viaja igual al remito, que es lo que lee el
         * repartidor.
         */
        observaciones: [`Pedido ${f.im_numero ?? ''}`.trim(), String(cab?.observaciones ?? '').trim()]
          .filter(Boolean).join(' - ').slice(0, MAX_OBSERVACIONES),
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
      im_factura_tipo: e?.im_factura_tipo ?? null,
      im_remito_id: e?.im_remito_id ?? null,
      im_remito_numero: e?.im_remito_numero ?? null,
      facturado_at: e?.facturado_at ?? null,
      tiene_fila: !!e,
      reclamado_at: e?.reclamado_at ?? e?.created_at ?? null,
      estado_emision: e?.estado_emision ?? null, claim_token: e?.claim_token ?? null,
      historial_remitos: e?.historial_remitos ?? [],
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
      fecha_maxima_emision: fechaMaximaEmision(), max_adelanto_dias: MAX_ADELANTO_DIAS,
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
    .insert({ ...base, estado_emision: 'factura_emitiendo', claim_token: f.claim_token, reclamado_at: new Date().toISOString() });
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
    .is('im_factura_id', null).is('facturado_at', null).eq('estado_emision', 'rechazado').select();
  if (error) { res.status(500).json({ error: error.message }); return; }
  if (!(data ?? []).length) {
    res.status(409).json({ error: 'Ese pedido ya tiene comprobantes registrados: no es un intento a medias.' });
    return;
  }
  res.json({ ok: true, liberado: id });
}

/**
 * Los renglones de una factura YA EMITIDA, en el formato que espera el remito.
 *
 * `null` = no se pudieron leer. Quien llama NO emite: un remito armado con otra cosa que la
 * factura es mercadería que sale sin facturar (ver el bloque del remito).
 *
 * 🪤 El precio va BRUTO, igual que al facturar: `/ventas/items` devuelve `precio` YA NETO y
 * mezclarlos fue lo que hizo salir una factura $73.064 por debajo el 09/09/2026.
 */
async function itemsDeLaFactura(idFactura: string, leidos?: any[]): Promise<DatosComprobante['items'] | null> {
  try {
    /**
     * 🔑 Un GET al comprobante, no el listado del día entero. Antes traía TODOS los renglones de
     * la fecha —miles— para quedarse con veinte, y eso se paga por cada remito de la tanda.
     */
    const rs = (leidos ?? await getItemsComprobante(idFactura))
      .filter((it: any) => Number(it.cod_articulo) > 0);
    if (!rs.length) return null;
    return rs.map((it: any) => {
      const desc = it.descuento_porc ? Number(it.descuento_porc) : null;
      const bruto = Number(it.precio_orig ?? 0);
      const neto = Number(it.precio ?? 0);
      return {
        cod_articulo: Number(it.cod_articulo),
        cantidad: Number(it.cantidad),
        precio: desc && bruto > 0 ? bruto : neto,
        iva_por: Number(it.iva_por ?? 0),
        cod_lista_precios: it.cod_lista_precios != null ? Number(it.cod_lista_precios) : null,
        descuento_porc: desc,
      };
    });
  } catch (e: any) {
    console.error(`[itemsDeLaFactura] no pude leer los renglones de la factura ${idFactura}:`, e?.message);
    return null;
  }
}

/**
 * 🔴 LO QUE SE ANULÓ EN INFOMANAGER TIENE QUE DEJAR DE FIGURAR COMO EMITIDO.
 *
 * Mati (10/09/2026): *"un cliente rechazó un pedido y tuvimos que anular una factura, lo hicimos
 * por IM, pero ese cambio no se refleja en la app: la factura sigue apareciendo como vigente"*.
 *
 * InfoManager es la fuente: si la factura que registramos ya no está vigente, nuestro registro no
 * apunta a nada y el pedido tiene que volver a estar disponible para facturar. Con el REMITO
 * anulado la factura sigue en pie, así que sólo se borra la marca de terminado — el reintento
 * hace únicamente el remito, que es el camino que ya existe.
 *
 * 🪤 Se toca la base SÓLO con una respuesta definitiva de IM. Un `null` es "no pude preguntar" y
 * ahí no se borra nada: sería tirar el registro de una factura que existe.
 *
 * Devuelve los avisos para mostrar, y de paso deja las filas al día.
 */
async function sincronizarAnulados(filas: any[], rango?: { desde: string; hasta: string; ventas?: any[] }, leerCabecera?: any): Promise<Map<string, string>> {
  const avisos = new Map<string, string>();
  const conComprobante = filas.filter(f => f.im_factura_id || f.im_remito_id);
  if (!conComprobante.length) return avisos;

  /**
   * 🔑 Con el rango, esto sale de UNA consulta cacheada en vez de un GET por comprobante. Con 60
   * facturas emitidas eran 60 consultas a IM en cada carga del tablero (Mati, 10/09/2026: *"se
   * demora mucho al buscar"*).
   */
  const vigencia = await comprobantesVigentes([
    ...conComprobante.map(f => f.im_factura_id).filter(Boolean),
    ...conComprobante.map(f => f.im_remito_id).filter(Boolean),
  ], rango, leerCabecera).catch(() => new Map<string, boolean | null>());

  for (const f of conComprobante) {
    const id = String(f.im_comprobante_id);
    const fa = f.im_factura_id ? vigencia.get(String(f.im_factura_id)) : undefined;
    const re = f.im_remito_id ? vigencia.get(String(f.im_remito_id)) : undefined;

    if (fa === false || re === false) {
      // Nunca borrar vínculos por una lectura vieja, ni limpiar una emisión en curso.
      let q = sb().from('presupuestos_facturados').update(fa === false
        ? { estado_emision: 'anulado', facturado_at: null }
        : { im_remito_id: null, im_remito_numero: null, facturado_at: null, estado_emision: 'remito_pendiente',
            historial_remitos: [...(f.historial_remitos ?? []), { id: f.im_remito_id, numero: f.im_remito_numero, motivo: 'anulado en IM' }] })
        .eq('tenant_id', TENANT_ID).eq('im_comprobante_id', id)
        .in('estado_emision', ['completo', 'remito_pendiente']);
      q = f.im_factura_id ? q.eq('im_factura_id', f.im_factura_id) : q.is('im_factura_id', null).eq('claim_token', f.claim_token!);
      q = f.im_remito_id ? q.eq('im_remito_id', f.im_remito_id) : q.is('im_remito_id', null);
      const { data, error } = await q.select('im_comprobante_id');
      if (error || !data?.length) continue;
      if (fa === false) {
        f.estado_emision = 'anulado'; f.facturado_at = null;
        avisos.set(id, `La factura ${f.im_factura_numero ?? ''} está anulada. Se conservaron los vínculos: conciliá también el remito antes de emitir otro pedido.`);
      } else {
        avisos.set(id, `El remito ${f.im_remito_numero ?? ''} está anulado. Falta emitir sólo un nuevo remito.`);
        f.im_remito_id = null; f.im_remito_numero = null; f.facturado_at = null; f.estado_emision = 'remito_pendiente';
      }
    }
  }
  return avisos;
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
    let fechaEmision: string | null;
    try { fechaEmision = req.body?.fecha_emision ? diaValido(req.body.fecha_emision) : null; }
    catch (e: any) { res.status(400).json({ error: e.message }); return; }
    if (fechaEmision && fechaEmision > fechaMaximaEmision()) {
      res.status(400).json({ error: `Se puede emitir hasta ${fechaMaximaEmision()} (${MAX_ADELANTO_DIAS} días de adelanto). Es la ventana que se verifica para evitar duplicados.` }); return;
    }

    const usuario = await usuarioIM(req.user);
    const preparados = (await prepararFacturacion(filas, usuario, fechaEmision)).filter(p => p.estado !== 'facturado');
    // La fecha elegida viaja a los tres comprobantes (factura, remito y su reintento).
    for (const p of preparados) if (p.datos) p.datos.fecha = fechaEmision;
    if (!preparados.length) { res.status(409).json({ error: 'No hay nada para facturar en lo que elegiste.' }); return; }

    const hechos: any[] = [];
    const fallados: string[] = [];
    let cortado: string | null = null;
    // Para poder decir QUÉ producto rechazó IM cuando el remito falla por stock. Ya está
    // cacheado (lo usó prepararFacturacion), así que no cuesta una llamada más.
    const catalogoEmision = await fetchArticulosCatalogo().catch(() => new Map());

    /**
     * 🔑 El número de factura se calcula UNA vez y después se incrementa: IM no lo asigna y
     * averiguarlo cuesta ~6 s. Si otro lo tomó mientras tanto, `emitirFactura` sube al siguiente.
     *
     * 🔴 EL CONTADOR VA POR SERIE COMPLETA, NO POR LETRA. Cada pedido trae su propia
     * `cod_empresa`, y el talonario que IM valida incluye empresa, destino y tag además del
     * punto y la letra. Con un contador sólo por letra, una tanda con pedidos de dos empresas
     * habría mezclado dos talonarios en la misma cuenta: el número de la segunda empresa saldría
     * de la serie de la primera. No se elige una empresa "representativa" ni se asume que la
     * instalación es de una sola.
     */
    const PV_FACTURA = Number(process.env.IM_PTO_VENTA_FACTURA || 777);
    const serieDe = (p: any): SerieComprobante => ({
      cod_empresa: Number(p.datos.cod_empresa), id_destino: ID_DESTINO_FACTURA, tag: 'S',
    });
    const numeros = new Map<string, number | null>();
    for (const p of preparados) {
      if (p.estado !== 'listo' || !p.datos || !p.letra) continue;
      const serie = serieDe(p);
      const clave = claveDeSerie(serie, 'FA', p.letra, PV_FACTURA);
      if (numeros.has(clave)) continue;
      numeros.set(clave, await proximoNumeroFactura(p.letra, PV_FACTURA, 30, 'FA', serie));
    }

    for (const p of preparados) {
      if (cortado) break;
      if (p.estado === 'no_se_puede' || !p.datos) { fallados.push(p.motivo ?? 'no se pudo facturar'); continue; }
      const f = p.fila;
      const quien = `${f.cliente_nombre ?? 'cliente ' + f.cod_cliente} (PR ${f.im_numero ?? f.im_comprobante_id})`;

      let control: string | null = null;
      try {
        control = await bloquearPresupuesto(String(f.im_comprobante_id), 'facturar');
      } catch (e: any) { fallados.push(`${quien}: ${e.message}`); continue; }
      try {
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
      let tipoFactura = f.im_factura_tipo ?? `FA ${p.letra ?? ''}`.trim();
      /** El id interno en IM de la factura: es lo que marca el remito como suyo. */
      let facturaId: string | null = f.im_factura_id ?? null;
      if (!f.im_factura_id) {
        const { data: revision, error: errRevision } = await sb().from('presupuestos_revision')
          .select('estado, huella').eq('tenant_id', TENANT_ID).eq('im_comprobante_id', String(f.im_comprobante_id)).maybeSingle();
        if (errRevision || revision?.estado !== 'aprobado') { fallados.push(`${quien}: no pude verificar una aprobación vigente.`); continue; }
        const { cabecera: cabActual, items: itemsActuales } = await leerComprobante(f.im_comprobante_id);
        try {
          exigirTipoEmpresa(cabActual, 'PR');
          if (cabActual.existe !== true || cabActual.anulada !== false) throw new Error('No pude verificar el presupuesto vigente.');
          exigirHuella(revision.huella, huellaPresupuesto(String(f.im_comprobante_id), cabActual, itemsActuales));
          // La aprobación y el payload parten de la misma lectura puntual bajo lock.
          const sinArticuloConImporte = itemsActuales.some(it => !(Number(it.cod_articulo) > 0) && Math.abs(Number(it.precio) * Number(it.cantidad)) >= 0.005);
          if (sinArticuloConImporte) throw new Error('Hay renglones sin artículo con importe: corregilos antes de facturar.');
          const renglones = itemsActuales.filter(it => Number(it.cod_articulo) > 0).map(it => {
            const descuento = Number(it.descuento_porc) || 0;
            return { cod_articulo: Number(it.cod_articulo), cantidad: Number(it.cantidad),
              precio: descuento && Number(it.precio_orig) > 0 ? Number(it.precio_orig) : Number(it.precio),
              descuento_porc: descuento, iva_por: Number(it.iva_por ?? 0), cod_lista_precios: it.cod_lista_precios };
          });
          if (!renglones.length) throw new Error('El presupuesto no tiene artículos para facturar.');
          p.datos = { ...p.datos, items: renglones, total: totalDeRenglones(renglones) ?? p.datos.total,
            cod_cliente: Number(cabActual.cod_cliente), cod_empresa: Number(cabActual.cod_empresa), cod_vendedor: Number(cabActual.cod_vendedor),
            observaciones: [`Pedido ${f.im_numero ?? ''}`, String(cabActual.observaciones ?? '').trim()].filter(Boolean).join(' - ').slice(0, MAX_OBSERVACIONES) };
          base.total = p.datos.total;
        } catch (e: any) { fallados.push(`${quien}: ${e.message}`); continue; }
        f.claim_token = randomUUID();
        // 🔴 RECLAMO. El rol administrativo lo tienen dos personas: si las dos aprietan Facturar
        // sobre la misma selección, las dos leen "no está facturado" y las dos emiten. La fila se
        // escribe ANTES de llamar a IM, y el índice único hace que la segunda choque.
        const reclamo = await reclamar(f, base);
        if (!reclamo.ok) { fallados.push(`${quien}: ${reclamo.error}`); continue; }

        const letra = p.letra!;
        const claveSerie = claveDeSerie(serieDe(p), 'FA', letra, PV_FACTURA);
        const fa = await emitirFactura({ ...p.datos, numero: numeros.get(claveSerie) ?? null } as any);
        if (fa.ok && fa.numero != null) numeros.set(claveSerie, Number(fa.numero) + 1);
        if (!fa.ok) {
          // Al log también: en pantalla se pierde, y es lo único que dice POR QUÉ IM la rechazó.
          console.error(`[facturarSeleccion] FACTURA rechazada · ${quien}: ${fa.error}`, JSON.stringify(fa.raw ?? null).slice(0, 600));
          fallados.push(`${quien}: ${fa.error}`);
          // El reclamo se suelta para que se pueda reintentar; si no se puede soltar, queda y
          // vence solo a los 5 minutos.
          if (!fa.sinRespuesta) await soltarReclamo(f);
          else await sb().from('presupuestos_facturados').update({ estado_emision: 'incierto' })
            .eq('tenant_id', TENANT_ID).eq('im_comprobante_id', String(f.im_comprobante_id)).eq('claim_token', f.claim_token!);
          // 🔴 Sin respuesta = NO se sabe si la factura salió. Se corta: seguir sería arriesgarse
          // a facturar dos veces al resto si IM está a medio camino.
          if (fa.sinRespuesta) cortado = `InfoManager no contestó al facturar ${quien}. NO se sabe si la factura se emitió: verificalo en IM antes de volver a intentar. Se frenó el resto.`;
          continue;
        }
        // Se guarda ANTES de seguir: un comprobante emitido sin registrar se vuelve a emitir.
        const { data: guardadaFa, error: errFa } = await sb().from('presupuestos_facturados').update({
          im_factura_id: fa.id, im_factura_numero: fa.numero, im_factura_tipo: fa.tipo,
          estado_emision: 'remito_pendiente', reclamado_at: new Date().toISOString(),
        }).eq('tenant_id', TENANT_ID).eq('im_comprobante_id', String(f.im_comprobante_id))
          .eq('claim_token', f.claim_token!).eq('estado_emision', 'factura_emitiendo').select('im_comprobante_id');
        // 🔴 La factura YA SALIÓ en InfoManager. Si no se pudo registrar, nadie sabe que existe:
        // se frena todo y el mensaje lleva el número para poder ir a buscarla.
        if (errFa || !guardadaFa?.length) {
          fallados.push(`${quien}: se emitió la FACTURA ${fa.numero} pero NO se pudo registrar (${errFa?.message ?? 'se perdió el reclamo'}).`);
          cortado = `Se emitió la factura ${fa.numero} de ${quien} y no se pudo guardar en la base (${errFa?.message ?? 'se perdió el reclamo'}). ANOTALA: hasta que se registre, el sistema la va a seguir viendo como pendiente. Se frenó el resto.`;
          continue;
        }
        facturaNumero = fa.numero;
        tipoFactura = fa.tipo;
        facturaId = fa.id;
      }

      // 2) REMITO
      // 🪤 Cuando la factura ya estaba emitida no se pasó por el reclamo de arriba, así que dos
      // reintentos superpuestos emitían DOS remitos — y el remito descuenta stock. Se reclama
      // acá con el mismo criterio.
      const tokenRemito = randomUUID();
      const { data: tomoRemito, error: errMarca } = await sb().rpc('tomar_remito', {
        p_tenant: TENANT_ID, p_id: String(f.im_comprobante_id), p_token: tokenRemito,
      });
      if (errMarca || tomoRemito !== true) {
        fallados.push(`${quien}: el remito está en curso o requiere verificar un intento anterior. No se emitió nada${errMarca ? ` (${errMarca.message})` : ''}.`);
        continue;
      }
      const marcarRemito = async (estado: string) => sb().from('presupuestos_facturados')
        .update({ estado_emision: estado }).eq('tenant_id', TENANT_ID).eq('im_comprobante_id', String(f.im_comprobante_id))
        .eq('claim_token', tokenRemito).eq('estado_emision', 'remito_emitiendo');
      /**
       * 🔗 El remito viaja marcado con la factura de la que sale. InfoManager no tiene ningún
       * campo para relacionarlos: lo escribe en las observaciones, y acá se copia esa misma
       * convención (ver `marcaDeFactura`). Mati (09/09/2026): *"no se están asociando los
       * comprobantes entre sí... para hacer una nota de crédito el sistema pide que esté
       * asociada a la factura"*.
       *
       * 🪤 `f.im_factura_id` es el caso "la factura ya estaba y falta sólo el remito"; `fa.id`
       * es el de la factura que se acaba de emitir en este mismo paso.
       */
      /**
       * 🔴 EL REMITO SE ARMA CON LOS RENGLONES DE LA FACTURA, NO CON LOS DEL PRESUPUESTO.
       *
       * Cuando la factura ya estaba emitida y falta sólo el remito, los renglones de `p.datos`
       * salen de leer el PRESUPUESTO **ahora**. Si alguien lo editó entre la factura y el
       * reintento, el remito sale por otra cosa que la factura: mercadería que salió del depósito
       * sin facturar.
       *
       * Pasó de verdad el 09/09/2026, en los dos pedidos cuyo remito había fallado por stock:
       *  · DIAZ PAZ  — RE 77388 $320.544,40 contra FA 50410 $274.981,52: salieron 4 CEREAL SIN
       *    AZUCAR X 2.5 KG por $45.562,88 sin facturar.
       *  · EL CEBILAR — RE 77392 $501.102,57 contra FA 18353 $453.410,90: 4 GRANOLA x 1,5 kg por
       *    $46.302,67, más $1.389 de diferencia en el costo de distribución.
       *
       * Con la factura ya emitida ella es la verdad: es el comprobante fiscal y lo que el cliente
       * va a pagar. El remito tiene que decir exactamente lo mismo.
       */
      /**
       * 🔴 SIEMPRE, aunque la factura se acabe de emitir en este mismo paso. Antes esto valía
       * sólo para el camino "ya estaba la factura, falta el remito", dando por sentado que una
       * factura recién emitida dice exactamente lo que se le mandó. NO es así.
       *
       * URUEÑA, 10/09/2026 (medido contra IM): se mandaron 23 renglones, la FA 50444 salió con
       * 22 —InfoManager se comió el artículo 1 sin avisar— y el remito, armado con los renglones
       * del presupuesto, salió con los 23: 2 BEBE x 25 Kg por $37.986,92 al cliente sin facturar.
       */
      let itemsRemito = (p.datos as any).items;
      const idFacturaViva = f.im_factura_id ?? facturaId;
      if (idFacturaViva) {
        const { cabecera: cabFa, items: itemsFa } = await leerComprobante(idFacturaViva);
        if (cabFa.existe !== true || cabFa.anulada !== false || cabFa.tipo_comprobante !== 'FA' || Number(cabFa.cod_cliente) !== Number(p.datos.cod_cliente) || Number(cabFa.cod_empresa) !== Number(p.datos.cod_empresa)) {
          await marcarRemito('remito_pendiente');
          fallados.push(`${quien}: no pude verificar la factura vigente para emitir su remito.`); continue;
        }
        const dela = await itemsDeLaFactura(String(idFacturaViva), itemsFa);
        if (!dela) {
          await marcarRemito('remito_pendiente');
          fallados.push(`${quien}: la factura ${facturaNumero ?? ''} está emitida pero no pude leer sus renglones en InfoManager, y el remito tiene que decir lo mismo que ella. Probá de nuevo en un rato.`);
          continue;
        }
        /**
         * 🔴 Y si la factura no dice lo que se le mandó, se avisa. El remito ya va a salir bien
         * —sale de ella—, pero alguien tiene que enterarse de que el cliente no está pagando algo
         * que pidió, hoy y no cuando no cuadre el stock.
         */
        const faltan = renglonesQueFaltan((p.datos as any).items ?? [], dela as any);
        if (faltan.length) {
          console.error(`[facturarSeleccion] la factura ${facturaNumero} de ${quien} salió SIN los artículos ${faltan.join(', ')} que se le mandaron`);
          fallados.push(`⚠️ ${quien}: InfoManager emitió la factura ${facturaNumero ?? ''} SIN el artículo ${faltan.join(', ')}, que sí estaba en el pedido. El remito sale igual que la factura, así que no se entrega de más — pero revisá ese pedido.`);
        }
        itemsRemito = dela;
        /**
         * 🔑 EL IMPORTE QUE SE MUESTRA PASA A SER EL DE LA FACTURA. Mati (10/09/2026): *"en la
         * parte de facturación sigue figurando el importe original y en la hoja de ruta tampoco
         * impacta"*. En URUEÑA el presupuesto decía $1.111.521,00 y la factura $1.073.534,08: el
         * repartidor iba a cobrar por el papel equivocado.
         */
        const totalReal = totalDeRenglones(dela as any);
        if (totalReal != null && Math.abs(totalReal - Number(base.total ?? 0)) > 0.02) {
          base.total = totalReal;
        }
      }
      const datosRemito = { ...(p.datos as any), total: totalDeRenglones(itemsRemito) ?? base.total, items: itemsRemito, im_factura_id: f.im_factura_id ?? facturaId };
      let re = await emitirRemito(datosRemito);
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
      /**
       * 🪤 Cuando el masivo TAMBIÉN falla, el motivo que se muestra tiene que ser EL SUYO, no el
       * de stock del primer intento. El 09/09/2026 el masivo moría por un choque de numeración y
       * en pantalla seguía diciendo "no hay stock, ajustalo en InfoManager": Jorgelina ajustaba
       * el stock, volvía a apretar y fallaba igual, porque el stock nunca había sido el problema.
       */
      let motivoMasivo: string | null = null;
      if (!re.ok && !re.sinRespuesta) {
        const faltantes = articulosSinStockDelError(re.error, catalogoEmision);
        if (faltantes) {
          console.warn(`[facturarSeleccion] ${quien}: IM rechazó el remito por stock (${faltantes}). Reintento por /remitos/masivo.`);
          const reintento = await emitirRemitoMasivo(datosRemito);
          if (reintento.ok) { re = reintento; remitoForzado = faltantes; }
          else {
            motivoMasivo = reintento.error;
            re = reintento;
            console.error(`[facturarSeleccion] ${quien}: el remito masivo tampoco salió: ${reintento.error}`);
          }
        }
      }
      if (!re.ok) {
        await marcarRemito(re.sinRespuesta ? 'incierto' : 'remito_pendiente');
        console.error(`[facturarSeleccion] REMITO rechazado · ${quien} (factura ${facturaNumero}): ${re.error}`, JSON.stringify(re.raw ?? null).slice(0, 600));
        /**
         * 🔑 El motivo real casi siempre es stock: IM contesta *"Artículos sin stock suficiente:
         * [{cod_articulo, cantidad, stock_disponible}]"*. Ese JSON crudo en pantalla no le dice
         * nada a nadie, así que se traduce a los nombres de los productos.
         */
        const faltantes = motivoMasivo ? null : articulosSinStockDelError(re.error, catalogoEmision);
        fallados.push(faltantes
          ? `${quien}: la FACTURA ${facturaNumero} se emitió, pero el REMITO no: InfoManager dice que no hay stock de ${faltantes}. Ajustá el stock en InfoManager y volvé a apretar Facturar (va a hacer sólo el remito), o hacelo a mano.`
          : `${quien}: la FACTURA ${facturaNumero} se emitió, pero el remito falló (${motivoMasivo ?? re.error}). Hacé el remito a mano.`);
        if (re.sinRespuesta) cortado = `InfoManager no contestó al emitir el remito de ${quien}. La factura ${facturaNumero} SÍ se emitió. Revisalo en IM. Se frenó el resto.`;
        continue;
      }
      const { data: guardadaRe, error: errRe } = await sb().from('presupuestos_facturados').update({
        total: datosRemito.total, im_factura_id: facturaId,
        im_factura_numero: facturaNumero, im_factura_tipo: tipoFactura,
        im_remito_id: re.id, im_remito_numero: re.numero,
        facturado_at: new Date().toISOString(), estado_emision: 'completo',
      }).eq('tenant_id', TENANT_ID).eq('im_comprobante_id', String(f.im_comprobante_id))
        .eq('claim_token', tokenRemito).eq('estado_emision', 'remito_emitiendo').select('im_comprobante_id');
      // Los dos comprobantes salieron y no se pudieron registrar: mismo criterio que arriba.
      if (errRe || !guardadaRe?.length) {
        fallados.push(`${quien}: salieron la factura ${facturaNumero} y el remito ${re.numero}, pero NO se pudieron registrar (${errRe?.message ?? 'se perdió el reclamo'}).`);
        cortado = `Se emitieron la factura ${facturaNumero} y el remito ${re.numero} de ${quien} y no se pudieron guardar en la base (${errRe?.message ?? 'se perdió el reclamo'}). ANOTALOS. Se frenó el resto.`;
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
      } finally { if (control) await desbloquearPresupuesto(String(f.im_comprobante_id), control); }
    }

    invalidarIM(); invalidarVista(); invalidarRemitos();
    res.json({
      ok: !fallados.length && !cortado,
      facturados: hechos.length, hechos, fallados, cortado,
      quedan_sin_facturar: preparados.length - hechos.length,
    });
  } catch (err: any) {
    invalidarIM(); invalidarVista(); invalidarRemitos();
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
    const refrescar = req.query.refrescar === '1';
    /**
     * 🔑 EL LISTADO DEL RANGO SE LEE UNA VEZ Y SE COMPARTE EN ESTA PETICIÓN.
     *
     * Esta pantalla lo necesitaba en tres lugares —la vista, el control de anulados y la
     * actualización de importes— y cada uno lo pedía por su cuenta. Hasta 10 días el cache de
     * `/ventas` las unía; más largos no se cachean (los meses del snapshot duplicarían la
     * memoria del proceso) y eran **tres lecturas completas del mismo rango** en una sola carga.
     *
     * 🪤 Se arranca ACÁ y se pasa la PROMESA hacia abajo, sin esperarla. Esperarla antes de la
     * vista serializaría las ventas contra el catálogo y el stock, que dentro arrancan juntos —y
     * el catálogo solo son 6 s en frío—: el arreglo saldría más caro que el problema.
     *
     * Si falla, no se corta nada: cada uno vuelve a su camino de siempre y decide qué hacer.
     */
    const ventasPendientes = fetchVentas(desde, hasta, { actualizar: refrescar }).catch(() => undefined);
    // Una sola lectura de cada cabecera en esta petición: las FA fuera del rango las piden tanto
    // el control de vigencia como la actualización de importes.
    const leerCabecera = cabecerasCompartidas();
    const vista = await vistaDeRango(desde, hasta, refrescar, ventasPendientes);
    // Acá sí se espera: los dos usos que siguen la necesitan resuelta. Ya está en vuelo desde
    // arriba, así que normalmente no cuesta nada.
    const ventasDelRango = await ventasPendientes;
    const todos = [...vista.pendientes, ...vista.asignados];
    const aprobados = todos.filter((p: any) => p.revision?.estado === 'aprobado');

    // La aprobación habilita una emisión NUEVA. Nunca decide si una factura ya emitida
    // aparece: un stock incompleto o un PR retirado de la vista no borra su historia.
    const lecturas = await Promise.all([
      sb().from('presupuestos_facturados').select('*').eq('tenant_id', TENANT_ID)
        .in('im_comprobante_id', todos.map((p: any) => String(p.im_comprobante_id))),
      sb().from('presupuestos_facturados').select('*').eq('tenant_id', TENANT_ID)
        .eq('cod_empresa', Number(process.env.PEDIDO_EMPRESA_DEFAULT || 1))
        .gte('fecha', desde).lte('fecha', hasta).not('im_factura_id', 'is', null),
    ]);
    const errEmitidos = lecturas.find(r => r.error)?.error;
    if (errEmitidos) { res.status(502).json({ error: `No pude leer qué se facturó ya: ${errEmitidos.message}` }); return; }
    const emitidos = [...new Map(lecturas.flatMap(r => r.data ?? [])
      .map((e: any) => [String(e.im_comprobante_id), e])).values()];
    /**
     * 🔴 Antes de mostrar nada: lo que se anuló en InfoManager deja de figurar como emitido.
     * Mati (10/09/2026): un cliente rechazó un pedido, anularon la factura en IM y en la app
     * seguía apareciendo como vigente.
     */
    const avisosAnulados = await sincronizarAnulados(
      (emitidos ?? []).map((e: any) => ({ ...e, im_comprobante_id: String(e.im_comprobante_id) })),
      // Las facturas del rango que se está mirando salen del listado, sin un GET por cada una.
      { desde, hasta, ventas: ventasDelRango },
      leerCabecera,
    ).catch((err: any) => {
      console.warn('[tableroFacturacion] no pude chequear anulados:', err?.message);
      return new Map<string, string>();
    });
    // `sincronizarAnulados` ya borró o limpió lo que hacía falta: se relee para no mostrar viejo.
    const { data: alDia, error: errAlDia } = avisosAnulados.size
      ? await sb().from('presupuestos_facturados').select('*').eq('tenant_id', TENANT_ID)
          .in('im_comprobante_id', emitidos.map((e: any) => String(e.im_comprobante_id)))
      : { data: emitidos, error: null };
    if (errAlDia) { res.status(502).json({ error: `No pude releer las facturas actualizadas: ${errAlDia.message}` }); return; }
    const actuales = await actualizarImportesFacturas(alDia ?? [], { ventas: ventasDelRango ?? await fetchVentas(desde, hasta), actualizar: refrescar, leerCabecera });
    const porId = new Map(actuales.map((e: any) => [String(e.im_comprobante_id), e]));

    /**
     * 🔑 LAS NOTAS DE CRÉDITO Y DÉBITO DE CADA FACTURA. Mati (10/09/2026): *"si se le hizo la NC
     * a Baca tiene que aparecer en el panel para poder verla"*. El vínculo nota→factura sólo
     * existe de nuestro lado: la API de IM no tiene ningún campo que lo guarde.
     */
    const idsFactura = [...new Set((alDia ?? []).map((e: any) => e.im_factura_id).filter(Boolean).map(String))];
    const notasPorFactura = new Map<string, any[]>();
    if (idsFactura.length) {
      const { data: correcciones, error: errNotas } = await sb().from('facturas_correcciones')
        .select('im_factura_id, im_comprobante_id, tipo, numero, total, motivo, created_at')
        .eq('tenant_id', TENANT_ID).in('im_factura_id', idsFactura)
        .order('created_at', { ascending: true });
      // 🪤 Que falte la tabla no puede tumbar la pantalla entera: se avisa por log y sigue.
      if (errNotas) console.warn('[tableroFacturacion] no pude leer las correcciones:', errNotas.message);
      for (const n of correcciones ?? []) {
        const k = String((n as any).im_factura_id);
        if (!notasPorFactura.has(k)) notasPorFactura.set(k, []);
        notasPorFactura.get(k)!.push({
          tipo: (n as any).tipo, numero: (n as any).numero, total: Number((n as any).total ?? 0),
          im_comprobante_id: String((n as any).im_comprobante_id), motivo: (n as any).motivo ?? null,
        });
      }
    }

    const porPresupuesto = new Map(todos.map((p: any) => [String(p.im_comprobante_id), p]));
    const bases = new Map(aprobados.map((p: any) => [String(p.im_comprobante_id), p]));
    for (const e of actuales) {
      if (!e.im_factura_id) continue;
      // El importe pertenece a la factura, aunque luego hayan editado su presupuesto.
      const p: any = porPresupuesto.get(String(e.im_comprobante_id));
      bases.set(String(e.im_comprobante_id), {
        ...p, im_comprobante_id: String(e.im_comprobante_id),
        im_numero: e.im_numero ?? p?.im_numero ?? null,
        cod_cliente: e.cod_cliente ?? p?.cod_cliente,
        cliente_nombre: e.cliente_nombre ?? p?.cliente_nombre ?? `Cliente ${e.cod_cliente}`,
        fecha: e.fecha ?? p?.fecha ?? null, total: Number(e.total ?? p?.total ?? 0),
        bultos: Number(e.bultos ?? p?.bultos ?? 0), kg: Number(e.kg ?? p?.kg ?? 0),
      });
    }
    const filas = [...bases.values()].map((p: any) => {
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
        falta_remito: !!e?.im_factura_id && !e?.facturado_at && e?.estado_emision === 'remito_pendiente',
        estado_emision: e?.estado_emision ?? null,
        // Lo que se anuló en InfoManager desde la última vez que se miró esta pantalla.
        aviso_anulado: avisosAnulados.get(String(p.im_comprobante_id)) ?? null,
        // Las NC/ND que corrigen esta factura: se ven en la fila y se pueden imprimir.
        notas: e?.im_factura_id ? (notasPorFactura.get(String(e.im_factura_id)) ?? []) : [],
        /**
         * 🔑 ¿La factura y el remito dicen las mismas cantidades? Sale de lo que esta misma
         * pantalla ya leyó: no cuesta ninguna consulta.
         *
         * 🪤 INFORMATIVO. No afirma que se haya entregado eso ni dice nada del stock, y no
         * cambia la aprobación, la emisión ni el cierre de una hoja.
         */
        control_fa_re: (() => {
          if (!e?.im_factura_id || !e?.im_remito_id) return null;
          const ev = (vista as any)[EVIDENCIA];
          const r = compararPar(e, ev);
          return {
            estado: r.estado, texto: textoControl(r), diferencias: r.diferencias ?? [],
            // 🪤 El momento en que se leyó, que con una vista servida del cache NO es ahora.
            checked_at: ev?.leidoEn ? new Date(ev.leidoEn).toISOString() : null,
          };
        })(),
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
        // 🪤 Sólo las diferencias CONFIRMADAS. Los no_verificado no son un problema a mostrar:
        // son pares que esta pantalla no alcanzó a comparar, y se ven en su propio detalle.
        con_diferencias: filas.filter(f => f.control_fa_re?.estado === 'diferencias').length,
      },
      // Lo que todavía no se aprobó, para que se vea por qué no está en la lista.
      sin_aprobar: todos.filter((p: any) => p.revision?.estado !== 'aprobado' && !porId.get(String(p.im_comprobante_id))?.im_factura_id).length,
    });
  } catch (err: any) {
    console.error('[tableroFacturacion]', err?.message);
    res.status(502).json({ error: `No se pudo armar el tablero de facturación: ${err?.message ?? 'sin respuesta de IM'}` });
  }
}
