import type { Request, Response } from 'express';
import type { JwtPayload } from './auth.js';
import { sb, TENANT_ID } from './supabase.js';
import { leerComprobante } from './infomanager.js';
import { compararPar, type CabeceraMinima, type Evidencia } from './evidenciaComprobantes.js';
import { textoControl } from './controlFacturaRemito.js';
import { frenaSiNoPuede } from './facturarPresupuestos.js';

/**
 * GET /api/facturacion/comparar/:imComprobanteId — comparar UN par a pedido.
 *
 * El tablero compara con lo que ya leyó; los pares cuyos comprobantes son de días que la pantalla
 * no trajo quedan sin verificar. Esto es para ésos: dos lecturas puntuales, sólo cuando alguien
 * lo pide.
 *
 * 🔴 CERO ESCRITURAS. No toca InfoManager ni la base: lee y contesta.
 */
export async function compararFacturaConRemito(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  const id = String(req.params.imComprobanteId ?? '').trim();
  if (!/^\d+$/.test(id)) { res.status(400).json({ error: 'Pedido inválido.' }); return; }
  try {
    const { data: par, error } = await sb().from('presupuestos_facturados')
      .select('im_comprobante_id, im_factura_id, im_factura_numero, im_factura_tipo, im_remito_id, im_remito_numero, cod_cliente, cod_empresa')
      .eq('tenant_id', TENANT_ID).eq('im_comprobante_id', id).maybeSingle();
    if (error) { res.status(502).json({ error: `No pude leer el vínculo: ${error.message}` }); return; }
    if (!par?.im_factura_id || !par?.im_remito_id) {
      res.status(409).json({ error: 'Ese pedido no tiene factura y remito vinculados.' }); return;
    }

    const [fa, re] = await Promise.all([
      leerComprobante(String(par.im_factura_id)),
      leerComprobante(String(par.im_remito_id)),
    ]);

    /**
     * 🔴 El vínculo se revalida DESPUÉS de leer: entre la primera consulta y la respuesta de IM
     * alguien pudo corregir la factura o rehacer el remito, y contestar sobre los comprobantes
     * viejos sería afirmar algo que ya no es.
     */
    const { data: ahora } = await sb().from('presupuestos_facturados')
      .select('im_factura_id, im_remito_id').eq('tenant_id', TENANT_ID).eq('im_comprobante_id', id).maybeSingle();
    if (String(ahora?.im_factura_id ?? '') !== String(par.im_factura_id) ||
        String(ahora?.im_remito_id ?? '') !== String(par.im_remito_id)) {
      res.status(409).json({ error: 'Los comprobantes de este pedido cambiaron mientras se consultaba. Actualizá y probá de nuevo.' });
      return;
    }

    const cab = (c: any, id: string): CabeceraMinima => ({
      id, tipo_comprobante: c.tipo_comprobante, tipo_factura: c.tipo_factura, numero: c.numero,
      cod_cliente: c.cod_cliente, cod_empresa: c.cod_empresa,
      // 🪤 `parsearCabeceraComprobante` ya devuelve booleano (o null): se traduce al 'S'/'N' que
      // espera la comparación, y un `null` NO se convierte en 'N'.
      anulada: c.anulada === true ? 'S' : c.anulada === false ? 'N' : '',
    });
    const evidencia: Evidencia = {
      leidoEn: Date.now(),
      cabeceras: new Map([
        [String(par.im_factura_id), cab(fa.cabecera, String(par.im_factura_id))],
        [String(par.im_remito_id), cab(re.cabecera, String(par.im_remito_id))],
      ]),
      renglones: new Map([
        [String(par.im_factura_id), fa.crudos],
        [String(par.im_remito_id), re.crudos],
      ]),
    };

    const r = compararPar(par, evidencia);
    res.json({
      ok: true, im_comprobante_id: id,
      // 🪤 Cuándo se leyó lo que se está afirmando: sin eso, un resultado viejo en pantalla es
      // indistinguible de uno recién traído.
      checked_at: new Date(evidencia.leidoEn).toISOString(),
      control: { estado: r.estado, texto: textoControl(r), diferencias: r.diferencias ?? [] },
    });
  } catch (err: any) {
    console.error('[compararFacturaConRemito]', err?.message);
    res.status(502).json({ error: `No pude leer los comprobantes en InfoManager: ${err?.message ?? 'sin respuesta'}` });
  }
}
