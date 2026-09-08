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

/** Mismo tope que la vista de presupuestos: cada día de renglones cuesta ~1,2 s contra IM. */
const MAX_DIAS_ITEMS = 12;
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
  const fechas = [...new Set(remitos.map((r: any) => String(r.fecha ?? '').slice(0, 10)).filter(Boolean))]
    .sort().slice(-MAX_DIAS_ITEMS);
  const renglones = new Map<string, Array<{ cod_articulo: number; cantidad: any; equivalencia_um: number | null | undefined }>>();
  const diasSinItems: string[] = [];
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

  // El vínculo REAL de lo que emitimos desde el panel: no hay que deducir nada.
  const { data: nuestros } = await sb().from('presupuestos_facturados')
    .select('im_remito_id, im_factura_id, im_factura_numero, im_factura_tipo')
    .eq('tenant_id', TENANT_ID).in('im_remito_id', ids);
  const vinculados = new Map((nuestros ?? [])
    .filter((f: any) => f.im_remito_id)
    .map((f: any) => [String(f.im_remito_id), {
      im_factura_id: f.im_factura_id ?? null,
      im_factura_numero: f.im_factura_numero ?? null,
      im_factura_tipo: f.im_factura_tipo ?? null,
    }]));
  const facturaDe = aparearFacturas(remitos as any, facturas as any, vinculados);

  // Dónde está cada uno: en una hoja, o el cliente lo pasa a buscar.
  const { data: asignados } = await sb().from('hojas_ruta_pedidos')
    .select('im_comprobante_id, hoja_id').in('im_comprobante_id', ids);
  const enHoja = new Map((asignados ?? []).map((a: any) => [String(a.im_comprobante_id), String(a.hoja_id)]));
  const { data: retiros } = await sb().from('retiros_sucursal')
    .select('im_comprobante_id').eq('tenant_id', TENANT_ID).in('im_comprobante_id', ids);
  const enRetiro = new Set((retiros ?? []).map((r: any) => String(r.im_comprobante_id)));

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
