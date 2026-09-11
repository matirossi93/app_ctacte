import { idIM } from './identidadIM.js';
import { randomUUID } from 'node:crypto';
import { sb, TENANT_ID } from './supabase.js';
import { emitirNotaCredito, emitirNotaDebito } from './facturarIM.js';
import type { DatosComprobante, ResultadoEmision } from './facturarIM.js';
import type { RenglonCorreccion } from './correccionFactura.js';

export class ErrorOperacion extends Error {
  constructor(message: string, public status = 409) { super(message); }
}
export interface OperacionFactura {
  id: string; im_factura_id: string; clase: 'productos' | 'financiera';
  peticion: { motivo: string; numero_factura: number | null; entrada: unknown; origen?: unknown };
  componentes: Array<{ tipo: 'NC' | 'ND'; datos: DatosComprobante }>;
  finales: RenglonCorreccion[];
  indice: number; estado: 'listo' | 'emitiendo' | 'incierto' | 'completo' | 'cancelado';
  resultados: Array<{ id: string; numero: number | null; tipo: string; total: number }>;
  error: string | null;
  resultado_por_conciliar?: unknown;
}

/** Orden y tipos estables, sin nombres comerciales que puedan cambiar en el catálogo. */
export function firmaRenglones(rs: RenglonCorreccion[]): string {
  return JSON.stringify(rs.map(r => [Number(r.cod_articulo), Number(r.cantidad), Number(r.precio),
    Number(r.descuento_porc ?? 0), Number(r.iva_por ?? 0), r.cod_lista_precios == null ? null : Number(r.cod_lista_precios)])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}
export function originalesCanonicos(rs: RenglonCorreccion[]): RenglonCorreccion[] {
  return rs.map(r => ({ cod_articulo: Number(r.cod_articulo), cantidad: Number(r.cantidad), precio: Number(r.precio),
    descuento_porc: Number(r.descuento_porc ?? 0), iva_por: Number(r.iva_por ?? 0),
    cod_lista_precios: r.cod_lista_precios == null ? null : Number(r.cod_lista_precios) }))
    .sort((a, b) => a.cod_articulo - b.cod_articulo);
}
export function idOperacion(v: unknown): string {
  const id = String(v ?? '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new ErrorOperacion('Falta el identificador de operación. Volvé a abrir la factura.', 400);
  }
  return id;
}
function falloBD(error: { message: string } | null, contexto: string) {
  if (error) throw new ErrorOperacion(`${contexto}: ${error.message}. Verificá que esté aplicada la migración 039.`, 503);
}
export async function buscarOperacion(id: string): Promise<OperacionFactura | null> {
  const { data, error } = await sb().from('facturas_operaciones').select('*')
    .eq('tenant_id', TENANT_ID).eq('id', id).maybeSingle();
  falloBD(error, 'No pude leer la operación');
  return data as OperacionFactura | null;
}
export async function estadoCorreccion(id: string, originales: RenglonCorreccion[], cab?: any) {
  const { data, error } = await sb().from('facturas_estado_correccion').select('*')
    .eq('tenant_id', TENANT_ID).eq('im_factura_id', id).maybeSingle();
  falloBD(error, 'No pude leer el estado corregido');
  const { data: legacy, error: errLegacy } = await sb().from('facturas_correcciones').select('id')
    .eq('tenant_id', TENANT_ID).eq('im_factura_id', id).is('operacion_id', null).limit(1);
  falloBD(errLegacy, 'No pude verificar las notas anteriores');
  if (data && firmaRenglones(data.originales) !== firmaRenglones(originales)) {
    throw new ErrorOperacion('La factura original cambió en InfoManager. Hay que conciliarla antes de emitir otra corrección.');
  }
  const { data: entrega, error: errEntrega } = await sb().rpc('ajuste_entrega_sin_conciliar', {
    p_tenant: TENANT_ID, p_factura: id, p_cliente: Number(cab?.cod_cliente) || null, p_empresa: Number(cab?.cod_empresa) || null,
  });
  falloBD(errEntrega, 'No pude verificar notas de entrega (migración 041)');
  return {
    version: Number(data?.version ?? 0),
    renglones: (data?.renglones ?? originales) as RenglonCorreccion[],
    bloqueo: entrega ? 'Hay notas de entrega sin cantidades reconciliadas. Conciliá la factura antes de corregir productos.' : legacy?.length ? 'Esta factura tiene notas anteriores sin un estado reconciliado. La corrección de productos debe hacerse en InfoManager.' : null,
    operacion: data?.operacion_id ? await buscarOperacion(String(data.operacion_id)) : null,
  };
}
export function validarVersion(v: unknown, esperada: number) {
  if (!Number.isInteger(v) || Number(v) !== esperada) {
    throw new ErrorOperacion('La factura cambió o falta su versión. Volvé a abrirla antes de emitir.');
  }
}
export async function iniciarOperacion(o: {
  id: string; factura: string; version: number; clase: OperacionFactura['clase'];
  peticion: OperacionFactura['peticion']; componentes: OperacionFactura['componentes'];
  originales: RenglonCorreccion[]; finales: RenglonCorreccion[]; usuario: string | null;
}): Promise<OperacionFactura> {
  const { data, error } = await sb().rpc('iniciar_operacion_factura', {
    p_tenant: TENANT_ID, p_id: o.id, p_factura: o.factura, p_version: o.version,
    p_clase: o.clase, p_peticion: o.peticion, p_componentes: o.componentes,
    p_originales: originalesCanonicos(o.originales), p_finales: o.finales, p_usuario: o.usuario,
  });
  if (error) throw new ErrorOperacion(`No se inició la emisión: ${error.message}`, error.code === 'P0001' ? 409 : 503);
  if (!data) throw new ErrorOperacion('La base no confirmó el registro de la operación. No se emitió nada.', 503);
  return data as OperacionFactura;
}

/** Idempotencia por petición. Un ID repetido con otro contenido nunca se reinterpreta. */
export function verificarPeticion(o: OperacionFactura, factura: string, clase: OperacionFactura['clase'], entrada: unknown, motivo: string) {
  if (o.im_factura_id !== factura || o.clase !== clase || o.peticion.motivo !== motivo ||
      JSON.stringify(o.peticion.entrada) !== JSON.stringify(entrada)) {
    // jsonb puede reordenar claves: comparar representación canónica recursiva.
    if (o.im_factura_id !== factura || o.clase !== clase || o.peticion.motivo !== motivo ||
        canonico(o.peticion.entrada) !== canonico(entrada)) {
      throw new ErrorOperacion('La operación pendiente pertenece a otros datos. Retomá esa operación antes de crear otra.');
    }
  }
}
function canonico(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonico).join(',')}]`;
  if (x && typeof x === 'object') return `{${Object.entries(x).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonico(v)).join(',')}}`;
  return JSON.stringify(x);
}
/** Rechazo conocido de IM777: el validador cruza la serie de notas con facturas.
 * Sólo orientar a emisión externa tras rechazo confirmado; nunca ante incertidumbre.
 */
function conflictoNumeracionNota(o: OperacionFactura): boolean {
  return o.estado === 'listo' && !o.resultado_por_conciliar &&
    ['NC', 'ND'].includes(o.componentes[o.indice]?.tipo) &&
    /ya existe una (?:factura|nota) con:\s*tag\s*=\s*'S',\s*cod_empresa\s*=\s*1,\s*id_destino\s*=\s*1,\s*punto_de_venta\s*=\s*777,\s*tipo_factura\s*=\s*'[AB]'\s*y\s*numero\s*=\s*\d+/i.test(o.error ?? '');
}
const GUIA_NUMERACION_NOTA = 'InfoManager rechazó la nota por un conflicto de numeración en el punto 777. Reintentar desde la app no lo resuelve. Verificá en InfoManager si ya existe la nota que necesitás; si falta, emití allí sólo la nota pendiente. Después hay que conciliar su comprobante con esta operación.';
export function resumenOperacion(o: OperacionFactura) {
  const conflicto = conflictoNumeracionNota(o);
  return { id: o.id, clase: o.clase, estado: o.estado, entrada: o.peticion.entrada, motivo: o.peticion.motivo,
    emitidos: o.resultados, error: o.error, resultado_por_conciliar: o.resultado_por_conciliar,
    puede_retomar: o.estado === 'listo' && !conflicto,
    ...(conflicto ? { requiere_revision_numeracion: true, instruccion: GUIA_NUMERACION_NOTA } : {}),
    puede_cancelar: o.estado === 'listo' && o.indice === 0 && !o.resultados.length && !!o.error };
}

export async function cancelarOperacion(id: string) {
  const { data, error } = await sb().rpc('cancelar_operacion_factura', { p_tenant: TENANT_ID, p_id: id });
  if (error || data !== true) throw new ErrorOperacion(error?.message ?? 'Sólo se puede cancelar un rechazo confirmado sin ninguna nota emitida.');
}

export async function ejecutarOperacion(operacion: OperacionFactura) {
  const clave = `correccion:${operacion.id}`, token = randomUUID();
  const { data: reclamada, error } = await sb().rpc('reclamar_presupuesto', {
    p_tenant: TENANT_ID, p_id: clave, p_token: token, p_actividad: 'corregir factura',
  });
  if (error || reclamada !== true) throw new ErrorOperacion('Esta corrección tiene otra operación en curso o por verificar. No se envió otra nota.');
  try {
    const actual = await buscarOperacion(operacion.id);
    if (!actual) throw new ErrorOperacion('No pude releer el intento de corrección. No se envió otra nota.', 503);
    return await ejecutarOperacionReclamada(actual);
  } finally {
    const { error: errSuelta } = await sb().rpc('soltar_presupuesto', { p_tenant: TENANT_ID, p_id: clave, p_token: token });
    if (errSuelta) console.error('[correccion] no se pudo liberar el reclamo:', errSuelta.message);
  }
}

async function ejecutarOperacionReclamada(operacion: OperacionFactura) {
  let o = operacion;
  while (o.estado !== 'completo') {
    if (o.estado !== 'listo') throw new ErrorOperacion(`La operación ${o.id} está ${o.estado === 'emitiendo' ? 'en curso o perdió la respuesta' : 'sin confirmar'}. Verificá los comprobantes en InfoManager; no se puede reemitir a ciegas.`);
    if (conflictoNumeracionNota(o)) throw new ErrorOperacion(GUIA_NUMERACION_NOTA);
    const token = randomUUID();
    const { data: tomada, error: errToma } = await sb().rpc('tomar_paso_factura', {
      p_tenant: TENANT_ID, p_id: o.id, p_indice: o.indice, p_token: token,
    });
    if (errToma || !tomada) throw new ErrorOperacion(`No se pudo reclamar la emisión: ${errToma?.message ?? 'sin confirmación'}. No se emitió nada.`);
    o = tomada as OperacionFactura;
    const c = o.componentes[o.indice];
    let r: ResultadoEmision;
    try { r = await (c.tipo === 'NC' ? emitirNotaCredito(c.datos) : emitirNotaDebito(c.datos)); }
    catch (e) { r = { ok: false, sinRespuesta: true, error: e instanceof Error ? e.message : 'Se perdió la respuesta de InfoManager' }; }
    if (r.ok && !idIM(r.id)) r = { ok: false, sinRespuesta: true, error: 'InfoManager confirmó una emisión sin identificarla.' };
    const resultado = r.ok ? { id: r.id, numero: r.numero, tipo: r.tipo, total: c.datos.total } : null;
    const { data: guardada, error: errGuarda } = await sb().rpc('terminar_paso_factura', {
      p_tenant: TENANT_ID, p_id: o.id, p_token: token, p_resultado: resultado,
      p_error: r.ok ? null : r.error, p_incierto: !r.ok && !!r.sinRespuesta,
    });
    if (errGuarda || !guardada) {
      if (resultado) {
        try {
          const { error } = await sb().from('facturas_operaciones')
            .update({ resultado_por_conciliar: resultado, error: `Checkpoint pendiente: ${errGuarda?.message ?? 'sin confirmación'}` })
            .eq('tenant_id', TENANT_ID).eq('id', o.id).eq('token', token).eq('estado', 'emitiendo');
          if (error) console.error('[journal] no pude guardar evidencia del resultado:', error.message);
        } catch (e) { console.error('[journal] evidencia pendiente de persistencia:', e); }
      }
      throw new ErrorOperacion(`No pude registrar el resultado de la operación ${o.id}${resultado ? `: salió ${resultado.tipo} ${resultado.numero ?? ''}, ID ${resultado.id}` : ''}. Verificalo en InfoManager antes de continuar. El reintento está bloqueado.`, 503);
    }
    o = guardada as OperacionFactura;
    if (!r.ok) return { ok: false, operacion: resumenOperacion(o), emitidos: o.resultados,
      fallados: [r.sinRespuesta ? `No se sabe si la ${c.tipo} salió. Verificá en InfoManager. ${r.error}` : conflictoNumeracionNota(o) ? GUIA_NUMERACION_NOTA : `InfoManager rechazó la ${c.tipo}: ${r.error}. Corregí el motivo indicado antes de retomar esta operación.`] };
  }
  return { ok: true, operacion: resumenOperacion(o), emitidos: o.resultados, fallados: [] as string[] };
}
