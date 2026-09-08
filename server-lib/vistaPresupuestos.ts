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
  fetchVentas, fetchVentasItems, fetchArticulosCatalogo, fetchClientesIMCached,
  fetchStockPorDeposito,
} from './infomanager.js';
import { pesoDeRenglones } from './pesoComprobante.js';
import { zonaDeCliente } from './zonaCliente.js';
import { revisarCantidades } from './controlCantidades.js';
import { formatosDeBolsa } from './formatosBolsa.js';
import { armarConsolidado } from './consolidadoArticulos.js';

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
const VISTA_TTL_MS = 90_000;
const _vistaCache = new Map<string, { at: number; datos: any }>();

/**
 * El cache se tira cuando algo lo deja viejo: se asignó un pedido, se sacó, se revisó.
 *
 * 🪤 Antes se borraba sólo la clave de esa fecha. Con rangos eso no alcanza: un pedido del 4
 * aparece también en el rango 1→8, y esa entrada quedaba vieja mostrando el pedido como libre
 * cuando ya estaba en una hoja. Se limpia todo: son 90 segundos de cache, no un índice.
 */
export function invalidarVista() { _vistaCache.clear(); }

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
    const [ventas, cat, clientes, stock] = await Promise.all([
      fetchVentas(desde, hasta),
      fetchArticulosCatalogo(),
      fetchClientesIMCached().catch(() => []),
      // Sin stock la pantalla igual sirve: se avisa que no se pudo consultar, no se inventa.
      fetchStockPorDeposito(DEPOSITO_CONTROL).catch(() => null),
    ]);

    const porCliente = new Map(clientes.map((c: any) => [Number(c.cod_cliente), c]));
    // El formato de bolsa de cada producto a granel: lo que haya cacheado, sin esperar.
    const formatos = formatosDeBolsa();

    const presupuestos = ventas.filter((v: any) =>
      String(v.tipo_comprobante ?? '').trim() === 'PR' &&
      String(v.anulada ?? '').trim().toUpperCase() !== 'S');

    // 🪤 Los renglones NO se piden por toda la ventana. Medido contra IM el 07/09/2026:
    //   `/ventas/items` de 15 días -> 57.385 items en 23,7 s
    //   `/ventas/items` de 1 día   ->  4.132 items en  1,2 s
    // Con 23,7 s la request se pasa del timeout del proxy y el panel abría VACÍO. Se piden
    // sólo los días que de verdad tienen presupuestos vigentes (suelen ser un puñado), y de
    // a cuatro en paralelo para no golpear a IM.
    const fechasConPedidos = [...new Set(presupuestos
      .map((p: any) => String(p.fecha ?? '').slice(0, 10))
      .filter(Boolean))].sort().slice(-MAX_DIAS_ITEMS);
    const renglones = new Map<string, Array<{ cod_articulo: number; cantidad: any; equivalencia_um: number | null | undefined }>>();
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
          });
        }
      }
    }

    // Lo que aporta la app sobre los pedidos que salieron de ella: los avisos del control de
    // listas, que es lo que le dice a la oficina DÓNDE mirar en vez de revisar todo.
    const ids = presupuestos.map((p: any) => String(p.id));
    const { data: nuestros } = await sb().from('pedidos_vendedor')
      .select('id, im_presupuesto_id, cod_vendedor, estado, im_error')
      .eq('tenant_id', TENANT_ID).in('im_presupuesto_id', ids);
    const mio = new Map((nuestros ?? []).map((p: any) => [String(p.im_presupuesto_id), p]));
    const { data: avisos } = await sb().from('pedidos_vendedor_items')
      .select('pedido_id, aviso_lista, lista_sugerida, cod_lista_precios')
      .in('pedido_id', (nuestros ?? []).map((p: any) => p.id))
      .not('aviso_lista', 'is', null);
    const avisosPorPedido = new Map<string, string[]>();
    // 🔑 Los avisos NO son todos iguales y mezclarlos hace que no se mire ninguno: el 07/09
    // había 36 pedidos marcados sobre 59, y así "revisar" deja de querer decir algo.
    // Las listas de IM van de más cara a más barata según el número (12=L1 … 15=L4), así que
    // comparando la lista puesta contra la sugerida se sabe para qué lado está el error:
    //   puesta > sugerida  -> más barata de lo que corresponde  -> PIERDE MARGEN la empresa
    //   puesta < sugerida  -> más cara                          -> le cobran de más al cliente
    // Se clasifica con los CÓDIGOS y no leyendo el texto del aviso, que puede cambiar.
    const gravedadPorPedido = new Map<string, { pierde_margen: number; cobra_de_mas: number }>();
    for (const a of avisos ?? []) {
      const k = String((a as any).pedido_id);
      if (!avisosPorPedido.has(k)) avisosPorPedido.set(k, []);
      avisosPorPedido.get(k)!.push(String((a as any).aviso_lista));
      const g = gravedadPorPedido.get(k) ?? { pierde_margen: 0, cobra_de_mas: 0 };
      const puesta = Number((a as any).cod_lista_precios);
      const sugerida = Number((a as any).lista_sugerida);
      if (Number.isFinite(puesta) && Number.isFinite(sugerida) && sugerida > 0) {
        if (puesta > sugerida) g.pierde_margen += 1;
        else if (puesta < sugerida) g.cobra_de_mas += 1;
      }
      gravedadPorPedido.set(k, g);
    }

    // En qué quedó la revisión de la oficina. `null` = todavía no la miró nadie.
    const { data: revisiones } = await sb().from('presupuestos_revision')
      .select('im_comprobante_id, estado, observacion, revisado_at')
      .eq('tenant_id', TENANT_ID).in('im_comprobante_id', ids);
    const revisionPor = new Map((revisiones ?? []).map((r: any) => [String(r.im_comprobante_id), r]));

    // Dónde está ya asignado cada comprobante.
    const { data: asignados } = await sb().from('hojas_ruta_pedidos')
      .select('im_comprobante_id, hoja_id').in('im_comprobante_id', ids);
    const enHoja = new Map((asignados ?? []).map((a: any) => [String(a.im_comprobante_id), String(a.hoja_id)]));

    /**
     * Y cuáles los pasa a buscar el cliente: ésos ya tienen destino, igual que los de una hoja.
     *
     * 🔄 Sin esto seguían apareciendo en "pedidos sin asignar" después de marcarlos, así que la
     * pantalla no daba ninguna señal de que la acción hubiera hecho algo — y se los podía mandar
     * a una hoja igual, quedando en el camión Y en el mostrador (auditoría del 08/09/2026).
     */
    const { data: retiros } = await sb().from('retiros_sucursal')
      .select('im_comprobante_id').eq('tenant_id', TENANT_ID).in('im_comprobante_id', ids);
    const enRetiro = new Set((retiros ?? []).map((r: any) => String(r.im_comprobante_id)));

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
        avisos: propio ? (avisosPorPedido.get(String(propio.id)) ?? []) : [],
        // Para qué lado está el error de lista, que es lo que decide si urge mirarlo.
        gravedad: propio ? (gravedadPorPedido.get(String(propio.id)) ?? { pierde_margen: 0, cobra_de_mas: 0 }) : { pierde_margen: 0, cobra_de_mas: 0 },
        im_error: propio?.im_error ?? null,
        hoja_id: enHoja.get(String(p.id)) ?? null,
        // Lo pasa a buscar el cliente: no sale en ninguna hoja.
        en_retiro: enRetiro.has(String(p.id)),
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
       * Y suma sólo los PENDIENTES: lo que ya está en una hoja o en retiro salió con su remito y
       * por lo tanto ya descontó stock en InfoManager.
       */
      consolidado: armarConsolidado(
        filas
          .filter(f => !f.hoja_id && !f.en_retiro)
          .map(f => ({
            im_comprobante_id: f.im_comprobante_id,
            im_numero: f.im_numero,
            cod_cliente: f.cod_cliente,
            cliente_nombre: f.cliente_nombre,
            revision_estado: (f.revision as any)?.estado ?? null,
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

