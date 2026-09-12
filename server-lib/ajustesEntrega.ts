import { invalidarIM } from './infomanager.js';
import { invalidarVista } from './vistaPresupuestos.js';
import { invalidarRemitos } from './vistaRemitos.js';
import { randomUUID } from 'node:crypto';
import { enriquecerEntregas, mutarReparto, leerPaginas, notasDeHoja, notasUnicas, aplicarImportesCierre, vincularNotaRPC } from './repartoDatos.js';
import { verificarNota, cambioDesdeLaPantalla } from './notaVinculable.js';
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
      .select('id, numero, fecha, estado, version, cierres_importes, hojas_ruta_pedidos(*)')
      .eq('id', hojaId).eq('tenant_id', TENANT_ID).maybeSingle();
    if (errHoja) { res.status(500).json({ error: errHoja.message }); return; }
    if (!hoja) { res.status(404).json({ error: 'Hoja de ruta no encontrada' }); return; }

    const { data: ajustes, error } = await sb().from('hojas_ruta_ajustes')
      .select('*').eq('tenant_id', TENANT_ID).eq('hoja_id', hojaId).order('created_at');
    if (error) { res.status(500).json({ error: error.message }); return; }

    /**
     * 🔑 Una hoja CERRADA conserva su base histórica: se lee el snapshot del cierre y no se
     * vuelve a preguntar a InfoManager. Si el importe se reconsultara, abrir esta pantalla podría
     * cambiar un número ya liquidado —y encima paga el viaje a IM cada vez que alguien mira.
     */
    const cerrada = String((hoja as any).estado) === 'cerrada';
    const pedidos = aplicarImportesCierre(hoja, await enriquecerEntregas((hoja as any).hojas_ruta_pedidos ?? [], false, !cerrada));
    const conNotas = await notasDeHoja(hojaId, pedidos);
    const notas = notasUnicas(conNotas.flatMap((p: any) => p.notas ?? []), `la hoja ${(hoja as any).numero}`);

    /**
     * 🔑 Los renglones son TODAS las notas que afectan el total, no sólo las que vinculó el
     * panel. Una nota emitida por el circuito de corrección de factura ya descuenta acá: si no
     * se listara, el final no cuadraría con lo que se ve y nadie sabría por qué.
     *
     * 🔴 Y `ajuste_id` —lo único que habilita soltarla— sólo va cuando el panel es la ÚNICA
     * fuente. Si la misma nota también está en el journal, borrar la fila del panel no cambia el
     * total: el journal la sigue descontando. Ofrecer el botón ahí es prometer un efecto que no
     * ocurre, y se descubre después de tocarlo (caso real: la NC B 13 de ANDRADES).
     */
    const porNota = new Map((ajustes ?? []).filter((a: any) => a.im_ajuste_id).map((a: any) => [String(a.im_ajuste_id), a]));
    const renglones = notas.map((n: any) => {
      const a = porNota.get(String(n.id));
      const fuentes: string[] = n.fuentes ?? [];
      const soloPanel = fuentes.length === 1 && fuentes[0] === 'panel';
      return {
        im_ajuste_id: String(n.id), tipo: n.tipo, numero: n.numero ?? null,
        importe: Math.abs(Number(n.total)), signo: /^nc/i.test(String(n.tipo ?? '')) ? -1 : 1,
        origen: fuentes.length > 1 ? 'ambas' : (fuentes[0] ?? (a ? 'panel' : 'correccion')),
        ajuste_id: soloPanel ? (a?.id ?? null) : null,
        motivo: a?.motivo ?? null,
        im_comprobante_id: a?.im_comprobante_id ?? null,
      };
    });
    /**
     * 🔑 A qué factura va a ir la nota, para que se vea ANTES de confirmar. El vínculo manda esta
     * misma factura de vuelta y la base la revalida bajo lock: si cambió en el medio, corta.
     */
    const entregas = pedidos.map((p: any) => ({
      im_comprobante_id: String(p.im_comprobante_id),
      im_numero: p.im_numero ?? null,
      cliente_nombre: p.cliente_nombre ?? null,
      cod_cliente: p.cod_cliente ?? null,
      total: p.total ?? null,
      im_factura_id: p.im_factura_id ?? null,
      im_factura_numero: p.im_factura_numero ?? null,
    }));
    res.json({ ok: true, ...totalesConAjustes({ ...hoja, hojas_ruta_pedidos: pedidos }, ajustes ?? [], notas), ajustes: ajustes ?? [], notas: renglones, entregas });
  } catch (err: any) {
    console.error('[listarAjustes]', err?.message);
    res.status(err.status ?? 500).json({ error: err?.message ?? 'error' });
  }
}

/**
 * El número final de una hoja: lo despachado, menos lo acreditado, más lo debitado.
 *
 * 🔑 Las notas llegan YA conciliadas de la fuente común (journal de correcciones + ajustes del
 * panel), que es la misma que usan la impresión y la liquidación del chofer. Sumar acá sólo
 * `hojas_ruta_ajustes` daba un número distinto del que decía el papel de la misma hoja.
 *
 * 🪤 Sólo cuentan las notas EMITIDAS. Una que quedó a medias no bajó ninguna cuenta corriente,
 * así que restarla haría que al chofer se le pague de menos por algo que no pasó — por eso la
 * fuente común filtra por `emitido_at`.
 */
export function totalesConAjustes(hoja: any, ajustes: any[], notas: ReadonlyArray<{ tipo?: unknown; total?: unknown }> = []) {
  const despachado = (hoja.hojas_ruta_pedidos ?? []).reduce((s: number, p: any) => s + Number(p.total ?? 0), 0);
  const suma = (f: (t: string) => boolean) =>
    notas.filter(n => f(String(n.tipo ?? ''))).reduce((s, n) => s + Math.abs(Number(n.total)), 0);
  const nc = suma(t => /^nc/i.test(t)), nd = suma(t => /^nd/i.test(t));
  return {
    hoja: { version: hoja.version, id: hoja.id, numero: hoja.numero, fecha: hoja.fecha, estado: hoja.estado },
    despachado: redondear(despachado),
    notas_credito: redondear(nc),
    notas_debito: redondear(nd),
    /** La base de liquidación de la hoja. */
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
 * GET /api/hojas-ruta/:id/ajustes/candidatas?im_comprobante_id= — qué notas de InfoManager
 * podrían corresponder a este pedido.
 *
 * Trae las NC y ND del cliente desde la fecha de la hoja en adelante, saca las que ya están
 * contadas, y marca las que mencionan el número de la hoja en las observaciones — que es justo
 * lo que la oficina ya escribe (`SEGUN HR 3210`, en 287 de 724 notas).
 */
export async function candidatasAVincular(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  try {
    const hojaId = String(req.params.id);
    const comprobanteId = String(req.query.im_comprobante_id ?? '').trim();
    const { data: hoja, error: errHoja } = await sb().from('hojas_ruta')
      .select('id, numero, fecha, hojas_ruta_pedidos(im_comprobante_id, cod_cliente, cod_empresa, cliente_nombre, total)')
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
      ['NC', 'ND'].includes(String(v.tipo_comprobante ?? '').trim().toUpperCase()) &&
      String(v.anulada ?? '').trim().toUpperCase() !== 'S' &&
      clientes.has(Number(v.cod_cliente)));

    /**
     * Lo que ya está contado no se vuelve a ofrecer, venga de donde venga:
     *  · `hojas_ruta_ajustes` — ya atada a una entrega desde el panel.
     *  · `facturas_correcciones` — el journal del circuito de corrección de factura. Esas notas
     *    YA descuentan en el total de la hoja; ofrecerlas sería invitar a contarlas dos veces.
     * 🪤 Paginado: son tablas que crecen con cada nota del año, y `select` sin paginar corta en
     * el tope de PostgREST — justo las que faltan serían las más nuevas.
     */
    let usadas: any[], enJournal: any[];
    try {
      [usadas, enJournal] = await Promise.all([
        leerPaginas(() => sb().from('hojas_ruta_ajustes').select('im_ajuste_id').eq('tenant_id', TENANT_ID).not('im_ajuste_id', 'is', null).order('id')),
        leerPaginas(() => sb().from('facturas_correcciones').select('im_comprobante_id').eq('tenant_id', TENANT_ID).order('id')),
      ]);
    } catch (err: any) {
      res.status(502).json({ error: `No pude ver qué notas ya están contadas: ${err?.message ?? 'sin respuesta'}` });
      return;
    }
    const yaUsadas = new Set([...usadas.map((u: any) => String(u.im_ajuste_id)), ...enJournal.map((c: any) => String(c.im_comprobante_id))]);

    const numeroHoja = String((hoja as any).numero);
    /**
     * 🔴 La MISMA validación que exige el POST, antes de ofrecerla: una nota de otra empresa, con
     * la vigencia ilegible, sin número o con importe inválido va a ser rechazada igual. Mostrarla
     * es invitar a un clic que sólo puede terminar en error.
     */
    const candidatas = ncs
      .filter((v: any) => !yaUsadas.has(String(v.id)))
      .filter((v: any) => {
        const p = (pedido ? [pedido] : pedidos).find((p: any) => Number(p.cod_cliente) === Number(v.cod_cliente));
        return !!p && verificarNota(v, v.id, p, EMPRESA_DEFAULT).ok;
      })
      .map((v: any) => {
        const obs = String(v.observaciones ?? '');
        return {
          im_ajuste_id: String(v.id),
          numero: v.numero ?? null,
          tipo: `${String(v.tipo_comprobante ?? '').trim().toUpperCase()} ${String(v.tipo_factura ?? '').trim()}`.trim(),
          // 🔑 El signo sale del TIPO de IM: la NC resta y la ND suma.
          signo: String(v.tipo_comprobante ?? '').trim().toUpperCase() === 'NC' ? -1 : 1,
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
    res.status(502).json({ error: `No pude traer las notas de InfoManager: ${err?.message ?? 'sin respuesta'}` });
  }
}

/**
 * POST /api/hojas-ruta/:id/ajustes/vincular — ata una nota ya emitida en IM a un pedido de la hoja.
 *
 * Body: `{ im_comprobante_id, im_ajuste_id, motivo?, esperado?: { tipo, numero, importe } }`.
 *
 * 🔑 El importe, el tipo y el número salen de la nota REAL leída de InfoManager, nunca del body:
 * si vinieran de la pantalla, el número final de la hoja —y el pago del chofer— dependería de lo
 * que alguien tipeó. `esperado` es sólo una condición: si la nota cambió desde que se mostró, se
 * corta y se pide recargar en vez de grabar una cifra que el operador no vio.
 *
 * 🪤 Esto REGISTRA la nota en la hoja: este handler no escribe nada en InfoManager ni toca stock.
 */
export async function vincularAjuste(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  try {
    const hojaId = String(req.params.id);
    const b = req.body ?? {};
    const comprobanteId = String(b.im_comprobante_id ?? '').trim();
    const ajusteId = String(b.im_ajuste_id ?? '').trim();
    if (!comprobanteId || !ajusteId) { res.status(400).json({ error: 'Falta el pedido o la nota.' }); return; }

    const { data: hoja, error: errHoja } = await sb().from('hojas_ruta')
      .select('id, numero, estado, hojas_ruta_pedidos(im_comprobante_id, cod_cliente, cod_empresa, cliente_nombre, total, facturado_at, im_factura_id, im_factura_numero)')
      .eq('id', hojaId).eq('tenant_id', TENANT_ID).maybeSingle();
    if (errHoja) { res.status(502).json({ error: errHoja.message }); return; }
    if (!hoja) { res.status(404).json({ error: 'Hoja de ruta no encontrada' }); return; }
    if (String((hoja as any).estado) === 'cerrada') {
      res.status(409).json({ error: `La hoja ${(hoja as any).numero} está cerrada: ya se liquidó. Reabrila si de verdad hay que ajustarla.` });
      return;
    }
    const pedido = ((hoja as any).hojas_ruta_pedidos ?? []).find((p: any) => String(p.im_comprobante_id) === comprobanteId);
    if (!pedido) { res.status(409).json({ error: 'Ese pedido no está en esta hoja.' }); return; }

    /**
     * 🔴 La factura de destino tiene que ser LA MISMA que se le mostró. La guarda de la base ya
     * exige que la entrega tenga una sola, pero eso no alcanza: entre que se abrió la pantalla y
     * se confirmó, la entrega pudo quedar apareada a otra factura, y la nota terminaría
     * descontando de un comprobante que nadie miró.
     */
    const facturaVista = String(b.im_factura_id ?? '').trim();
    if (!facturaVista) { res.status(400).json({ error: 'Falta la factura que se vio al vincular. Recargá la pantalla.' }); return; }
    if (facturaVista !== String(pedido.im_factura_id ?? '')) {
      res.status(409).json({ error: 'La factura de esta entrega cambió desde que abriste la pantalla. Recargá y revisá antes de vincular.', recargar: true });
      return;
    }


    // ── La nota, leída de InfoManager ────────────────────────────────────────
    const cruda = await comprobanteCompleto(ajusteId);
    const v = verificarNota(cruda, ajusteId, pedido, EMPRESA_DEFAULT);
    if (!v.ok) { res.status(cruda ? 409 : 404).json({ error: v.error }); return; }

    // 🔴 Sin lo que se vio en pantalla no hay contra qué comparar: se corta, no se asume.
    const cotejo = cambioDesdeLaPantalla(v, b.esperado);
    if (!cotejo.ok) {
      res.status(cotejo.recargar ? 409 : 400).json({ error: cotejo.motivo, ...(cotejo.recargar ? { recargar: true } : {}) });
      return;
    }

    const fila = {
      tenant_id: TENANT_ID, hoja_id: hojaId, im_comprobante_id: comprobanteId,
      cod_cliente: Number(pedido.cod_cliente), cliente_nombre: pedido.cliente_nombre ?? null,
      tipo: v.tipo.toLowerCase(), importe: v.importe, items: [], cod_empresa: Number(pedido.cod_empresa),
      motivo: String(b.motivo ?? cruda?.observaciones ?? 'Diferencia de entrega').slice(0, 200),
      im_ajuste_id: v.id, im_ajuste_numero: v.numero,
      im_ajuste_tipo: `${v.tipo} ${v.letra}`,
      // Ya está emitida en IM: por eso cuenta para el número final desde el momento en que se ata.
      emitido_at: new Date().toISOString(),
      created_by: req.user?.sub ?? null,
    };
    /**
     * La comparación de arriba usa `hojas_ruta_pedidos.im_factura_id`, que es un snapshot. La
     * definitiva la hace la base bajo su propio lock, contra `facturas_de_entrega`.
     */
    await vincularNotaRPC(req.user?.sub, hojaId, b.version_esperada, fila, facturaVista);

    // Aviso, no bloqueo: una nota puede cubrir más de un pedido y el dato de IM es el que manda.
    const total = Number(pedido.total ?? 0);
    res.json({
      ok: true,
      ajuste: { importe: v.importe, numero: v.numero, tipo: fila.im_ajuste_tipo, signo: v.signo },
      advertencia: v.importe > total
        ? `La nota (${v.importe}) es MAYOR que el pedido (${total}): revisá que corresponda a este pedido y no a varios.`
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
