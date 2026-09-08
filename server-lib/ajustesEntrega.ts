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
 */
import type { Request, Response } from 'express';
import { sb, TENANT_ID } from './supabase.js';
import type { JwtPayload } from './auth.js';
import { puedeArmarHojasDeRuta } from './permisos.js';
import { fetchClientesIMCached, fetchVentasItems, cabeceraComprobante } from './infomanager.js';
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
/** Igual que en la facturación: un reclamo sin emitir vence a los 5 minutos. */
const RECLAMO_VENCE_MS = 5 * 60_000;

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
  try {
    const hojaId = String(req.params.id);
    const b = req.body ?? {};
    const comprobanteId = String(b.im_comprobante_id ?? '').trim();
    const motivo = String(b.motivo ?? '').trim().slice(0, 200);
    const entrada: any[] = Array.isArray(b.items) ? b.items : [];
    if (!comprobanteId) { res.status(400).json({ error: 'No dijiste de qué pedido es la diferencia.' }); return; }
    if (!motivo) { res.status(400).json({ error: 'Escribí el motivo: es lo que se lee después en InfoManager.' }); return; }
    if (!entrada.length) { res.status(400).json({ error: 'No mandaste ningún renglón para acreditar.' }); return; }

    const { data: hoja, error: errHoja } = await sb().from('hojas_ruta')
      .select('id, numero, fecha, estado, cod_empresa, hojas_ruta_pedidos(im_comprobante_id, cod_cliente, cliente_nombre, total)')
      .eq('id', hojaId).eq('tenant_id', TENANT_ID).maybeSingle();
    if (errHoja) { res.status(502).json({ error: `No pude leer la hoja: ${errHoja.message}` }); return; }
    if (!hoja) { res.status(404).json({ error: 'Hoja de ruta no encontrada' }); return; }

    const pedido = ((hoja as any).hojas_ruta_pedidos ?? [])
      .find((p: any) => String(p.im_comprobante_id) === comprobanteId);
    if (!pedido) { res.status(409).json({ error: 'Ese pedido no está en esta hoja.' }); return; }

    // ── Lo que se acredita no puede pasar lo que se entregó ───────────────────
    // 🔴 Sin este control, un error de tipeo genera una nota de crédito por más de lo que el
    // cliente compró y le queda saldo a favor de la nada.
    const cab = await cabeceraComprobante(comprobanteId);
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

    // ── Reclamo: la fila existe antes de emitir ───────────────────────────────
    const { data: previos, error: errPrev } = await sb().from('hojas_ruta_ajustes')
      .select('id, emitido_at, reclamado_at').eq('tenant_id', TENANT_ID)
      .eq('im_comprobante_id', comprobanteId).is('emitido_at', null);
    if (errPrev) { res.status(502).json({ error: `No pude verificar si hay un ajuste a medias: ${errPrev.message}` }); return; }
    const enCurso = (previos ?? []).find((p: any) => Date.now() - new Date(p.reclamado_at ?? 0).getTime() < RECLAMO_VENCE_MS);
    if (enCurso) { res.status(409).json({ error: 'Ya hay una nota de crédito de este pedido emitiéndose en este momento.' }); return; }
    if ((previos ?? []).length) {
      res.status(409).json({
        error: 'Quedó un ajuste anterior sin terminar de este pedido. **Puede que la nota de crédito se haya emitido igual**: verificalo en InfoManager y borrá el ajuste a medias antes de cargar otro.',
      });
      return;
    }

    const { data: fila, error: errFila } = await sb().from('hojas_ruta_ajustes').insert({
      tenant_id: TENANT_ID, hoja_id: hojaId, im_comprobante_id: comprobanteId,
      cod_cliente: Number(pedido.cod_cliente), cliente_nombre: pedido.cliente_nombre ?? null,
      tipo: 'nc', motivo, importe,
      reclamado_at: new Date().toISOString(), created_by: req.user?.sub ?? null,
    }).select().maybeSingle();
    if (errFila || !fila) { res.status(500).json({ error: `No pude registrar el ajuste: ${errFila?.message ?? 'sin respuesta'}` }); return; }

    // ── Emisión ──────────────────────────────────────────────────────────────
    const clientes = await fetchClientesIMCached().catch(() => [] as any[]);
    const cliente = clientes.find((c: any) => Number(c.cod_cliente) === Number(pedido.cod_cliente));
    const usuario = await usuarioIM(req.user);
    const nc = await emitirNotaCredito({
      cod_empresa: Number((hoja as any).cod_empresa) || 1,
      cod_cliente: Number(pedido.cod_cliente),
      cod_vendedor: Number(renglones[0]?.cod_vendedor ?? 0) || 1,
      categoria_iva: cliente?.categoria_iva,
      cod_lista_precios: Number(renglones[0]?.cod_lista_precios) || 12,
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
 * DELETE /api/hojas-ruta/ajustes/:id — borra un ajuste que NO llegó a emitirse.
 *
 * 🔴 Lo emitido no se borra: existe en InfoManager y bajó una cuenta corriente. Para deshacerlo
 * hay que anular la nota de crédito en IM.
 */
export async function borrarAjuste(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  const { data, error } = await sb().from('hojas_ruta_ajustes')
    .delete().eq('tenant_id', TENANT_ID).eq('id', String(req.params.id)).is('emitido_at', null).select();
  if (error) { res.status(500).json({ error: error.message }); return; }
  if (!(data ?? []).length) {
    res.status(409).json({ error: 'Ese ajuste ya se emitió en InfoManager: para deshacerlo hay que anular la nota de crédito allá.' });
    return;
  }
  res.json({ ok: true });
}
