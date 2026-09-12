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
/**
 * Vincular una nota que ya existe en IM. Función propia, no `mutar_reparto`: la identidad de la
 * factura de destino se resuelve dentro del mismo lock y se coteja contra la que vio el operador.
 */
export async function vincularNotaRPC(actor: string | undefined, hojaId: string, version: unknown, ajuste: Record<string, unknown>, facturaEsperada: string) {
  const { data, error } = await sb().rpc('vincular_nota_existente', {
    p_tenant: TENANT_ID, p_actor: actor, p_hoja: hojaId,
    p_version: version == null || version === '' ? null : Number(version),
    p_ajuste: ajuste, p_factura_esperada: facturaEsperada,
  });
  if (error) {
    if (['PGRST202', '42883', '42703'].includes(error.code)) throw new ErrorReparto('Falta aplicar la migración 043 para vincular notas. No se modificó nada.', 503);
    if (error.code === '23505') throw new ErrorReparto('Esa nota ya está vinculada a una entrega.', 409);
    throw new ErrorReparto(error.message, 409);
  }
  if (data == null) throw new ErrorReparto('La base no confirmó el vínculo. Verificá la migración 043.', 503);
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
/**
 * `origen` dice de qué fuente salió: `correccion` es el journal de correcciones de factura y
 * `panel` el vínculo de la hoja. Una misma nota puede estar en las DOS, y eso cambia lo que se
 * puede hacer con ella: soltar el vínculo del panel no la saca del total si el journal la sostiene.
 */
export type OrigenNota = 'panel' | 'correccion';
export interface NotaEntrega { id: string; tipo: string; total: number; numero: number | null; origen?: OrigenNota; fuentes?: OrigenNota[] }
/** Ya deduplicada, con TODAS las fuentes donde aparece. */
export type NotaConciliada = NotaEntrega & { fuentes: OrigenNota[] };
/**
 * La misma nota puede llegar por dos caminos —el journal de correcciones y el ajuste de la
 * entrega— y no se cuenta dos veces.
 *
 * 🔴 Deduplicar con un Map es "gana el último", y el orden acá lo decide en qué tabla estaba la
 * fila. Sirve cuando las dos copias dicen lo mismo; si difieren en tipo o en importe, elegir por
 * orden es elegir al azar una cifra que termina en un PAGO. Esas no se suman ni se descartan: se
 * devuelven como problema para que quien arma el total corte en vez de publicar un número.
 *
 * Lo mismo con un tipo que no es NC ni ND o un importe ilegible: `!/^nc/` no es "es débito", y un
 * `Infinity` sumado da un total que parece un número.
 */
export type ProblemaNota = { id: string; motivo: 'conflicto' | 'tipo' | 'importe' };

const signoNota = (n: { tipo?: unknown }): -1 | 1 | null => {
  const t = String(n.tipo ?? '');
  return /^nc/i.test(t) ? -1 : /^nd/i.test(t) ? 1 : null;
};
const totalNota = (n: { total?: unknown }): number | null => {
  const v = Number(n.total);
  return Number.isFinite(v) ? Math.abs(v) : null;
};

export function conciliarNotas(entradas: NotaEntrega[]): { notas: NotaConciliada[]; problemas: ProblemaNota[] } {
  const por = new Map<string, NotaEntrega>(), medida = new Map<string, { signo: number; total: number }>();
  const fuentes = new Map<string, Set<OrigenNota>>();
  const problemas = new Map<string, ProblemaNota>();
  const marcar = (id: string, motivo: ProblemaNota['motivo']) => {
    if (!problemas.has(id)) problemas.set(id, { id, motivo });
    por.delete(id); medida.delete(id);
  };
  for (const n of entradas) {
    const id = String(n.id ?? '').trim();
    if (!id) continue;                      // sin id no hay con qué deduplicar: misma regla de siempre
    if (problemas.has(id)) continue;
    const signo = signoNota(n), total = totalNota(n);
    if (signo === null) { marcar(id, 'tipo'); continue; }
    if (total === null) { marcar(id, 'importe'); continue; }
    /**
     * 🔑 De dónde vino se ACUMULA aunque la fila se descarte por repetida. Quedarse sólo con la
     * primera hacía que una nota presente en las dos fuentes se viera como si fuera sólo del
     * panel — y entonces la pantalla ofrecía soltarla, cuando soltar el vínculo no la saca del
     * total: el journal la sigue descontando igual.
     */
    // 🪤 Y también las que ya venían acumuladas: esto se concilia dos veces —una por entrega y
    // otra por hoja— y mirar sólo `origen` en la segunda pasada perdía la fuente que se había
    // descartado por repetida en la primera.
    const deEsta = [...(n.fuentes ?? []), ...(n.origen ? [n.origen] : [])];
    if (deEsta.length) {
      if (!fuentes.has(id)) fuentes.set(id, new Set());
      for (const f of deEsta) fuentes.get(id)!.add(f);
    }
    const previa = medida.get(id);
    if (!previa) { por.set(id, n); medida.set(id, { signo, total }); continue; }
    if (previa.signo !== signo || Math.abs(previa.total - total) > 0.005) marcar(id, 'conflicto');
  }
  return {
    notas: [...por.entries()].map(([id, n]) => ({ ...n, fuentes: [...(fuentes.get(id) ?? [])] })),
    problemas: [...problemas.values()],
  };
}

const MOTIVO: Record<ProblemaNota['motivo'], string> = {
  conflicto: 'figura con dos importes o tipos distintos',
  tipo: 'no dice si es de crédito o de débito',
  importe: 'tiene un importe ilegible',
};
/** El mensaje nombra la nota: quien lo lee tiene que poder ir a buscarla. */
export function errorDeNotas(problemas: ProblemaNota[], donde: string): ErrorReparto {
  const d = problemas.map(p => `la nota ${p.id} ${MOTIVO[p.motivo]}`).join('; ');
  return new ErrorReparto(`No se puede calcular el total de ${donde}: ${d}. Corregilo antes de seguir.`, 409);
}

/** 🔴 Corta en vez de devolver un total al que le falta una nota o le sobra una mal leída. */
export function notasUnicas(notas: NotaEntrega[], donde = 'esta entrega') {
  const { notas: limpias, problemas } = conciliarNotas(notas);
  if (problemas.length) throw errorDeNotas(problemas, donde);
  return limpias;
}
export function netoNotas(notas: NotaEntrega[], donde = 'esta entrega') {
  return Math.round(notasUnicas(notas, donde).reduce((s, n) => s + signoNota(n)! * Math.abs(Number(n.total)), 0) * 100) / 100;
}
/** Misma fuente base para impresión, retiro y liquidación; el snapshot original no se pisa. */
export async function enriquecerEntregas(filas: any[], actualizar = false, consultarImportes = true, tolerarErrores = false) {
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
  return consultarImportes ? actualizarImportesFacturas(enriquecidas, { actualizar, tolerarErrores }) : enriquecidas;
}

/**
 * Las notas de cada hoja: journal de correcciones + ajustes emitidos desde el panel, una sola vez.
 *
 * 🔑 Misma fuente para la impresión, el modal y la liquidación del chofer. Leer sólo
 * `hojas_ruta_ajustes` —como hacía la liquidación— deja afuera las notas que se emitieron por el
 * circuito de corrección de factura, y el chofer cobra sobre un importe que no descuenta lo que
 * volvió.
 *
 * 🪤 Por LOTES, no por hoja: un mes son decenas de hojas y dos consultas por cada una es un
 * barrido entero de la pantalla de liquidación.
 */
export async function notasDeHojas(grupos: { hojaId: string; filas: any[] }[]) {
  const todas = grupos.flatMap(g => g.filas);
  const facturas = [...new Set(todas.map(f => f.im_factura_id).filter(Boolean).map(String))];
  const porFactura = new Map<string, NotaEntrega[]>();
  for (let i = 0; i < facturas.length; i += 150) {
    const notas = await leerPaginas(() => sb().from('facturas_correcciones').select('im_factura_id,im_comprobante_id,tipo,total,numero')
      .eq('tenant_id', TENANT_ID).in('im_factura_id', facturas.slice(i, i + 150)).order('id'));
    for (const n of notas) {
      const k = String(n.im_factura_id);
      porFactura.set(k, [...(porFactura.get(k) ?? []), { id: String(n.im_comprobante_id), tipo: n.tipo, total: Number(n.total), numero: n.numero, origen: 'correccion' }]);
    }
  }
  const hojaIds = [...new Set(grupos.map(g => String(g.hojaId)))];
  const porHoja = new Map<string, any[]>();
  for (let i = 0; i < hojaIds.length; i += 150) {
    const ajustes = await leerPaginas(() => sb().from('hojas_ruta_ajustes').select('*').eq('tenant_id', TENANT_ID)
      .in('hoja_id', hojaIds.slice(i, i + 150)).not('emitido_at', 'is', null).order('id'));
    for (const a of ajustes) porHoja.set(String(a.hoja_id), [...(porHoja.get(String(a.hoja_id)) ?? []), a]);
  }
  const emitidos = await emitidosDe(todas.map(f => String(f.im_comprobante_id)));
  // 🪤 Primero gana, igual que el `find` que reemplaza: con dos filas que cubren el mismo id, la
  // que se elija no puede depender de por cuál de las dos claves entró.
  const primero = new Map<string, any>();
  for (const e of emitidos) {
    for (const k of [e.im_comprobante_id, e.im_remito_id]) if (k && !primero.has(String(k))) primero.set(String(k), e);
  }
  return grupos.map(g => ({
    hojaId: g.hojaId,
    filas: g.filas.map(f => {
      const e = primero.get(String(f.im_comprobante_id));
      const ids = new Set([f.im_comprobante_id, e?.im_comprobante_id, e?.im_remito_id].filter(Boolean).map(String));
      const notas = notasUnicas([...(porFactura.get(String(f.im_factura_id)) ?? []), ...(porHoja.get(String(g.hojaId)) ?? []).filter(a => ids.has(String(a.im_comprobante_id))).map(a => ({ id: String(a.im_ajuste_id ?? ''), tipo: a.im_ajuste_tipo ?? a.tipo, total: Number(a.importe), numero: a.im_ajuste_numero, origen: 'panel' as const }))],
        `la entrega ${f.im_comprobante_id}`);
      return { ...f, notas };
    }),
  }));
}
export async function notasDeHoja(hojaId: string, filas: any[]) {
  return (await notasDeHojas([{ hojaId, filas }]))[0].filas;
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
export async function enriquecerHojas(hojas: any[], actualizar = false, tolerarErrores = false) {
  const [abiertas, cerradas] = await Promise.all([
    enriquecerEntregas(hojas.filter(h => h.estado !== 'cerrada').flatMap(h => h.hojas_ruta_pedidos ?? []), actualizar, true, tolerarErrores),
    enriquecerEntregas(hojas.filter(h => h.estado === 'cerrada').flatMap(h => h.hojas_ruta_pedidos ?? []), false, false),
  ]);
  const porId = new Map(cerradas.map(p => [String(p.im_comprobante_id), p]));
  return [...abiertas, ...hojas.filter(h => h.estado === 'cerrada').flatMap(h => aplicarImportesCierre(h, (h.hojas_ruta_pedidos ?? []).map((p: any) => porId.get(String(p.im_comprobante_id)) ?? p)))];
}
