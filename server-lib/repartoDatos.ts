import { actualizarImportesFacturas } from './importesFacturas.js';
import { sb, TENANT_ID } from './supabase.js';
import { pesoDeRenglones } from './pesoComprobante.js';
import { itemsPorFechas } from './itemsRango.js';
import { aparearFacturas } from './aparearFactura.js';
import { fetchVentas, fetchArticulosCatalogo, fetchClientesIMCached } from './infomanager.js';

export class ErrorReparto extends Error {
  constructor(message: string, public status = 409) { super(message); }
}
export async function mutarReparto(actor: string | undefined, accion: string, datos: Record<string, unknown>) {
  const { data, error } = await sb().rpc(accion === 'hoja_cerrar' ? 'cerrar_hoja_con_importes' : 'mutar_reparto', {
    p_tenant: TENANT_ID, p_actor: actor, ...(accion === 'hoja_cerrar' ? {} : {p_accion: accion}), p_datos: datos,
  });
  if (error && accion === 'hoja_cerrar' && ['PGRST202','42883','42703'].includes(error.code)) throw new ErrorReparto('Falta aplicar la migración 042 para guardar los importes al cerrar. La hoja sigue abierta.', 503);
  if (error) throw new ErrorReparto(error.code === '23505' && accion === 'hoja_crear' ? `Ya existe la hoja ${datos.numero ?? ''}. Elegí otro número.` : error.message, ['PGRST202', '42883', '42703'].includes(error.code) ? 503 : 409);
  if (data == null) throw new ErrorReparto('La base no confirmó el cambio. Verificá la migración 040.', 503);
  return data;
}
export async function emitidosDe(ids: string[]) {
  const unicos = [...new Set(ids)];
  const consultados = new Set<string>();
  if (unicos.some(id => !/^\d+$/.test(id))) throw new ErrorReparto('Identificador de comprobante inválido', 400);
  const filas: any[] = [];
  for (let i = 0; i < unicos.length;) {
    const tandaIds = unicos.slice(i, i + 150);
    i += tandaIds.length;
    const tanda = tandaIds.join(',');
    const { data, error } = await sb().from('presupuestos_facturados').select('*').eq('tenant_id', TENANT_ID)
      .or(`im_comprobante_id.in.(${tanda}),im_remito_id.in.(${tanda})`);
    if (error) throw new ErrorReparto(`No se pudieron consultar los comprobantes emitidos: ${error.message}`, 502);
    filas.push(...(data ?? []));
    for (const id of tandaIds) consultados.add(id);
    for (const e of data ?? []) if (e.im_remito_id && /^\d+$/.test(String(e.im_remito_id)) && !consultados.has(String(e.im_remito_id)) && !unicos.includes(String(e.im_remito_id))) unicos.push(String(e.im_remito_id));
  }
  return [...new Map(filas.map(f => [String(f.im_comprobante_id), f])).values()];
}
/** Una lectura masiva, reutilizable con la vista. Nunca confiar en importe/cliente del body. */
export async function verificarEntregas(entrada: any[], rango?: { desde?: string; hasta?: string }) {
  const fechas = entrada.map(p => String(p.fecha ?? '').slice(0, 10)).sort();
  const desde = rango?.desde ?? fechas[0], hasta = rango?.hasta ?? fechas.at(-1);
  if (!desde || !hasta || !/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta) ||
      !Number.isFinite(Date.parse(hasta) - Date.parse(desde)) || Date.parse(hasta) < Date.parse(desde) || Date.parse(hasta) - Date.parse(desde) > 32 * 864e5) throw new ErrorReparto('Actualizá los comprobantes para verificar su fecha.');
  const ventas = await fetchVentas(desde, hasta);
  const porId = new Map(ventas.map(v => [String(v.id), v]));
  const dias = [...new Set(entrada.map(p => String(porId.get(String(p.im_comprobante_id))?.fecha ?? '').slice(0, 10)).filter(Boolean))];
  const [detalle, cat, clientes] = await Promise.all([itemsPorFechas(dias), fetchArticulosCatalogo(), fetchClientesIMCached()]);
  const vigentes = ventas.filter(v => Number(v.cod_empresa) === Number(process.env.PEDIDO_EMPRESA_DEFAULT || 1) && String(v.anulada ?? '').trim().toUpperCase() !== 'S');
  const remitos = vigentes.filter(v => String(v.tipo_comprobante).trim() === 'RE');
  const emitidos = await emitidosDe(remitos.map(v => String(v.id)));
  for (const e of emitidos) {
    const f = porId.get(String(e.im_factura_id));
    if (f && (Number(f.cod_empresa) !== Number(process.env.PEDIDO_EMPRESA_DEFAULT || 1) || String(f.anulada ?? '').trim().toUpperCase() === 'S')) throw new ErrorReparto('La factura vinculada dejó de estar vigente en Casa Central. Revisá el comprobante antes de asignar.');
  }
  const vinculados = new Map(emitidos.filter(e => e.im_remito_id && Number(e.cod_empresa) === Number(process.env.PEDIDO_EMPRESA_DEFAULT || 1)).map(e => [String(e.im_remito_id), e]));
  const pares = aparearFacturas(remitos as any, vigentes.filter(v => String(v.tipo_comprobante).trim() === 'FA') as any, vinculados);
  const ahora = new Date().toISOString();
  return entrada.map(p => {
    const v: any = porId.get(String(p.im_comprobante_id));
    const tipo = String(v?.tipo_comprobante ?? '').trim();
    if (!v) throw new ErrorReparto('El comprobante no está en el rango consultado. Incluí su fecha real y actualizá antes de asignar.');
    if (!['PR', 'RE'].includes(tipo) || Number(v.cod_empresa) !== Number(process.env.PEDIDO_EMPRESA_DEFAULT || 1) ||
      String(v.anulada ?? '').trim().toUpperCase() === 'S') throw new ErrorReparto('El comprobante cambió, no está vigente o no pertenece a Casa Central. Actualizá.');
    const rs = detalle.items.filter(it => String(it.id_comprobante) === String(v.id));
    const peso = pesoDeRenglones(rs.map(it => ({ cantidad: it.cantidad, equivalencia_um: cat.get(Number(it.cod_articulo))?.equivalencia_um })));
    const cliente = clientes.find(c => Number(c.cod_cliente) === Number(v.cod_cliente));
    const fa = pares.get(String(v.id));
    return { factura_origen: fa?.origen ?? 'ninguna', im_factura_id: fa?.im_factura_id ?? null, im_factura_numero: fa?.im_factura_numero ?? null,
      bultos: peso.bultos, kg: peso.kg, peso_completo: !!rs.length && peso.renglones_sin_peso === 0, renglones_sin_peso: peso.renglones_sin_peso,
      cliente_nombre: cliente?.razon_social ?? cliente?.nombre ?? `Cliente ${v.cod_cliente}`,
      im_comprobante_id: String(v.id), im_numero: v.numero ?? null, cod_cliente: Number(v.cod_cliente),
      total: Number(v.total), cod_empresa: Number(v.cod_empresa), fecha: String(v.fecha).slice(0, 10),
      tipo, tipo_comprobante: tipo, datos_consultados_at: ahora };
  });
}
export interface NotaEntrega { id: string; tipo: string; total: number; numero: number | null }
export function notasUnicas(notas: NotaEntrega[]) {
  return [...new Map(notas.filter(n => n.id).map(n => [n.id, n])).values()];
}
export function netoNotas(notas: NotaEntrega[]) {
  return Math.round(notasUnicas(notas).reduce((s, n) => s + (/^nc/i.test(n.tipo) ? -1 : 1) * Math.abs(n.total), 0) * 100) / 100;
}
/** Misma fuente base para impresión, retiro y liquidación; el snapshot original no se pisa. */
export async function enriquecerEntregas(filas: any[], actualizar = false, consultarImportes = true) {
  const emitidos = await emitidosDe(filas.map(f => String(f.im_comprobante_id)));
  const porId = new Map<string, any>();
  for (const e of emitidos) {
    porId.set(String(e.im_comprobante_id), e);
    if (e.im_remito_id) porId.set(String(e.im_remito_id), e);
  }
  const enriquecidas = filas.map(f => {
    const candidato = porId.get(String(f.im_comprobante_id));
    const relacionados = emitidos.filter(e => String(e.im_comprobante_id) === String(f.im_comprobante_id) || String(e.im_remito_id) === String(f.im_comprobante_id) || (candidato?.im_remito_id && String(e.im_remito_id) === String(candidato.im_remito_id)));
    const e = relacionados.length === 1 && Number(candidato?.cod_cliente) === Number(f.cod_cliente) && (f.cod_empresa == null || Number(f.cod_empresa) === Number(candidato?.cod_empresa)) ? candidato : undefined;
    const completo = e?.facturado_at && e.total != null && e.estado_emision !== 'incierto';
    return { ...f, total_snapshot: f.total,
      fecha_factura: e?.fecha ?? f.fecha,
      cod_empresa: f.cod_empresa ?? (e?.facturado_at ? e.cod_empresa : null) ?? null,
      empresa_fuente: f.empresa_fuente ?? (f.cod_empresa != null ? 'entrega_verificada' : e?.facturado_at && e?.cod_empresa != null ? 'vinculo_panel' : 'desconocida'),
      total: completo ? Number(e.total) : f.total,
      importe_fuente: completo ? 'factura_panel' : f.datos_consultados_at ? 'comprobante_im' : 'snapshot_legacy',
      factura_origen: e?.im_factura_id ? 'vinculo' : f.factura_origen,
      im_factura_id: e?.im_factura_id ?? f.im_factura_id,
      im_factura_numero: e?.im_factura_numero ?? f.im_factura_numero,
      im_remito_id: e?.im_remito_id ?? f.im_remito_id,
      im_remito_numero: e?.im_remito_numero ?? f.im_remito_numero,
      facturado_at: e?.facturado_at ?? f.facturado_at,
      tipo_comprobante: f.tipo_comprobante ?? (String(f.im_comprobante_id) === String(e?.im_remito_id ?? f.im_remito_id) ? 'RE' : null),
    };
  });
  return consultarImportes ? actualizarImportesFacturas(enriquecidas, { actualizar }) : enriquecidas;
}

export async function notasDeHoja(hojaId: string, filas: any[]) {
  const facturas = [...new Set(filas.map(f => f.im_factura_id).filter(Boolean).map(String))];
  const porFactura = new Map<string, NotaEntrega[]>();
  for (let i = 0; i < facturas.length; i += 150) {
    const notas = await leerPaginas(() => sb().from('facturas_correcciones').select('im_factura_id,im_comprobante_id,tipo,total,numero')
      .eq('tenant_id', TENANT_ID).in('im_factura_id', facturas.slice(i, i + 150)).order('id'));
    for (const n of notas) {
      const k = String(n.im_factura_id);
      porFactura.set(k, [...(porFactura.get(k) ?? []), { id: String(n.im_comprobante_id), tipo: n.tipo, total: Number(n.total), numero: n.numero }]);
    }
  }
  const ajustes = await leerPaginas(() => sb().from('hojas_ruta_ajustes').select('*').eq('tenant_id', TENANT_ID)
    .eq('hoja_id', hojaId).not('emitido_at', 'is', null).order('id'));
  const emitidos = await emitidosDe(filas.map(f => String(f.im_comprobante_id)));
  return filas.map(f => {
    const e = emitidos.find(e => String(e.im_comprobante_id) === String(f.im_comprobante_id) || String(e.im_remito_id) === String(f.im_comprobante_id));
    const ids = new Set([f.im_comprobante_id, e?.im_comprobante_id, e?.im_remito_id].filter(Boolean).map(String));
    const notas = notasUnicas([...(porFactura.get(String(f.im_factura_id)) ?? []), ...(ajustes ?? []).filter(a => ids.has(String(a.im_comprobante_id))).map(a => ({ id: String(a.im_ajuste_id ?? ''), tipo: a.im_ajuste_tipo ?? a.tipo, total: Number(a.importe), numero: a.im_ajuste_numero }))]);
    return { ...f, notas };
  });
}

/** Las listas que se suman deben leerse completas, sin depender del límite de PostgREST. */
export async function leerPaginas(consulta: () => any): Promise<any[]> {
  const filas: any[] = [];
  for (let pagina = 0; pagina < 100; pagina++) {
    const { data, error } = await consulta().range(pagina * 500, pagina * 500 + 499);
    if (error) throw new ErrorReparto(error.message, 502);
    filas.push(...(data ?? []));
    if ((data ?? []).length < 500) return filas;
  }
  throw new ErrorReparto('La consulta supera el límite de seguridad. Acotá el rango; no se muestran totales parciales.', 422);
}

/** Aplica el último cierre confirmado; los cierres antiguos conservan el circuito previo. */
export function aplicarImportesCierre(hoja: any, pedidos: any[]) {
  if (hoja.estado !== 'cerrada') return pedidos;
  const cierre = hoja.cierres_importes?.at(-1);
  if (!cierre) return pedidos;
  const importes = new Map<string, any>((cierre.pedidos ?? []).map((p: any) => [String(p.im_comprobante_id), p]));
  if (importes.size !== pedidos.length) throw new ErrorReparto('El respaldo del cierre no coincide con las entregas. Revisá la hoja.');
  return pedidos.map(p => {
    const c = importes.get(String(p.im_comprobante_id));
    if (!c || Number(c.cod_cliente) !== Number(p.cod_cliente) || c.total == null || !Number.isFinite(Number(c.total))) throw new ErrorReparto('Falta el importe confirmado al cierre de la entrega.');
    return { ...p, total: Number(c.total), importe_fuente: 'cierre_hoja' };
  });
}
/** Las hojas cerradas conservan su base histórica; las abiertas siguen el importe de IM. */
export async function enriquecerHojas(hojas: any[], actualizar = false) {
  const [abiertas, cerradas] = await Promise.all([
    enriquecerEntregas(hojas.filter(h => h.estado !== 'cerrada').flatMap(h => h.hojas_ruta_pedidos ?? []), actualizar),
    enriquecerEntregas(hojas.filter(h => h.estado === 'cerrada').flatMap(h => h.hojas_ruta_pedidos ?? []), false, false),
  ]);
  const porId = new Map(cerradas.map(p => [String(p.im_comprobante_id), p]));
  return [...abiertas, ...hojas.filter(h => h.estado === 'cerrada').flatMap(h => aplicarImportesCierre(h, (h.hojas_ruta_pedidos ?? []).map((p: any) => porId.get(String(p.im_comprobante_id)) ?? p)))];
}
