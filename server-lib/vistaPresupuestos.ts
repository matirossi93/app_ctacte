/**
 * Los presupuestos que la oficina tiene que revisar, y el estado de esa revisión.
 *
 * 🔑 ES LA PRIMERA ETAPA DEL CIRCUITO (Mati, 08/09/2026): *"debería haber una sección de
 * presupuestos donde Jorgelina haría el primer filtrado, viendo todas las diferencias en las
 * listas, o stock y demás... y una vez que los presupuestos ya están ok, recién ahí entra la
 * parte de facturación"*. Después viene facturar, y la hoja de ruta es el ÚLTIMO paso.
 *
 * Esta vista salió de `hojasRuta.ts`, donde armaba la columna de pendientes del día. Se movió
 * acá y pasó a trabajar por RANGO porque Jorgelina *"ve franjas de varios días para el armado
 * de los pedidos"*, y porque ahora la consumen dos pantallas: la de revisión y la de armado.
 */
import { sb, TENANT_ID } from './supabase.js';
import {
  fetchVentas, fetchVentasItems, fetchArticulosCatalogo, fetchClientesIMCon,
  fetchStockPorDeposito, invalidarCacheVentas,
} from './infomanager.js';
import { pesoDeRenglones } from './pesoComprobante.js';
import { zonaDeCliente } from './zonaCliente.js';
import { revisarCantidades } from './controlCantidades.js';
import { formatosDeBolsa } from './formatosBolsa.js';
import { armarConsolidado } from './consolidadoArticulos.js';
import { buscarFacturasYaEmitidas } from './facturaYaEmitida.js';
import { evaluarPedido } from './listas.js';
import { reglasActivas, descuentosActivos, catalogoParaListas } from './pedidos.js';

/** Depósito contra el que se controla el stock. 1 = Depósito General (Casa Central). */
const DEPOSITO_CONTROL = Number(process.env.PEDIDO_DEPOSITO || 1);

/** Tope de días para los que se piden renglones. Cada día es ~1,2 s contra IM. */
const MAX_DIAS_ITEMS = 12;

/**
 * La vista del rango, cacheada un rato corto.
 *
 * Armarla cuesta varios segundos contra IM (ventas del día + renglones + catálogo + clientes) y
 * la oficina entra y sale de la pantalla todo el tiempo. 90 segundos alcanzan para que moverse
 * por el panel sea instantáneo sin que se note el retraso: un pedido que entra aparece en el
 * refresco siguiente, y el botón Actualizar saltea el cache.
 */
/** El panel es de Casa Central: la única sucursal que arma hojas de ruta. */
const COD_EMPRESA_CASA_CENTRAL = Number(process.env.PEDIDO_EMPRESA_DEFAULT || 1);
const VISTA_TTL_MS = 90_000;
const _vistaCache = new Map<string, { at: number; datos: any }>();

/**
 * El cache se tira cuando algo lo deja viejo: se asignó un pedido, se sacó, se revisó.
 *
 * 🪤 Antes se borraba sólo la clave de esa fecha. Con rangos eso no alcanza: un pedido del 4
 * aparece también en el rango 1→8, y esa entrada quedaba vieja mostrando el pedido como libre
 * cuando ya estaba en una hoja. Se limpia todo: son 90 segundos de cache, no un índice.
 */
/**
 * 🔑 Limpia TAMBIÉN el cache de `/ventas`. Los dos guardan lo mismo visto desde distinto lado:
 * si al emitir o anular sólo se tirara la vista, la reconstrucción saldría del listado viejo y
 * la pantalla mostraría exactamente lo que se acaba de cambiar, sin cambiar.
 */
export function invalidarVista() { _vistaCache.clear(); invalidarCacheVentas(); }

export async function vistaDeRango(desde: string, hasta: string, forzar = false) {
  const clave = `${desde}|${hasta}`;
  const hit = _vistaCache.get(clave);
  if (!forzar && hit && Date.now() - hit.at < VISTA_TTL_MS) return hit.datos;
  {
    // 🪤 Esto miraba SÓLO la fecha exacta y se perdía la mayoría de los pedidos. Medido el
    // 07/09/2026: había 225 presupuestos vigentes y el panel mostraba 59. Los otros 166 eran
    // de días anteriores sin facturar y de días futuros — porque la oficina MUEVE la fecha del
    // comprobante para reordenar los despachos, así que un pedido fechado para el 10 existe
    // desde antes. Un pedido que no aparece en la pantalla no entra en ninguna hoja y nadie
    // se entera hasta que llama el cliente.
    const [ventas, cat, stock] = await Promise.all([
      fetchVentas(desde, hasta),
      fetchArticulosCatalogo(),
      // Sin stock la pantalla igual sirve: se avisa que no se pudo consultar, no se inventa.
      // 🪤 `forzar` va también acá: el cache de stock dura 10 minutos y sin esto el botón
      // Actualizar refrescaba lo pedido en vivo contra un stock de hasta 10 minutos atrás. Los
      // dos lados de la resta tienen que tener la misma edad, sobre todo después de facturar
      // —que descuenta stock— que es justo cuando se aprieta el botón.
      fetchStockPorDeposito(DEPOSITO_CONTROL, forzar).catch(() => null),
    ]);
    /**
     * 🔑 Los clientes se piden DESPUÉS de las ventas, con los códigos que aparecen en ellas: un
     * cliente dado de alta hace un rato no está en el cache (dura 30 min) y la pantalla mostraba
     * *"Cliente 1347"* en vez de *"LEAL, Paulina (Este)"* (Mati, 09/09/2026). Normalmente sale
     * del cache y no cuesta nada; sólo va a buscarlo si falta alguno.
     */
    const clientes = await fetchClientesIMCon(ventas.map((v: any) => v.cod_cliente)).catch(() => []);

    const porCliente = new Map(clientes.map((c: any) => [Number(c.cod_cliente), c]));
    // El formato de bolsa de cada producto a granel: lo que haya cacheado, sin esperar.
    const formatos = formatosDeBolsa();

    /**
     * 🔴 SÓLO CASA CENTRAL: es la única que despacha con hoja de ruta (Mati, 09/09/2026). Hoy
     * los presupuestos son todos de la empresa 1 —medido: 152 de 152—, pero nada lo garantizaba,
     * y en la vista de remitos ese mismo agujero metía 1.852 comprobantes de las sucursales.
     */
    const presupuestos = ventas.filter((v: any) =>
      String(v.tipo_comprobante ?? '').trim() === 'PR' &&
      String(v.anulada ?? '').trim().toUpperCase() !== 'S' &&
      Number(v.cod_empresa) === COD_EMPRESA_CASA_CENTRAL);

    // 🪤 Los renglones NO se piden por toda la ventana. Medido contra IM el 07/09/2026:
    //   `/ventas/items` de 15 días -> 57.385 items en 23,7 s
    //   `/ventas/items` de 1 día   ->  4.132 items en  1,2 s
    // Con 23,7 s la request se pasa del timeout del proxy y el panel abría VACÍO. Se piden
    // sólo los días que de verdad tienen presupuestos vigentes (suelen ser un puñado), y de
    // a cuatro en paralelo para no golpear a IM.
    const fechasConPedidos = [...new Set(presupuestos
      .map((p: any) => String(p.fecha ?? '').slice(0, 10))
      .filter(Boolean))].sort().slice(-MAX_DIAS_ITEMS);
    const renglones = new Map<string, Array<{ cod_articulo: number; cantidad: any; equivalencia_um: number | null | undefined; cod_lista_precios: number; descuento_porc: number }>>();
    for (let i = 0; i < fechasConPedidos.length; i += 4) {
      const tanda = fechasConPedidos.slice(i, i + 4);
      const resultados = await Promise.all(tanda.map(f =>
        fetchVentasItems(f, f).catch((e: any) => {
          // Sin los renglones de un día, esos pedidos salen con 0 kg. Es mejor que no abrir.
          console.warn(`[hojasRuta] sin items del ${f}:`, e?.message);
          return [] as any[];
        })));
      for (const items of resultados) {
        for (const it of items) {
          const k = String((it as any).id_comprobante);
          if (!renglones.has(k)) renglones.set(k, []);
          renglones.get(k)!.push({
            cod_articulo: Number((it as any).cod_articulo),
            cantidad: (it as any).cantidad,
            equivalencia_um: cat.get(Number((it as any).cod_articulo))?.equivalencia_um,
            // Con qué lista y qué descuento quedó el renglón EN INFOMANAGER, ahora mismo.
            cod_lista_precios: Number((it as any).cod_lista_precios) || 0,
            descuento_porc: Number((it as any).descuento_porc) || 0,
          });
        }
      }
    }

    // Cuáles de estos presupuestos salieron de la app, para poder mostrar el vendedor y su error.
    const ids = presupuestos.map((p: any) => String(p.id));
    const { data: nuestros } = await sb().from('pedidos_vendedor')
      .select('id, im_presupuesto_id, cod_vendedor, estado, im_error')
      .eq('tenant_id', TENANT_ID).in('im_presupuesto_id', ids);
    const mio = new Map((nuestros ?? []).map((p: any) => [String(p.im_presupuesto_id), p]));

    /**
     * 🔄 LOS AVISOS DE LISTA SE RECALCULAN CONTRA INFOMANAGER, EN CADA REFRESCO.
     *
     * Mati (09/09/2026): *"las advertencias de precios siguen saliendo a pesar de que se hacen
     * las modificaciones correspondientes"*. Salían de `pedidos_vendedor_items.aviso_lista`, que
     * es una FOTO del momento en que el vendedor cargó el pedido: Jorgelina corregía la lista —acá
     * o en InfoManager— y el cartel seguía ahí para siempre, porque nadie volvía a mirar.
     *
     * Ahora se evalúan los renglones que están HOY en el comprobante. Dos consecuencias buenas:
     * el aviso desaparece cuando se corrige, y ahora vale para TODOS los presupuestos y no sólo
     * para el 24% que entra por la app.
     *
     * No cuesta ninguna llamada más a IM: los renglones ya se trajeron acá arriba, y las reglas y
     * el catálogo están cacheados.
     */
    const avisosPorPedido = new Map<string, string[]>();
    const gravedadPorPedido = new Map<string, { pierde_margen: number; cobra_de_mas: number }>();
    try {
      const [reglas, descuentos, catListas] = await Promise.all([
        reglasActivas(), descuentosActivos(), catalogoParaListas(),
      ]);
      for (const p of presupuestos) {
        const rs = renglones.get(String(p.id)) ?? [];
        if (!rs.length) continue;
        const r = evaluarPedido(
          rs.map(x => ({
            cod_articulo: x.cod_articulo, cantidad: Number(x.cantidad),
            cod_lista: x.cod_lista_precios, descuento: x.descuento_porc,
          })),
          catListas, reglas, descuentos);
        const g = { pierde_margen: 0, cobra_de_mas: 0 };
        const textos: string[] = [];
        for (const a of r.avisos) {
          /**
           * 🪤 "Tiene derecho a L2 y está en L1" es un FALSO POSITIVO cuando el renglón lleva
           * descuento: un descuento y una lista mejor son dos caminos al mismo precio y el
           * vendedor elige cuál usar (Mati, 27/08/2026 — L1 con 25% da exactamente L2). El
           * control en vivo lo resuelve comparando precios contra IM; acá eso serían dos
           * llamadas por renglón para toda la pantalla, así que se silencia directamente. Se
           * silencia sólo hacia el lado seguro: acusar de más a un vendedor que hizo bien las
           * cosas hace que después nadie mire ningún cartel.
           */
          const conDescuento = (rs[a.idx]?.descuento_porc ?? 0) > 0;
          if (a.severidad === 'margen') g.pierde_margen += 1;
          else if (a.severidad === 'cliente' && !conDescuento) g.cobra_de_mas += 1;
          else if (a.severidad === 'cliente') continue;
          if (a.mensaje) textos.push(a.mensaje);
          // El descuento fuera de tope es otro problema, y ese no depende de la lista.
          if (a.mensaje_descuento) textos.push(a.mensaje_descuento);
        }
        if (textos.length) avisosPorPedido.set(String(p.id), textos);
        if (g.pierde_margen || g.cobra_de_mas) gravedadPorPedido.set(String(p.id), g);
      }
    } catch (e: any) {
      // Sin reglas la pantalla sirve igual: muestra los pedidos sin los carteles de lista. Lo que
      // no puede es no abrir por esto.
      console.warn('[vistaPresupuestos] no pude evaluar las listas:', e?.message);
    }

    // En qué quedó la revisión de la oficina. `null` = todavía no la miró nadie.
    const { data: revisiones } = await sb().from('presupuestos_revision')
      .select('im_comprobante_id, estado, observacion, revisado_at')
      .eq('tenant_id', TENANT_ID).in('im_comprobante_id', ids);
    const revisionPor = new Map((revisiones ?? []).map((r: any) => [String(r.im_comprobante_id), r]));

    /**
     * Dónde está ya asignado cada comprobante.
     *
     * 🔄 Desde el 08/09/2026 la hoja se arma con REMITOS, así que buscar el presupuesto en
     * `hojas_ruta_pedidos` no encuentra nada y el badge "en una hoja" no se mostraba nunca más.
     * Se busca el presupuesto **y** el remito que salió de él.
     */
    const { data: emitidos } = await sb().from('presupuestos_facturados')
      .select('im_comprobante_id, im_remito_id').eq('tenant_id', TENANT_ID).in('im_comprobante_id', ids);
    const remitoDe = new Map((emitidos ?? [])
      .filter((e: any) => e.im_remito_id)
      .map((e: any) => [String(e.im_comprobante_id), String(e.im_remito_id)]));
    const aBuscar = [...new Set([...ids, ...remitoDe.values()])];
    const { data: asignados } = await sb().from('hojas_ruta_pedidos')
      .select('im_comprobante_id, hoja_id').in('im_comprobante_id', aBuscar);
    const hojaPorId = new Map((asignados ?? []).map((a: any) => [String(a.im_comprobante_id), String(a.hoja_id)]));
    const enHoja = new Map<string, string>();
    for (const id of ids) {
      const h = hojaPorId.get(id) ?? (remitoDe.has(id) ? hojaPorId.get(remitoDe.get(id)!) : undefined);
      if (h) enHoja.set(id, h);
    }

    /**
     * Y cuáles los pasa a buscar el cliente: ésos ya tienen destino, igual que los de una hoja.
     *
     * 🔄 Sin esto seguían apareciendo en "pedidos sin asignar" después de marcarlos, así que la
     * pantalla no daba ninguna señal de que la acción hubiera hecho algo — y se los podía mandar
     * a una hoja igual, quedando en el camión Y en el mostrador (auditoría del 08/09/2026).
     */
    const { data: retiros } = await sb().from('retiros_sucursal')
      .select('im_comprobante_id').eq('tenant_id', TENANT_ID).in('im_comprobante_id', aBuscar);
    const retiroPorId = new Set((retiros ?? []).map((r: any) => String(r.im_comprobante_id)));
    const enRetiro = new Set<string>(ids.filter((id: string) =>
      retiroPorId.has(id) || (remitoDe.has(id) && retiroPorId.has(remitoDe.get(id)!))));

    /**
     * 🔑 Y cuáles ya SALIERON del depósito, que es cosa distinta de "está en una hoja".
     *
     * El remito es el que mueve stock, y en el circuito nuevo se emite ANTES de armar la hoja:
     * en toda esa ventana el presupuesto seguía figurando como pendiente. Para el consolidado
     * eso significaba contar una demanda que el stock ya tenía descontada, o sea faltantes al
     * doble. Auditoría del 08/09/2026.
     */
    const { data: facturados } = await sb().from('presupuestos_facturados')
      .select('im_comprobante_id, im_remito_numero, facturado_at')
      .eq('tenant_id', TENANT_ID).in('im_comprobante_id', ids);
    const yaSalio = new Set((facturados ?? [])
      .filter((f: any) => f.im_remito_numero != null || f.facturado_at != null)
      .map((f: any) => String(f.im_comprobante_id)));

    /**
     * 🔴 ¿Cuál de estos presupuestos ya tiene su factura? Mati (09/09/2026): *"tenemos que
     * incorporar en la parte de presupuestos que diga si ya está facturado o no"*, después de que
     * facturar uno ya facturado emitiera una SEGUNDA factura real (la 50401).
     *
     * InfoManager no lo marca: medido ese día, los 35 presupuestos con factura y los 23 sin ella
     * están todos en `tipo_presupuesto: 'C'`. Se deduce comparando contra las facturas reales del
     * rango — mismo cliente, mismo importe al centavo.
     */
    const { data: nuestrasFact } = await sb().from('presupuestos_facturados')
      .select('im_comprobante_id, im_factura_id, im_factura_numero, im_factura_tipo')
      .eq('tenant_id', TENANT_ID).not('im_factura_id', 'is', null);
    const nuestras = new Map((nuestrasFact ?? []).map((n: any) => [String(n.im_comprobante_id), {
      im_factura_id: n.im_factura_id ?? null,
      im_factura_numero: n.im_factura_numero ?? null,
      im_factura_tipo: n.im_factura_tipo ?? null,
    }]));
    const facturasVigentes = ventas.filter((v: any) =>
      String(v.tipo_comprobante ?? '').trim() === 'FA' &&
      String(v.anulada ?? '').trim().toUpperCase() !== 'S');
    const facturaDelPresupuesto = buscarFacturasYaEmitidas(
      presupuestos.map((p: any) => ({
        im_comprobante_id: String(p.id), cod_cliente: Number(p.cod_cliente), total: Number(p.total ?? 0),
      })),
      facturasVigentes as any, nuestras,
    );

    /**
     * 🔴 DOS PRESUPUESTOS VIVOS DEL MISMO CLIENTE EL MISMO DÍA.
     *
     * Casi siempre es el rastro de una edición que salió mal: se creó el reemplazo y el original
     * quedó vivo, o dos personas editaron el mismo pedido por caminos distintos. Los dos se
     * pueden facturar, y facturar los dos es mandarle al cliente el doble de mercadería.
     *
     * Pasó el 09/09/2026 con NAVARRO, Andrea (PR 58309 y 58317, $259.850 y $264.370, los dos del
     * mismo día). No se bloquea nada —un cliente puede pedir dos veces en el día— pero tiene que
     * saltar a la vista antes de facturar.
     */
    const vivosPorClienteDia = new Map<string, string[]>();
    for (const p of presupuestos) {
      const k = `${Number(p.cod_cliente)}|${String(p.fecha ?? '').slice(0, 10)}`;
      if (!vivosPorClienteDia.has(k)) vivosPorClienteDia.set(k, []);
      vivosPorClienteDia.get(k)!.push(String(p.id));
    }

    const filas = presupuestos.map((p: any) => {
      const c = porCliente.get(Number(p.cod_cliente));
      const z = zonaDeCliente(c);
      const rs = renglones.get(String(p.id)) ?? [];
      const peso = pesoDeRenglones(rs);
      const propio = mio.get(String(p.id));

      // Lo que se pide y no está en el depósito. `stock === null` = no se pudo consultar, que
      // NO es lo mismo que "no hay": en ese caso no se marca nada.
      const faltantes = stock
        ? rs.map(r => {
            const hay = stock.get(Number(r.cod_articulo));
            const pide = Number(r.cantidad);
            return { cod_articulo: Number(r.cod_articulo), descripcion: cat.get(Number(r.cod_articulo))?.descripcion ?? `Artículo ${r.cod_articulo}`, pedido: pide, disponible: hay ?? null };
          }).filter(f => f.disponible != null && f.disponible < f.pedido)
        : [];
      // Y la cantidad que no cierra con el formato del producto (kilos donde van bultos).
      const avisosCantidad = revisarCantidades(rs, cat, formatos);
      return {
        im_comprobante_id: String(p.id),
        im_numero: p.numero ?? null,
        fecha: p.fecha ?? null,
        // Un pedido de un día anterior que sigue vigente es arrastre: se quedó sin salir.
        // Se marca para que salte a la vista y no se mezcle con los del día.
        de_otro_dia: String(p.fecha ?? '').slice(0, 10) !== hasta,
        /**
         * 🔑 Lo que escribió el vendedor en el pedido. Mati (08/09/2026): *"las observaciones que
         * están en los presupuestos es muy importante que las podamos ver en el panel"*, y ya
         * había avisado el 01/09 que es *"el campo que utilizamos acá a la hora de facturar"*.
         * Ahí van cosas que cambian la factura o la entrega: "facturar a nombre de la SRL",
         * "entregar el jueves temprano", "avisar antes de ir".
         */
        observaciones: typeof p.observaciones === 'string' && p.observaciones.trim()
          ? p.observaciones.trim() : null,
        cod_cliente: Number(p.cod_cliente),
        cliente_nombre: c?.razon_social ?? c?.nombre ?? `Cliente ${p.cod_cliente}`,
        cod_zona: z.cod_zona,
        zona: z.nombre,
        zona_origen: z.origen,
        total: Number(p.total ?? 0),
        bultos: peso.bultos,
        kg: peso.kg,
        // Si son muchos, el total de kilos miente POR ABAJO y la hoja puede sobrecargar.
        renglones_sin_peso: peso.renglones_sin_peso,
        de_la_app: !!propio,
        pedido_id: propio?.id ?? null,
        cod_vendedor: propio?.cod_vendedor ?? p.cod_vendedor ?? null,
        // 🔄 Recalculados contra lo que está HOY en InfoManager, para todos los presupuestos.
        avisos: avisosPorPedido.get(String(p.id)) ?? [],
        // Para qué lado está el error de lista, que es lo que decide si urge mirarlo.
        gravedad: gravedadPorPedido.get(String(p.id)) ?? { pierde_margen: 0, cobra_de_mas: 0 },
        im_error: propio?.im_error ?? null,
        hoja_id: enHoja.get(String(p.id)) ?? null,
        // Lo pasa a buscar el cliente: no sale en ninguna hoja.
        en_retiro: enRetiro.has(String(p.id)),
        // Su mercadería ya salió del depósito (hay remito), así que ya descontó stock.
        ya_salio: yaSalio.has(String(p.id)),
        /**
         * La factura que YA tiene este presupuesto, si tiene. `nuestra` = la emitimos desde el
         * panel · `deducida` = hay una del mismo cliente por el mismo importe. Facturar uno que
         * ya está facturado emite una factura duplicada de verdad: pasó el 09/09/2026.
         */
        factura: facturaDelPresupuesto.get(String(p.id)) ?? null,
        /**
         * Los OTROS presupuestos vigentes del mismo cliente en el mismo día. Vacío es lo normal;
         * con algo adentro hay que mirar cuál va antes de facturar.
         */
        hermanos: (vivosPorClienteDia.get(`${Number(p.cod_cliente)}|${String(p.fecha ?? '').slice(0, 10)}`) ?? [])
          .filter((otro: string) => otro !== String(p.id))
          .map((otro: string) => {
            const o = presupuestos.find((x: any) => String(x.id) === otro);
            return { im_comprobante_id: otro, im_numero: o?.numero ?? null, total: Number(o?.total ?? 0) };
          }),
        // La etapa 1: aprobado / observado / null (sin revisar).
        revision: revisionPor.get(String(p.id)) ?? null,
        // Los dos controles que pidió Mati además de las listas.
        faltantes,
        avisos_cantidad: avisosCantidad.map(a => a.texto),
        stock_consultado: !!stock,
      };
    });

    const datos = {
      // 🔑 "Pendiente" es lo que todavía no tiene destino: ni hoja ni retiro en sucursal.
      pendientes: filas.filter(f => !f.hoja_id && !f.en_retiro),
      asignados: filas.filter(f => f.hoja_id),
      en_retiro: filas.filter(f => f.en_retiro).length,
      // Para que la pantalla pueda mostrar "3 pedidos para revisar" sin recorrer todo.
      con_avisos: filas.filter(f => f.avisos.length > 0).length,
      // Los dos números que de verdad importan, separados: uno es plata que se pierde, el
      // otro es un cliente al que le están cobrando de más.
      pierde_margen: filas.filter(f => f.gravedad.pierde_margen > 0).length,
      cobra_de_mas: filas.filter(f => f.gravedad.cobra_de_mas > 0).length,
      sin_zona: filas.filter(f => f.cod_zona == null).length,
      // Lo que decide si la etapa 1 está terminada: qué falta mirar y qué quedó observado.
      sin_stock: filas.filter(f => f.faltantes.length > 0).length,
      // Lo que ya está facturado: no hay que volver a emitirlo.
      ya_facturados: filas.filter(f => f.factura).length,
      // Clientes con más de un presupuesto vivo el mismo día: hay que mirar cuál va.
      duplicados: filas.filter(f => f.hermanos.length > 0).length,
      con_cantidad_rara: filas.filter(f => f.avisos_cantidad.length > 0).length,
      sin_revisar: filas.filter(f => !f.revision).length,
      aprobados: filas.filter(f => f.revision?.estado === 'aprobado').length,
      observados: filas.filter(f => f.revision?.estado === 'observado').length,
      de_otros_dias: filas.filter(f => f.de_otro_dia && !f.hoja_id).length,
      /**
       * 🔑 Cuánto se pidió de cada artículo en TODO el rango, contra lo que hay.
       *
       * Mati (08/09/2026), corrigiendo el control que ya existía: *"eso se está midiendo factura
       * a factura, esa no era la idea"*. Mirando de a un presupuesto por vez, tres clientes que
       * piden 200 con 300 en depósito parecen los tres servibles. La pregunta —a quién le doy—
       * sólo se contesta sumando primero.
       *
       * Sale de los renglones que ya se trajeron acá arriba: no cuesta ni una llamada más a IM.
       * Suma lo que TODAVÍA NO SALIÓ del depósito —lo demás ya está descontado del stock—, y
       * eso lo decide el remito, no la hoja: se factura antes de armarla.
       */
      consolidado: armarConsolidado(
        // 🔑 Van TODOS: el que decide si compite por el stock es `ya_salio`, no dónde está.
        filas.map(f => ({
          im_comprobante_id: f.im_comprobante_id,
          im_numero: f.im_numero,
          cod_cliente: f.cod_cliente,
          cliente_nombre: f.cliente_nombre,
          revision_estado: (f.revision as any)?.estado ?? null,
          ya_salio: f.ya_salio,
          // "30 × MAIZ X 30 KG" = 900 kg: una cantidad así infla el total de su artículo.
          cantidad_dudosa: f.avisos_cantidad.length > 0,
        })),
        renglones,
        cat,
        stock,
      ),
    };
    _vistaCache.set(clave, { at: Date.now(), datos });
    return datos;
  }
}

