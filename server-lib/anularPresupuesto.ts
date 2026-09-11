import { bloquearPresupuesto, desbloquearPresupuesto, invalidarAprobacion, exigirTipoEmpresa, rechazoEdicionConfirmado } from './versionPresupuesto.js';
import { invalidarIM } from './infomanager.js';
/**
 * ANULAR UN PRESUPUESTO DESDE EL PANEL.
 *
 * Mati (10/09/2026): *"ver la manera de tener la opción de anular algún presupuesto"*, y en la
 * misma tanda *"Bianconi sigue apareciendo en la app y eso ya lo resolvimos"*.
 *
 * 🔑 EL CASO DE BIANCONI EXPLICA PARA QUÉ SIRVE. El PR 58288 estaba en `tipo_presupuesto: 'NC'`
 * (desconfirmado) pero con `anulada: 'N'`, y la vista del panel filtra los ANULADOS, no los
 * desconfirmados. Desconfirmar no lo saca de la lista; anularlo sí.
 *
 * 🔴 Y NO se puede filtrar por `tipo_presupuesto` en su lugar: medido contra IM el 10/09/2026,
 * **30 de los 47 pedidos vivos de un solo vendedor** estaban en 'NC'. Ese filtro escondería
 * pedidos reales, que es mucho peor que el problema que resuelve.
 */
import type { Request, Response } from 'express';
import type { JwtPayload } from './auth.js';
import { sb, TENANT_ID } from './supabase.js';
import { puedeArmarHojasDeRuta } from './permisos.js';
import { anularComprobante, cabeceraComprobante, fechaArgentina } from './infomanager.js';
import { invalidarVista } from './vistaPresupuestos.js';
import { invalidarRemitos } from './vistaRemitos.js';

/** POST /api/presupuestos/:comprobanteId/anular — body: `{ motivo? }` */
export async function anularPresupuesto(req: Request & { user?: JwtPayload }, res: Response) {
  if (!puedeArmarHojasDeRuta(String(req.user?.rol ?? ''))) {
    res.status(403).json({ error: 'Anular un pedido lo hace administración.' });
    return;
  }
  const id = String(req.params.comprobanteId ?? '').trim();
  if (!/^\d+$/.test(id)) { res.status(400).json({ error: 'Falta el pedido.' }); return; }
  const motivo = String(req.body?.motivo ?? '').trim().slice(0, 150);

  let token: string | null = null; let conocido = true;
  try {
    token = await bloquearPresupuesto(id, 'anular');
    /**
     * 🔴 LO PRIMERO: que no esté facturado. Anular el presupuesto de una factura emitida deja la
     * factura sin el pedido que la explica, y el panel lo vuelve a ofrecer para facturar.
     */
    const { data: emitido, error: errEmitido } = await sb().from('presupuestos_facturados')
      .select('im_factura_numero, im_factura_id, im_remito_numero,estado_emision')
      .eq('tenant_id', TENANT_ID).eq('im_comprobante_id', id).maybeSingle();
    if (errEmitido) throw new Error(errEmitido.message);
    if ((emitido as any)?.im_factura_id || emitido?.estado_emision) {
      res.status(409).json({
        error: `Ese pedido ya está facturado (FA ${(emitido as any).im_factura_numero ?? ''}). Para deshacerlo hay que anular la factura en InfoManager, o corregirla con una nota de crédito.`,
      });
      return;
    }

    const cab = await cabeceraComprobante(id);
    if (cab.existe === false) { res.status(404).json({ error: 'Ese pedido ya no está en InfoManager.' }); return; }
    // 🪤 `null` es "no pude preguntar", y no habilita a anular a ciegas.
    if (cab.existe !== true) { res.status(502).json({ error: 'No pude verificar el pedido en InfoManager. Probá de nuevo en un rato.' }); return; }
    if (cab.anulada === true) { res.status(409).json({ error: 'Ese pedido ya está anulado en InfoManager.' }); return; }

    if (cab.anulada !== false) { res.status(502).json({ error: 'No pude verificar si el presupuesto sigue vigente. No se anuló.' }); return; }
    exigirTipoEmpresa(cab, 'PR');
    await invalidarAprobacion(id);
    conocido = false;
    const r = await anularComprobante({
      id,
      numero: Number(cab.numero) || 0,
      punto_de_venta: Number(cab.punto_de_venta) || 1,
      fecha: cab.fecha ?? fechaArgentina(),
      tipo_comprobante: 'PR',
      observaciones: (motivo ? `ANULADO: ${motivo}` : 'Anulado desde el panel de oficina').slice(0, 500),
    });
    conocido = r.ok || rechazoEdicionConfirmado(r);
    if (!r.ok) {
      console.error(`[anularPresupuesto] PR ${cab.numero}: ${r.error}`);
      res.status(502).json({ error: `InfoManager no lo anuló: ${r.error}` });
      return;
    }

    // Sale de las dos listas: la de presupuestos y la de remitos.
    invalidarVista(); invalidarRemitos();
    res.json({ ok: true, numero: cab.numero ?? null });
  } catch (err: any) {
    console.error('[anularPresupuesto]', err?.message);
    res.status(err.status ?? 502).json({ error: `No se pudo anular: ${err?.message ?? 'sin respuesta de InfoManager'}` });
  } finally {
    if (token && conocido) await desbloquearPresupuesto(id, token);
    invalidarIM(); invalidarVista(); invalidarRemitos();
  }
}
