/**
 * LO QUE SALE EN EL CAMIÓN: los remitos del día.
 *
 * 🔑 Mati (08/09/2026): *"la hoja de ruta debería armarse en función a las facturas, que ese va
 * a ser el definitivo de los comprobantes, el que manda junto con el remito"*. Medido contra IM
 * antes de elegir, sobre Casa Central:
 *
 * | día   | presupuestos | facturas | remitos |
 * |-------|--------------|----------|---------|
 * | 02/09 | 39           | 67       | 67      |
 * | 03/09 | 16           | 55       | 55      |
 * | 04/09 | 50           | 46       | 46      |
 *
 * Dos conclusiones que decidieron el diseño:
 *  · **Se factura bastante más de lo que se presupuesta.** Armando la hoja con presupuestos se
 *    perdía de vista todo lo que la oficina factura directo, sin pedido previo.
 *  · **Factura y remito van uno a uno**, así que da igual cuál se elija para listar… salvo los
 *    días en que no: el 05/09 hubo 25 facturas y 29 remitos. Por eso manda el REMITO: es el papel
 *    que viaja con la mercadería y el que mueve stock. Una factura sin remito no sale en el
 *    camión; un remito sin factura, sí.
 *
 * La factura se muestra al lado, deducida en `aparearFactura.ts` — InfoManager no guarda esa
 * relación.
 */
import { sb, TENANT_ID } from './supabase.js';
import {
  fetchVentas, fetchVentasItems, fetchArticulosCatalogo, fetchClientesIMCached,
} from './infomanager.js';
import { pesoDeRenglones } from './pesoComprobante.js';
import { zonaDeCliente } from './zonaCliente.js';
import { aparearFacturas } from './aparearFactura.js';

/**
 * Tope de días para los que se piden renglones: cada uno cuesta ~1,2 s contra IM.
 *
 * 🪤 Estaba en 12 contra una ventana de 15 (`VENTANA_DIAS` en hojasRuta.ts), así que con el
 * arrastre completo los 4 días más viejos NO se pedían: esos remitos salían con 0 kg y 0 bultos
 * —indistinguibles de uno liviano de verdad, porque `renglones_sin_peso` también daba 0— y los
 * kilos del camión mentían por abajo sin ninguna señal. Ahora cubre la ventana entera y, si
 * igual queda alguno afuera, se avisa. Auditoría del 08/09/2026.
 */
const MAX_DIAS_ITEMS = 16;
const VISTA_TTL_MS = 90_000;
const _cache = new Map<string, { at: number; datos: any }>();

/** Se tira cuando algo la deja vieja: se asignó un remito a una hoja, se sacó, se marcó retiro. */
export function invalidarRemitos() { _cache.clear(); }

const esTipo = (v: any, t: string) => String(v?.tipo_comprobante ?? '').trim() === t;
const vigente = (v: any) => String(v?.anulada ?? '').trim().toUpperCase() !== 'S';

export async function vistaRemitos(desde: string, hasta: string, forzar = false) {
  const clave = `${desde}|${hasta}`;
  const hit = _cache.get(clave);
  if (!forzar && hit && Date.now() - hit.at < VISTA_TTL_MS) return hit.datos;

  const [ventas, cat, clientes] = await Promise.all([
    fetchVentas(desde, hasta),
    fetchArticulosCatalogo(),
    fetchClientesIMCached().catch(() => []),
  ]);
  const porCliente = new Map(clientes.map((c: any) => [Number(c.cod_cliente), c]));

  const remitos = ventas.filter(v => esTipo(v, 'RE') && vigente(v));
  const facturas = ventas.filter(v => esTipo(v, 'FA') && vigente(v));

  // Los renglones, sólo de los días que de verdad tienen remitos (ver vistaPresupuestos.ts).
  const todasLasFechas = [...new Set(remitos.map((r: any) => String(r.fecha ?? '').slice(0, 10)).filter(Boolean))].sort();
  const fechas = todasLasFechas.slice(-MAX_DIAS_ITEMS);
  // Los que quedaron fuera del tope: sus remitos van a salir sin peso y hay que decirlo.
  const fechasSinPedir = todasLasFechas.slice(0, Math.max(0, todasLasFechas.length - MAX_DIAS_ITEMS));
  const renglones = new Map<string, Array<{ cod_articulo: number; cantidad: any; equivalencia_um: number | null | undefined }>>();
  const diasSinItems: string[] = [...fechasSinPedir];
  for (let i = 0; i < fechas.length; i += 4) {
    const tanda = fechas.slice(i, i + 4);
    const resultados = await Promise.all(tanda.map(f =>
      fetchVentasItems(f, f).catch((e: any) => {
        // 🪤 Sin los renglones de un día, esos remitos salen con 0 kg. Se anota para poder
        // avisarlo: un peso que miente por abajo hace que la hoja parezca entrar en el camión.
        console.warn(`[vistaRemitos] sin items del ${f}:`, e?.message);
        diasSinItems.push(f);
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

  const ids = remitos.map((r: any) => String(r.id));

  /**
   * 🪤 Tope explícito. Estas consultas mandan los ids en la URL (`in.(...)`), y con `dias=15` son
   * ~800: medido, 19.887 caracteres, muy por encima de los 8 KB que acepta el proxy. Un 414 haría
   * que `enHoja` viniera vacío y **todos los remitos ya asignados volvieran a la columna de
   * pendientes**. Se parte en tandas, igual que el resto del módulo. Auditoría del 08/09/2026.
   */
  const enTandas = async <T>(fn: (tanda: string[]) => PromiseLike<{ data: T[] | null; error: any }>) => {
    const filas: T[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await fn(ids.slice(i, i + 200));
      // 🔴 "No pude preguntar" NO es "no hay": si esto fallara en silencio, la pantalla ofrecería
      // volver a cargar en un camión lo que ya está cargado.
      if (error) throw new Error(error.message);
      filas.push(...(data ?? []));
    }
    return filas;
  };

  /**
   * El vínculo REAL de lo que emitimos desde el panel. Se pide también el presupuesto de origen
   * (`im_comprobante_id`): hace falta para el guard de más abajo.
   */
  const nuestros = await enTandas<any>(t => sb().from('presupuestos_facturados')
    .select('im_comprobante_id, im_remito_id, im_factura_id, im_factura_numero, im_factura_tipo')
    .eq('tenant_id', TENANT_ID).in('im_remito_id', t));
  const vinculados = new Map(nuestros
    .filter((f: any) => f.im_remito_id)
    .map((f: any) => [String(f.im_remito_id), {
      im_factura_id: f.im_factura_id ?? null,
      im_factura_numero: f.im_factura_numero ?? null,
      im_factura_tipo: f.im_factura_tipo ?? null,
    }]));
  const facturaDe = aparearFacturas(remitos as any, facturas as any, vinculados);

  /**
   * 🔴 El presupuesto del que salió cada remito. Sin esto, una hoja armada ANTES del cambio a
   * remitos guarda el presupuesto, y su remito aparecía igual como pendiente: la misma mercadería
   * terminaba en dos hojas —dos camiones— y el chofer cobraba dos veces por una sola entrega.
   * El índice único es sobre `im_comprobante_id`, así que la base no lo frena: son dos filas
   * distintas para la misma entrega. Auditoría del 08/09/2026.
   */
  const presuDelRemito = new Map<string, string>();
  for (const f of nuestros) {
    if (f.im_remito_id && f.im_comprobante_id) presuDelRemito.set(String(f.im_remito_id), String(f.im_comprobante_id));
  }
  const idsAmirar = [...new Set([...ids, ...presuDelRemito.values()])];

  // Dónde está cada uno: en una hoja, o el cliente lo pasa a buscar.
  const buscarEn = async (tabla: string, extra?: (q: any) => any) => {
    const filas: any[] = [];
    for (let i = 0; i < idsAmirar.length; i += 200) {
      let q = sb().from(tabla).select(tabla === 'hojas_ruta_pedidos' ? 'im_comprobante_id, hoja_id' : 'im_comprobante_id');
      if (extra) q = extra(q);
      const { data, error } = await q.in('im_comprobante_id', idsAmirar.slice(i, i + 200));
      if (error) throw new Error(error.message);
      filas.push(...(data ?? []));
    }
    return filas;
  };
  const asignados = await buscarEn('hojas_ruta_pedidos');
  const retiros = await buscarEn('retiros_sucursal', (q: any) => q.eq('tenant_id', TENANT_ID));

  const enHojaPorId = new Map(asignados.map((a: any) => [String(a.im_comprobante_id), String(a.hoja_id)]));
  const enRetiroPorId = new Set(retiros.map((r: any) => String(r.im_comprobante_id)));
  /** Está tomado si lo está el remito **o** el presupuesto del que salió. */
  const enHoja = new Map<string, string>();
  const enRetiro = new Set<string>();
  for (const id of ids) {
    const presu = presuDelRemito.get(id);
    const hoja = enHojaPorId.get(id) ?? (presu ? enHojaPorId.get(presu) : undefined);
    if (hoja) enHoja.set(id, hoja);
    if (enRetiroPorId.has(id) || (presu && enRetiroPorId.has(presu))) enRetiro.add(id);
  }

  const filas = remitos.map((r: any) => {
    const c = porCliente.get(Number(r.cod_cliente));
    const z = zonaDeCliente(c);
    const peso = pesoDeRenglones(renglones.get(String(r.id)) ?? []);
    const fa = facturaDe.get(String(r.id));
    return {
      // 🔑 El comprobante que identifica la entrega es el REMITO: es el que viaja.
      im_comprobante_id: String(r.id),
      im_numero: r.numero ?? null,
      fecha: r.fecha ? String(r.fecha).slice(0, 10) : null,
      de_otro_dia: String(r.fecha ?? '').slice(0, 10) !== hasta,
      cod_cliente: Number(r.cod_cliente),
      cliente_nombre: c?.razon_social ?? c?.nombre ?? `Cliente ${r.cod_cliente}`,
      cod_zona: z.cod_zona,
      zona: z.nombre,
      zona_origen: z.origen,
      total: Number(r.total ?? 0),
      bultos: peso.bultos,
      kg: peso.kg,
      renglones_sin_peso: peso.renglones_sin_peso,
      // Lo que escribió el vendedor: viaja del pedido al remito y le sirve al repartidor.
      observaciones: typeof r.observaciones === 'string' && r.observaciones.trim() ? r.observaciones.trim() : null,
      // La factura que le corresponde, con cómo se supo (ver aparearFactura.ts).
      im_factura_id: fa?.im_factura_id ?? null,
      im_factura_numero: fa?.im_factura_numero ?? null,
      im_factura_tipo: fa?.im_factura_tipo ?? null,
      factura_origen: fa?.origen ?? 'ninguna',
      hoja_id: enHoja.get(String(r.id)) ?? null,
      en_retiro: enRetiro.has(String(r.id)),
    };
  });

  const datos = {
    pendientes: filas.filter(f => !f.hoja_id && !f.en_retiro),
    asignados: filas.filter(f => f.hoja_id),
    en_retiro: filas.filter(f => f.en_retiro).length,
    totales: {
      remitos: filas.length,
      importe: Math.round(filas.reduce((s, f) => s + f.total, 0) * 100) / 100,
      kg: Math.round(filas.reduce((s, f) => s + f.kg, 0) * 100) / 100,
    },
    // Para que la pantalla pueda avisar en vez de mostrar un número que miente por abajo.
    sin_zona: filas.filter(f => f.cod_zona == null).length,
    sin_factura: filas.filter(f => f.im_factura_numero == null).length,
    factura_deducida: filas.filter(f => f.factura_origen === 'elegida').length,
    dias_sin_items: diasSinItems,
  };
  _cache.set(clave, { at: Date.now(), datos });
  return datos;
}
