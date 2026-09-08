/**
 * Lo que se ajusta cuando VUELVE el repartidor: notas de crédito por lo que no se entregó.
 *
 * Mati (08/09/2026): *"una vez que vuelve el repartidor se hacen NC o facturas por dif de
 * mercadería y eso impacta en el num final de la hoja... la HR siempre tiene que estar
 * actualizada, porque también la analizamos luego"*. Y ese número final es la base del pago al
 * chofer, así que no puede ser aproximado.
 *
 * 🔴 EMITIR UNA NOTA DE CRÉDITO ES IRREVERSIBLE: consume numeración fiscal y toca la cuenta
 * corriente del cliente. Mismo criterio que la facturación:
 *  · se RECLAMA la fila antes de llamar a InfoManager (dos personas no emiten la misma NC),
 *  · se registra apenas se emite,
 *  · no se acredita más de lo que se facturó,
 *  · y si IM no contesta, no se reintenta solo.
 *
 * 🪤 La API de IM no relaciona la NC con su factura (verificado el 08/09/2026). El vínculo lo
 * guarda esta tabla. Y en las observaciones va `SEGUN HR <nº>`, que es lo que la oficina ya
 * escribe a mano: de 724 NC en 90 días, 287 lo tienen.
 *
 * 🔴 **HOY EL CAMINO ES VINCULAR, NO EMITIR.** InfoManager NO deja emitir notas de crédito por
 * API en el punto de venta 777: su validación de unicidad del número **no incluye el tipo de
 * comprobante**, y como cada tipo lleva su propia serie, el número que le toca a la NC ya lo usó
 * una factura hace tiempo (*"Ya existe una factura con... numero = 30059"*). Probado el
 * 08/09/2026, y probado también que **el payload está bien**: la misma nota se creó sin problemas
 * en el punto 999, que no tiene serie de facturas encima. Ver
 * `reference_im_nc_numeracion_bloqueada_20260908` en la memoria.
 *
 * ⇒ La oficina emite la NC en IM como siempre y el panel **la vincula** a la hoja, que es lo
 * único que hace falta para el número final. La emisión queda escrita y detrás de un
 * interruptor (`IM_NC_EMISION_HABILITADA`) para el día que Sistec arregle la validación.
 */
import type { Request, Response } from 'express';
import { sb, TENANT_ID } from './supabase.js';
import type { JwtPayload } from './auth.js';
import { puedeArmarHojasDeRuta } from './permisos.js';
import {
  fetchClientesIMCached, fetchVentasItems, cabeceraComprobante, fetchVentas, fechaArgentina, imClient,
} from './infomanager.js';
import { emitirNotaCredito } from './facturarIM.js';
import { usuarioIM } from './pedidos.js';

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
const emisionHabilitada = () => process.env.IM_NC_EMISION_HABILITADA === '1';
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
      .select('id, numero, fecha, estado, hojas_ruta_pedidos(total)')
      .eq('id', hojaId).eq('tenant_id', TENANT_ID).maybeSingle();
    if (errHoja) { res.status(500).json({ error: errHoja.message }); return; }
    if (!hoja) { res.status(404).json({ error: 'Hoja de ruta no encontrada' }); return; }

    const { data: ajustes, error } = await sb().from('hojas_ruta_ajustes')
      .select('*').eq('tenant_id', TENANT_ID).eq('hoja_id', hojaId).order('created_at');
    if (error) { res.status(500).json({ error: error.message }); return; }

    res.json({ ok: true, ...totalesConAjustes(hoja, ajustes ?? []), ajustes: ajustes ?? [] });
  } catch (err: any) {
    console.error('[listarAjustes]', err?.message);
    res.status(500).json({ error: err?.message ?? 'error' });
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
    hoja: { id: hoja.id, numero: hoja.numero, fecha: hoja.fecha, estado: hoja.estado },
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
export async function crearAjuste(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  if (!emisionHabilitada()) {
    res.status(501).json({
      error: 'InfoManager no acepta notas de crédito por API en el punto 777 (su validación de números no distingue el tipo de comprobante). Hacela en IM y después vinculala acá.',
    });
    return;
  }
  try {
    const hojaId = String(req.params.id);
    const b = req.body ?? {};
    const comprobanteId = String(b.im_comprobante_id ?? '').trim();
    const motivo = String(b.motivo ?? '').trim().slice(0, 200);
    const entrada: any[] = Array.isArray(b.items) ? b.items : [];
    if (!comprobanteId) { res.status(400).json({ error: 'No dijiste de qué pedido es la diferencia.' }); return; }
    if (!motivo) { res.status(400).json({ error: 'Escribí el motivo: es lo que se lee después en InfoManager.' }); return; }
    if (!entrada.length) { res.status(400).json({ error: 'No mandaste ningún renglón para acreditar.' }); return; }

    // 🪤 `hojas_ruta` NO tiene `cod_empresa` (no la crea ninguna migración): pedirla hacía que
    // PostgREST rechazara la consulta entera y no se emitiera nunca una nota de crédito.
    const { data: hoja, error: errHoja } = await sb().from('hojas_ruta')
      .select('id, numero, fecha, estado, hojas_ruta_pedidos(im_comprobante_id, cod_cliente, cliente_nombre, total, facturado_at, im_factura_numero)')
      .eq('id', hojaId).eq('tenant_id', TENANT_ID).maybeSingle();
    if (errHoja) { res.status(502).json({ error: `No pude leer la hoja: ${errHoja.message}` }); return; }
    if (!hoja) { res.status(404).json({ error: 'Hoja de ruta no encontrada' }); return; }
    // Una hoja cerrada ya se liquidó: cargarle una NC ahora cambiaría un pago hecho.
    if (String((hoja as any).estado) === 'cerrada') {
      res.status(409).json({ error: `La hoja ${(hoja as any).numero} está cerrada: ya se liquidó. Reabrila si de verdad hay que ajustarla.` });
      return;
    }

    const pedido = ((hoja as any).hojas_ruta_pedidos ?? [])
      .find((p: any) => String(p.im_comprobante_id) === comprobanteId);
    if (!pedido) { res.status(409).json({ error: 'Ese pedido no está en esta hoja.' }); return; }
    // 🔴 No se acredita lo que nunca se cobró: sin factura no hay nada que devolver.
    if (!pedido.facturado_at && !pedido.im_factura_numero) {
      res.status(409).json({ error: 'Ese pedido todavía no se facturó: no hay nada que acreditar. Si no se entregó, sacalo de la hoja.' });
      return;
    }

    // La empresa sale de la factura que se emitió, que es la que la NC tiene que revertir.
    const { data: emitido, error: errEmitido } = await sb().from('presupuestos_facturados')
      .select('cod_empresa, im_factura_numero').eq('tenant_id', TENANT_ID)
      .eq('im_comprobante_id', comprobanteId).maybeSingle();
    if (errEmitido) { res.status(502).json({ error: `No pude leer la factura de ese pedido: ${errEmitido.message}` }); return; }
    const codEmpresa = Number((emitido as any)?.cod_empresa) || EMPRESA_DEFAULT;

    // ── Lo que se acredita no puede pasar lo que se entregó ───────────────────
    // 🔴 Sin este control, un error de tipeo genera una nota de crédito por más de lo que el
    // cliente compró y le queda saldo a favor de la nada.
    const cab = await cabeceraComprobante(comprobanteId);
    // 🪤 Igual que al facturar: `null` es "no pude preguntar" y no habilita nada. Emitir una NC
    // contra un comprobante anulado deja una nota sin respaldo.
    if (cab.existe !== true || cab.anulada !== false) {
      res.status(502).json({ error: 'No pude verificar en InfoManager que el comprobante siga vigente (o está anulado). Probá de nuevo en un rato.' });
      return;
    }
    const dia = cab.fecha ?? String((hoja as any).fecha).slice(0, 10);
    const renglones = (await fetchVentasItems(dia, dia).catch(() => [] as any[]))
      .filter((it: any) => String(it.id_comprobante) === comprobanteId);
    if (!renglones.length) {
      res.status(502).json({ error: 'No pude traer los renglones del pedido desde InfoManager para verificar las cantidades. Probá de nuevo.' });
      return;
    }
    const facturado = new Map<number, { cantidad: number; precio: number; cod_lista_precios: number | null; iva_por: number }>();
    for (const it of renglones) {
      const cod = Number((it as any).cod_articulo);
      const previo = facturado.get(cod);
      facturado.set(cod, {
        cantidad: (previo?.cantidad ?? 0) + Number((it as any).cantidad ?? 0),
        precio: Number((it as any).precio ?? 0),
        cod_lista_precios: (it as any).cod_lista_precios != null ? Number((it as any).cod_lista_precios) : null,
        iva_por: Number((it as any).iva_por ?? 0),
      });
    }

    const items = [];
    for (const i of entrada) {
      const cod = Number(i.cod_articulo);
      const cant = Number(i.cantidad);
      const orig = facturado.get(cod);
      if (!orig) { res.status(409).json({ error: `El artículo ${cod} no está en ese pedido: no se le puede hacer una nota de crédito.` }); return; }
      if (!(cant > 0)) { res.status(400).json({ error: `La cantidad a acreditar del artículo ${cod} tiene que ser mayor a cero.` }); return; }
      if (cant > orig.cantidad) {
        res.status(409).json({ error: `Del artículo ${cod} se entregaron ${orig.cantidad} y estás acreditando ${cant}. No se puede acreditar más de lo facturado.` });
        return;
      }
      items.push({
        cod_articulo: cod, cantidad: cant,
        // El precio sale del comprobante original, no del body: la NC devuelve lo que se cobró.
        precio: orig.precio, iva_por: orig.iva_por, cod_lista_precios: orig.cod_lista_precios,
      });
    }
    const importe = redondear(items.reduce((s, i) => s + i.precio * i.cantidad, 0));
    if (!(importe > 0)) { res.status(400).json({ error: 'La nota de crédito daría cero: revisá los precios del pedido.' }); return; }

    // ── Lo YA acreditado antes ────────────────────────────────────────────────
    // 🔴 El control de arriba mira lo facturado, pero un pedido puede tener VARIAS notas de
    // crédito. Sin sumar las anteriores, cargar dos veces la misma diferencia emitía dos NC
    // enteras y el cliente quedaba con saldo a favor del doble.
    const { data: previos, error: errPrev } = await sb().from('hojas_ruta_ajustes')
      .select('id, emitido_at, reclamado_at, items, importe, tipo')
      .eq('tenant_id', TENANT_ID).eq('im_comprobante_id', comprobanteId);
    if (errPrev) { res.status(502).json({ error: `No pude verificar los ajustes anteriores de este pedido: ${errPrev.message}` }); return; }

    const yaAcreditado = new Map<number, number>();
    for (const a of (previos ?? []) as any[]) {
      if (!a.emitido_at || a.tipo !== 'nc') continue;
      for (const i of (Array.isArray(a.items) ? a.items : [])) {
        const cod = Number(i.cod_articulo);
        yaAcreditado.set(cod, (yaAcreditado.get(cod) ?? 0) + Number(i.cantidad ?? 0));
      }
    }
    for (const i of items) {
      const previo = yaAcreditado.get(i.cod_articulo) ?? 0;
      const tope = facturado.get(i.cod_articulo)!.cantidad;
      if (previo + i.cantidad > tope) {
        res.status(409).json({
          error: `Del artículo ${i.cod_articulo} se entregaron ${tope} y ya se acreditaron ${previo}. No se puede acreditar ${i.cantidad} más.`,
        });
        return;
      }
    }

    // ── Reclamo: la fila existe antes de emitir ───────────────────────────────
    const aMedias = (previos ?? []).filter((p: any) => !p.emitido_at);
    const enCurso = aMedias.find((p: any) => Date.now() - new Date(p.reclamado_at ?? 0).getTime() < RECLAMO_VENCE_MS);
    if (enCurso) { res.status(409).json({ error: 'Ya hay una nota de crédito de este pedido emitiéndose en este momento.' }); return; }
    if (aMedias.length) {
      res.status(409).json({
        error: 'Quedó un ajuste anterior sin terminar de este pedido. **Puede que la nota de crédito se haya emitido igual**: verificalo en InfoManager y borrá el ajuste a medias antes de cargar otro.',
      });
      return;
    }

    const { data: fila, error: errFila } = await sb().from('hojas_ruta_ajustes').insert({
      tenant_id: TENANT_ID, hoja_id: hojaId, im_comprobante_id: comprobanteId,
      cod_cliente: Number(pedido.cod_cliente), cliente_nombre: pedido.cliente_nombre ?? null,
      tipo: 'nc', motivo, importe, items,
      reclamado_at: new Date().toISOString(), created_by: req.user?.sub ?? null,
    }).select().maybeSingle();
    // 🪤 El índice único parcial `(tenant_id, im_comprobante_id) where emitido_at is null` es lo
    // que frena de verdad a dos personas a la vez: el select de arriba solo no alcanza.
    if (errFila || !fila) {
      const choque = String(errFila?.code ?? '') === '23505';
      res.status(choque ? 409 : 500).json({
        error: choque
          ? 'Otro usuario está cargando una nota de crédito de este pedido en este momento.'
          : `No pude registrar el ajuste: ${errFila?.message ?? 'sin respuesta'}`,
      });
      return;
    }

    // ── Emisión ──────────────────────────────────────────────────────────────
    const clientes = await fetchClientesIMCached().catch(() => [] as any[]);
    const cliente = clientes.find((c: any) => Number(c.cod_cliente) === Number(pedido.cod_cliente));
    const usuario = await usuarioIM(req.user);
    const nc = await emitirNotaCredito({
      cod_empresa: codEmpresa,
      cod_cliente: Number(pedido.cod_cliente),
      cod_vendedor: Number(renglones[0]?.cod_vendedor ?? 0) || 1,
      categoria_iva: cliente?.categoria_iva,
      cod_lista_precios: Number(renglones[0]?.cod_lista_precios) || LISTA_FALLBACK,
      usuario,
      // La misma convención que ya usa la oficina en IM.
      observaciones: `${motivo} SEGUN HR ${(hoja as any).numero}`.slice(0, 200),
      origen_id: comprobanteId,
      total: importe,
      cod_deposito: 1,
      items,
    } as any);

    if (!nc.ok) {
      // El reclamo se suelta para poder reintentar, salvo que no se sepa qué pasó.
      if (!nc.sinRespuesta) await sb().from('hojas_ruta_ajustes').delete().eq('id', (fila as any).id);
      res.status(502).json({
        error: nc.sinRespuesta
          ? `InfoManager no contestó. NO se sabe si la nota de crédito se emitió: verificalo en IM antes de volver a cargarla. ${nc.error}`
          : `InfoManager rechazó la nota de crédito: ${nc.error}`,
      });
      return;
    }

    const { error: errUp } = await sb().from('hojas_ruta_ajustes').update({
      im_ajuste_id: nc.id, im_ajuste_numero: nc.numero, im_ajuste_tipo: nc.tipo,
      emitido_at: new Date().toISOString(),
    }).eq('id', (fila as any).id);
    if (errUp) {
      res.status(500).json({
        error: `Se emitió la nota de crédito ${nc.numero} pero NO se pudo registrar (${errUp.message}). ANOTALA: el número final de la hoja va a estar mal hasta que se registre.`,
      });
      return;
    }

    res.json({ ok: true, ajuste: { id: (fila as any).id, importe, motivo, numero: nc.numero, tipo: nc.tipo } });
  } catch (err: any) {
    console.error('[crearAjuste]', err?.message);
    res.status(500).json({ error: err?.message ?? 'error' });
  }
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
 * Se distinguen por `items`: `crearAjuste` EXIGE renglones para emitir y `vincularAjuste` los
 * deja vacíos.
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

  const { error } = await sb().from('hojas_ruta_ajustes')
    .delete().eq('tenant_id', TENANT_ID).eq('id', id);
  if (error) { res.status(500).json({ error: error.message }); return; }
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
      .select('id, numero, estado, hojas_ruta_pedidos(im_comprobante_id, cod_cliente, cliente_nombre, total, facturado_at, im_factura_numero)')
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

    const importe = Math.abs(Number(nc.total ?? 0));
    if (!(importe > 0)) { res.status(409).json({ error: 'Esa nota de crédito tiene importe cero.' }); return; }

    const fila = {
      tenant_id: TENANT_ID, hoja_id: hojaId, im_comprobante_id: comprobanteId,
      cod_cliente: Number(pedido.cod_cliente), cliente_nombre: pedido.cliente_nombre ?? null,
      tipo: 'nc', importe, items: [],
      motivo: String(b.motivo ?? nc.observaciones ?? 'Diferencia de entrega').slice(0, 200),
      im_ajuste_id: String(nc.id), im_ajuste_numero: nc.numero != null ? Number(nc.numero) : null,
      im_ajuste_tipo: `NC ${String(nc.tipo_factura ?? '').trim()}`.trim(),
      // Ya está emitida en IM: por eso cuenta para el número final desde el momento en que se ata.
      emitido_at: new Date().toISOString(),
      created_by: req.user?.sub ?? null,
    };
    const { error } = await sb().from('hojas_ruta_ajustes').insert(fila);
    if (error) {
      const dup = String((error as any).code ?? '') === '23505';
      res.status(dup ? 409 : 500).json({
        error: dup ? 'Esa nota de crédito ya está vinculada a un pedido.' : `No pude vincularla: ${error.message}`,
      });
      return;
    }

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
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/** La cabecera completa de un comprobante de IM, con cliente e importe. */
async function comprobanteCompleto(id: string): Promise<any | null> {
  try {
    const cli = await imClient();
    const { data } = await cli.get(`/ventas/${id}`);
    return data?.results ?? data?.venta ?? data ?? null;
  } catch (err: any) {
    if (err?.response?.status === 404) return null;
    throw err;
  }
}
