import { invalidarIM } from './infomanager.js';
import { invalidarVista } from './vistaPresupuestos.js';
import { invalidarRemitos } from './vistaRemitos.js';
import { randomUUID } from 'node:crypto';
import { enriquecerEntregas, mutarReparto } from './repartoDatos.js';
/**
 * Lo que se ajusta cuando VUELVE el repartidor: notas de crédito por lo que no se entregó.
 *
 * Mati (08/09/2026): *"una vez que vuelve el repartidor se hacen NC o facturas por dif de
 * mercadería y eso impacta en el num final de la hoja... la HR siempre tiene que estar
 * actualizada, porque también la analizamos luego"*. Y ese número final es la base del pago al
 * chofer, así que no puede ser aproximado.
 *
 * Este módulo vincula notas existentes y nunca emite. El emisor alternativo fue retirado:
 * usaba importes del PR/RE y podía acreditar fuera del journal fiscal compartido.
 * crearAjuste devuelve 501 incluso con el antiguo interruptor de emisión activado.
 * Los vínculos y las correcciones se coordinan mediante las guardas de la migración 041.
 */
import type { Request, Response } from 'express';
import { sb, TENANT_ID } from './supabase.js';
import type { JwtPayload } from './auth.js';
import { puedeArmarHojasDeRuta } from './permisos.js';
import {
  fetchClientesIMCached, fetchVentasItems, cabeceraComprobante, fetchVentas, fechaArgentina, imClient, imGetRetry,
} from './infomanager.js';

function frenaSiNoPuede(req: Request & { user?: JwtPayload }, res: Response): boolean {
  if (!puedeArmarHojasDeRuta(String(req.user?.rol ?? ''))) {
    res.status(403).json({ error: 'Los ajustes de entrega los hace administración.' });
    return true;
  }
  return false;
}

const redondear = (n: number) => Math.round(n * 100) / 100;
/** Mismos defaults que el resto del panel. */
const EMPRESA_DEFAULT = Number(process.env.PEDIDO_EMPRESA_DEFAULT || 1);
const LISTA_FALLBACK = Number(process.env.PEDIDO_LISTA_FALLBACK || 12);
/** Igual que en la facturación: un reclamo sin emitir vence a los 5 minutos. */
const RECLAMO_VENCE_MS = 5 * 60_000;
/**
 * Emitir la NC desde el panel está APAGADO: IM la rechaza en el punto 777 (ver la cabecera).
 * Se prende cuando Sistec arregle la validación de unicidad.
 */
// La emisión alternativa fue retirada: el flag antiguo no habilita escrituras.
/** Cuántos días después de la hoja se buscan notas de crédito del cliente. */
const DIAS_CANDIDATAS = 30;

/**
 * GET /api/hojas-ruta/:id/ajustes — los ajustes de la hoja y el número final.
 *
 * `final = lo despachado − las notas de crédito + las notas de débito`. Es lo que se le liquida
 * al chofer, así que se devuelve desglosado: quien mira tiene que poder ver de dónde sale.
 */
export async function listarAjustes(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  try {
    const hojaId = String(req.params.id);
    const { data: hoja, error: errHoja } = await sb().from('hojas_ruta')
      .select('id, numero, fecha, estado, version, hojas_ruta_pedidos(*)')
      .eq('id', hojaId).eq('tenant_id', TENANT_ID).maybeSingle();
    if (errHoja) { res.status(500).json({ error: errHoja.message }); return; }
    if (!hoja) { res.status(404).json({ error: 'Hoja de ruta no encontrada' }); return; }

    const { data: ajustes, error } = await sb().from('hojas_ruta_ajustes')
      .select('*').eq('tenant_id', TENANT_ID).eq('hoja_id', hojaId).order('created_at');
    if (error) { res.status(500).json({ error: error.message }); return; }

    const pedidos = await enriquecerEntregas((hoja as any).hojas_ruta_pedidos ?? []);
    res.json({ ok: true, ...totalesConAjustes({ ...hoja, hojas_ruta_pedidos: pedidos }, ajustes ?? []), ajustes: ajustes ?? [] });
  } catch (err: any) {
    console.error('[listarAjustes]', err?.message);
    res.status(err.status ?? 500).json({ error: err?.message ?? 'error' });
  }
}

/**
 * El número final de una hoja: lo despachado menos lo acreditado.
 *
 * 🪤 Sólo cuentan los ajustes EMITIDOS. Uno que quedó a medias no bajó ninguna cuenta corriente,
 * así que restarlo haría que al chofer se le pague de menos por algo que no pasó.
 */
export function totalesConAjustes(hoja: any, ajustes: any[]) {
  const despachado = (hoja.hojas_ruta_pedidos ?? []).reduce((s: number, p: any) => s + Number(p.total ?? 0), 0);
  const emitidos = ajustes.filter(a => a.emitido_at);
  const nc = emitidos.filter(a => a.tipo === 'nc').reduce((s, a) => s + Number(a.importe ?? 0), 0);
  const nd = emitidos.filter(a => a.tipo === 'nd').reduce((s, a) => s + Number(a.importe ?? 0), 0);
  return {
    hoja: { version: hoja.version, id: hoja.id, numero: hoja.numero, fecha: hoja.fecha, estado: hoja.estado },
    despachado: redondear(despachado),
    notas_credito: redondear(nc),
    notas_debito: redondear(nd),
    /** Lo que de verdad se entregó: la base del pago al chofer. */
    final: redondear(despachado - nc + nd),
    pendientes_de_emitir: ajustes.filter(a => !a.emitido_at).length,
  };
}

/**
 * POST /api/hojas-ruta/:id/ajustes — carga una diferencia y emite la nota de crédito.
 *
 * Body: `{ im_comprobante_id, motivo, items: [{ cod_articulo, cantidad, precio }] }`.
 */
/** No hay un segundo emisor de NC: vincular una nota existente conserva el circuito de entrega. */
export async function crearAjuste(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  res.status(501).json({ error: 'La emisión de ajustes de entrega requiere conciliación fiscal compartida. Emití/revisá la nota en InfoManager y vinculala acá. Ningún interruptor habilita este emisor.' });
}

/**
 * DELETE /api/hojas-ruta/ajustes/:id — suelta un ajuste.
 *
 * 🔄 ANTES filtraba `emitido_at is null`, y como `vincularAjuste` escribe `emitido_at` en el
 * mismo insert, el DELETE **no matcheaba nunca**: una nota vinculada al pedido equivocado bajaba
 * el importe de la hoja —y el pago del chofer— para siempre, y encima dejaba ese pedido preso en
 * la hoja (no se podía sacar, ni mover, ni borrar la hoja). Auditoría del 08/09/2026.
 *
 * 🔑 La distinción que importa no es "emitida o no", es **quién la emitió**:
 *  · VINCULADA — la nota ya existía en InfoManager y el panel sólo la ató a un pedido. Soltarla
 *    no toca nada en IM, así que se puede deshacer.
 *  · EMITIDA POR EL PANEL — la creamos nosotros y esta fila es el único registro de a qué
 *    factura corresponde (IM no expone esa relación). No se borra: hay que anularla en IM.
 * Los registros históricos emitidos conservan `items`; `vincularAjuste` los deja vacíos.
 */
export async function borrarAjuste(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  const id = String(req.params.id);
  const { data: fila, error: errFila } = await sb().from('hojas_ruta_ajustes')
    .select('id, items, im_ajuste_numero, emitido_at').eq('tenant_id', TENANT_ID).eq('id', id).maybeSingle();
  // 🪤 Sin esto el guard falla ABIERTO: si la consulta se cae, `fila` viene null y se borraría
  // igual una nota emitida por nosotros.
  if (errFila) { res.status(502).json({ error: `No pude leer ese ajuste: ${errFila.message}` }); return; }
  if (!fila) { res.status(404).json({ error: 'Ese ajuste no existe.' }); return; }

  const laEmitimosNosotros = Array.isArray((fila as any).items) && (fila as any).items.length > 0;
  if (laEmitimosNosotros && (fila as any).emitido_at) {
    res.status(409).json({
      error: `La nota de crédito ${(fila as any).im_ajuste_numero ?? ''} se emitió desde el panel: para deshacerla hay que anularla en InfoManager. Esta fila es el único registro de a qué factura corresponde.`,
    });
    return;
  }

  try { await mutarReparto(req.user?.sub, 'ajuste_borrar', { id, version_esperada: req.query.version_esperada }); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); return; }
  res.json({ ok: true });
}

/**
 * GET /api/hojas-ruta/:id/ajustes/candidatas?im_comprobante_id= — qué notas de crédito de
 * InfoManager podrían corresponder a este pedido.
 *
 * Trae las NC del cliente desde la fecha de la hoja en adelante, saca las que ya están
 * vinculadas, y marca las que mencionan el número de la hoja en las observaciones — que es
 * justo lo que la oficina ya escribe (`SEGUN HR 3210`, en 287 de 724 notas).
 */
export async function candidatasAVincular(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  try {
    const hojaId = String(req.params.id);
    const comprobanteId = String(req.query.im_comprobante_id ?? '').trim();
    const { data: hoja, error: errHoja } = await sb().from('hojas_ruta')
      .select('id, numero, fecha, hojas_ruta_pedidos(im_comprobante_id, cod_cliente, cliente_nombre, total)')
      .eq('id', hojaId).eq('tenant_id', TENANT_ID).maybeSingle();
    if (errHoja) { res.status(502).json({ error: errHoja.message }); return; }
    if (!hoja) { res.status(404).json({ error: 'Hoja de ruta no encontrada' }); return; }

    const pedidos = (hoja as any).hojas_ruta_pedidos ?? [];
    const pedido = comprobanteId ? pedidos.find((p: any) => String(p.im_comprobante_id) === comprobanteId) : null;
    if (comprobanteId && !pedido) { res.status(409).json({ error: 'Ese pedido no está en esta hoja.' }); return; }
    // Sin pedido puntual, se buscan las de todos los clientes de la hoja.
    const clientes = new Set((pedido ? [pedido] : pedidos).map((p: any) => Number(p.cod_cliente)));

    const desde = String((hoja as any).fecha).slice(0, 10);
    const hasta = fechaArgentina(new Date(desde + 'T12:00:00Z').getTime() + DIAS_CANDIDATAS * 864e5);
    const ventas = await fetchVentas(desde, hasta > fechaArgentina() ? fechaArgentina() : hasta);
    const ncs = ventas.filter((v: any) =>
      String(v.tipo_comprobante ?? '').trim() === 'NC' &&
      String(v.anulada ?? '').trim().toUpperCase() !== 'S' &&
      clientes.has(Number(v.cod_cliente)));

    // Las que ya están atadas a algún ajuste no se ofrecen de nuevo.
    const { data: usadas, error: errUsadas } = await sb().from('hojas_ruta_ajustes')
      .select('im_ajuste_id').eq('tenant_id', TENANT_ID).not('im_ajuste_id', 'is', null);
    if (errUsadas) { res.status(502).json({ error: `No pude ver qué notas ya están vinculadas: ${errUsadas.message}` }); return; }
    const yaUsadas = new Set((usadas ?? []).map((u: any) => String(u.im_ajuste_id)));

    const numeroHoja = String((hoja as any).numero);
    const candidatas = ncs
      .filter((v: any) => !yaUsadas.has(String(v.id)))
      .map((v: any) => {
        const obs = String(v.observaciones ?? '');
        return {
          im_ajuste_id: String(v.id),
          numero: v.numero ?? null,
          tipo: `NC ${String(v.tipo_factura ?? '').trim()}`.trim(),
          fecha: String(v.fecha ?? '').slice(0, 10),
          cod_cliente: Number(v.cod_cliente),
          importe: Math.abs(Number(v.total ?? 0)),
          observaciones: obs,
          // 🔑 La convención que ya usa la oficina: "SEGUN HR 3210".
          menciona_esta_hoja: new RegExp(`(hr|hoja)\\s*${numeroHoja}\\b`, 'i').test(obs),
        };
      })
      .sort((a, b) => Number(b.menciona_esta_hoja) - Number(a.menciona_esta_hoja) || b.fecha.localeCompare(a.fecha));

    res.json({ ok: true, hoja: { numero: (hoja as any).numero, fecha: (hoja as any).fecha }, candidatas });
  } catch (err: any) {
    console.error('[candidatasAVincular]', err?.message);
    res.status(502).json({ error: `No pude traer las notas de crédito de InfoManager: ${err?.message ?? 'sin respuesta'}` });
  }
}

/**
 * POST /api/hojas-ruta/:id/ajustes/vincular — ata una NC ya emitida en IM a un pedido de la hoja.
 *
 * Body: `{ im_comprobante_id, im_ajuste_id, motivo? }`.
 *
 * 🔑 El importe y el número salen de la NC REAL leída de InfoManager, nunca del body: si viniera
 * de la pantalla, el número final de la hoja —y el pago del chofer— dependería de lo que alguien
 * tipeó.
 */
export async function vincularAjuste(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  try {
    const hojaId = String(req.params.id);
    const b = req.body ?? {};
    const comprobanteId = String(b.im_comprobante_id ?? '').trim();
    const ajusteId = String(b.im_ajuste_id ?? '').trim();
    if (!comprobanteId || !ajusteId) { res.status(400).json({ error: 'Falta el pedido o la nota de crédito.' }); return; }

    const { data: hoja, error: errHoja } = await sb().from('hojas_ruta')
      .select('id, numero, estado, hojas_ruta_pedidos(im_comprobante_id, cod_cliente, cod_empresa, cliente_nombre, total, facturado_at, im_factura_numero)')
      .eq('id', hojaId).eq('tenant_id', TENANT_ID).maybeSingle();
    if (errHoja) { res.status(502).json({ error: errHoja.message }); return; }
    if (!hoja) { res.status(404).json({ error: 'Hoja de ruta no encontrada' }); return; }
    if (String((hoja as any).estado) === 'cerrada') {
      res.status(409).json({ error: `La hoja ${(hoja as any).numero} está cerrada: ya se liquidó. Reabrila si de verdad hay que ajustarla.` });
      return;
    }
    const pedido = ((hoja as any).hojas_ruta_pedidos ?? []).find((p: any) => String(p.im_comprobante_id) === comprobanteId);
    if (!pedido) { res.status(409).json({ error: 'Ese pedido no está en esta hoja.' }); return; }

    // ── La nota, leída de InfoManager ────────────────────────────────────────
    const nc = await comprobanteCompleto(ajusteId);
    if (!nc) { res.status(404).json({ error: 'No encontré esa nota de crédito en InfoManager.' }); return; }
    if (String(nc.tipo_comprobante ?? '').trim() !== 'NC') {
      res.status(409).json({ error: `El comprobante ${nc.numero} no es una nota de crédito (es ${nc.tipo_comprobante}).` });
      return;
    }
    if (String(nc.anulada ?? '').trim().toUpperCase() === 'S') {
      res.status(409).json({ error: `Esa nota de crédito (${nc.numero}) está ANULADA en InfoManager.` });
      return;
    }
    // 🔴 Del mismo cliente: si no, se le estaría descontando a la hoja algo de otra persona.
    if (Number(nc.cod_cliente) !== Number(pedido.cod_cliente)) {
      res.status(409).json({ error: `Esa nota de crédito es del cliente ${nc.cod_cliente} y el pedido es del ${pedido.cod_cliente}.` });
      return;
    }

    if (!pedido.cod_empresa || Number(nc.cod_empresa) !== Number(pedido.cod_empresa) || Number(nc.cod_empresa) !== EMPRESA_DEFAULT) { res.status(409).json({ error: 'La nota y la entrega deben tener la misma empresa verificada de Casa Central.' }); return; }
    const importe = Math.abs(Number(nc.total ?? 0));
    if (!(importe > 0)) { res.status(409).json({ error: 'Esa nota de crédito tiene importe cero.' }); return; }

    const fila = {
      tenant_id: TENANT_ID, hoja_id: hojaId, im_comprobante_id: comprobanteId,
      cod_cliente: Number(pedido.cod_cliente), cliente_nombre: pedido.cliente_nombre ?? null,
      tipo: 'nc', importe, items: [], cod_empresa: Number(nc.cod_empresa),
      motivo: String(b.motivo ?? nc.observaciones ?? 'Diferencia de entrega').slice(0, 200),
      im_ajuste_id: String(nc.id), im_ajuste_numero: nc.numero != null ? Number(nc.numero) : null,
      im_ajuste_tipo: `NC ${String(nc.tipo_factura ?? '').trim()}`.trim(),
      // Ya está emitida en IM: por eso cuenta para el número final desde el momento en que se ata.
      emitido_at: new Date().toISOString(),
      created_by: req.user?.sub ?? null,
    };
    await mutarReparto(req.user?.sub, 'ajuste_vincular', { hoja_id: hojaId, version_esperada: req.body?.version_esperada, ajuste: fila });

    // Aviso, no bloqueo: una NC puede cubrir más de un pedido y el dato de IM es el que manda.
    const total = Number(pedido.total ?? 0);
    res.json({
      ok: true,
      ajuste: { importe, numero: fila.im_ajuste_numero, tipo: fila.im_ajuste_tipo },
      advertencia: importe > total
        ? `La nota de crédito (${importe}) es MAYOR que el pedido (${total}): revisá que corresponda a este pedido y no a varios.`
        : null,
    });
  } catch (err: any) {
    console.error('[vincularAjuste]', err?.message);
    res.status(err.status ?? 500).json({ error: err?.message ?? 'error' });
  }
}

/** La cabecera completa de un comprobante de IM, con cliente e importe. */
async function comprobanteCompleto(id: string): Promise<any | null> {
  try {
    const cli = await imClient();
    const { data } = await imGetRetry(() => cli.get(`/ventas/${id}`), `nota ${id}`);
    return data?.results ?? data?.venta ?? data ?? null;
  } catch (err: any) {
    if (err?.response?.status === 404) return null;
    throw err;
  }
}
