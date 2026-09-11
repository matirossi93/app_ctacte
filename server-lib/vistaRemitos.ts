import { LecturasCompartidas } from './lecturasCompartidas.js';
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
export function invalidarRemitos() { vistasCompartidas.invalidar(); }

const esTipo = (v: any, t: string) => String(v?.tipo_comprobante ?? '').trim() === t;
const vigente = (v: any) => String(v?.anulada ?? '').trim().toUpperCase() !== 'S';

/**
 * 🔴 EL PANEL ES DE CASA CENTRAL. Es la única que arma hojas de ruta.
 *
 * Mati (09/09/2026): *"el panel tiene que ser para casa central únicamente, porque es la única
 * que tiene hoja de ruta... ya están apareciendo pedidos de las otras sucursales"*.
 *
 * 🪤 Nada filtraba por empresa. Medido ese día sobre los remitos vivos de 7 días: 182 de Casa
 * Central (empresa 1, punto de venta 7) contra **1.852 de las sucursales** (empresas 2, 3 y 4,
 * todas por el punto 888). O sea que 9 de cada 10 filas de la pantalla eran ruido de otra
 * sucursal, que además no se pueden despachar desde acá.
 */
const COD_EMPRESA_CASA_CENTRAL = Number(process.env.PEDIDO_EMPRESA_DEFAULT || 1);
const esCasaCentral = (v: any) => Number(v?.cod_empresa) === COD_EMPRESA_CASA_CENTRAL;

/**
 * 🔑 Desde cuándo se arma la hoja de ruta en el panel.
 *
 * Mati (09/09/2026): *"hay que limpiar todos los pedidos que ya estaban facturados y que
 * entraron, porque recién arrancamos hoy con el nuevo método... están dando vuelta y no los
 * podemos sacar"*. Todo lo facturado ANTES de arrancar ya salió por el circuito viejo: no hay
 * ninguna hoja que armarle y en la pantalla es ruido puro.
 *
 * 📌 El default es el 09/09/2026, el día que la oficina arrancó con el panel. Está hardcodeado a
 * propósito y no en el entorno: es un hecho con fecha, no una preferencia — antes de ese día no
 * existe una sola hoja de ruta armada acá. `HOJAS_RUTA_DESDE` lo pisa, y `HOJAS_RUTA_DESDE=todo`
 * saca el corte por completo si alguna vez hace falta mirar para atrás.
 */
const DESDE_MINIMO = (() => {
  const env = String(process.env.HOJAS_RUTA_DESDE ?? '').trim();
  if (env.toLowerCase() === 'todo') return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(env) ? env : '2026-09-09';
})();

/** La misma forma que devuelve la vista, pero sin nada: el rango cae entero antes del arranque. */
function vaciaDesde(_desde: string, _hasta: string) {
  return {
    pendientes: [], asignados: [], en_retiro: 0, conflictos_asignacion: [],
    totales: { remitos: 0, importe: 0, kg: 0 },
    sin_zona: 0, sin_factura: 0, factura_deducida: 0, dias_sin_items: [] as string[],
  };
}

const vistasCompartidas = new LecturasCompartidas<any>();
export function vistaRemitos(desde: string, hasta: string, forzar = false): Promise<any> { return vistasCompartidas.obtener(`${desde}|${hasta}`, () => armarVistaRemitos(desde,hasta,forzar), {actualizar:forzar}); }
async function armarVistaRemitos(desde: string, hasta: string, forzar = false) {
  // El corte de arranque manda sobre lo que pida la pantalla: nada anterior entra nunca.
  if (DESDE_MINIMO && desde < DESDE_MINIMO) desde = DESDE_MINIMO;
  if (DESDE_MINIMO && hasta < DESDE_MINIMO) return vaciaDesde(desde, hasta);
  const clave = `${desde}|${hasta}`;


  const [ventas, cat, clientes] = await Promise.all([
    fetchVentas(desde, hasta, { actualizar: forzar }),
    fetchArticulosCatalogo(),
    fetchClientesIMCached().catch(() => []),
  ]);
  const porCliente = new Map(clientes.map((c: any) => [Number(c.cod_cliente), c]));

  // 🔴 Sólo Casa Central: es la única que despacha con hoja de ruta (ver esCasaCentral).
  const remitos = ventas.filter(v => esTipo(v, 'RE') && vigente(v) && esCasaCentral(v));
  const facturas = ventas.filter(v => esTipo(v, 'FA') && vigente(v) && esCasaCentral(v));

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
      fetchVentasItems(f, f, { actualizar: forzar }).catch((e: any) => {
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
  // Conservar todos los orígenes: elegir el último PR ocultaba entregas ya asignadas.
  const presupuestosPorRemito = new Map<string, Set<string>>();
  for (const f of nuestros) {
    if (!f.im_remito_id || !f.im_comprobante_id) continue;
    const remito = String(f.im_remito_id);
    if (!presupuestosPorRemito.has(remito)) presupuestosPorRemito.set(remito, new Set());
    presupuestosPorRemito.get(remito)!.add(String(f.im_comprobante_id));
  }
  const ambiguos = new Set([...presupuestosPorRemito].filter(([, ids]) => ids.size > 1).map(([id]) => id));
  // No asignar al azar la factura de un vínculo ambiguo ni ofrecérsela a otro remito.
  const facturasReservadas = new Set(nuestros.filter(f => ambiguos.has(String(f.im_remito_id)))
    .map(f => String(f.im_factura_id)).filter(id => id !== 'null' && id !== 'undefined'));
  const vinculados = new Map(nuestros
    .filter((f: any) => f.im_remito_id && !ambiguos.has(String(f.im_remito_id)))
    .map((f: any) => [String(f.im_remito_id), {
      im_factura_id: f.im_factura_id ?? null,
      im_factura_numero: f.im_factura_numero ?? null,
      im_factura_tipo: f.im_factura_tipo ?? null,
    }]));
  const facturaDe = aparearFacturas(remitos.filter(r => !ambiguos.has(String(r.id))) as any,
    facturas.filter(f => !facturasReservadas.has(String(f.id))) as any, vinculados);
  const idsAmirar = [...new Set([...ids, ...[...presupuestosPorRemito.values()].flatMap(ids => [...ids])])];

  // Dónde está cada uno: en una hoja, o el cliente lo pasa a buscar.
  const buscarEn = async (tabla: string, extra?: (q: any) => any) => {
    const filas: any[] = [];
    for (let i = 0; i < idsAmirar.length; i += 200) {
      let q = sb().from(tabla).select(tabla === 'hojas_ruta_pedidos' ? 'im_comprobante_id, hoja_id,hojas_ruta!inner(tenant_id)' : 'im_comprobante_id');
      if (tabla === 'hojas_ruta_pedidos') q = q.eq('hojas_ruta.tenant_id', TENANT_ID);
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
    const alias = [id, ...presupuestosPorRemito.get(id) ?? []];
    const hojas = new Set(alias.map(id => enHojaPorId.get(id)).filter((id): id is string => !!id));
    if (hojas.size === 1) enHoja.set(id, [...hojas][0]);
    if (alias.some(id => enRetiroPorId.has(id))) enRetiro.add(id);
    if (hojas.size > 1 || (hojas.size > 0 && enRetiro.has(id))) ambiguos.add(id);
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
      peso_completo: (renglones.get(String(r.id))?.length ?? 0) > 0 && peso.renglones_sin_peso === 0,
      // Lo que escribió el vendedor: viaja del pedido al remito y le sirve al repartidor.
      observaciones: typeof r.observaciones === 'string' && r.observaciones.trim() ? r.observaciones.trim() : null,
      // La factura que le corresponde, con cómo se supo (ver aparearFactura.ts).
      im_factura_id: fa?.im_factura_id ?? null,
      im_factura_numero: fa?.im_factura_numero ?? null,
      im_factura_tipo: fa?.im_factura_tipo ?? null,
      factura_origen: fa?.origen ?? 'ninguna',
      asignacion_ambigua: ambiguos.has(String(r.id)),
      comprobantes_origen: [...presupuestosPorRemito.get(String(r.id)) ?? []],
      hoja_id: enHoja.get(String(r.id)) ?? null,
      en_retiro: enRetiro.has(String(r.id)),
    };
  });

  const datos = {
    pendientes: filas.filter(f => !f.hoja_id && !f.en_retiro && !f.asignacion_ambigua),
    conflictos_asignacion: filas.filter(f => f.asignacion_ambigua),
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

  return datos;
}
