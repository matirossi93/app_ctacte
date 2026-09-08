/**
 * RETIRO EN SUCURSAL: los pedidos que no salen en el camión porque el cliente los pasa a buscar.
 *
 * Mati (08/09/2026): *"hay algunos de esos pedidos que no van por hoja de ruta sino que los
 * clientes pasan a retirar (son pocos)... debería ir acumulándose los de todo el mes para poder
 * analizarlo después"*. Y sobre la facturación: *"los retiros en sucursal se facturan igual"*.
 *
 * 🔑 Es un destino alternativo a la hoja de ruta, no una hoja rara: no tiene camión, ni chofer,
 * ni capacidad, ni se imprime hoja. Lo que se quiere de esto es el acumulado del mes, así que
 * vive en su propia tabla (`retiros_sucursal`, migración 034) y el análisis sale de una consulta.
 *
 * 🪤 Un comprobante está en UNA hoja o en retiro, nunca en los dos: si estuviera en los dos, se
 * cargaría en el camión mercadería que el cliente ya vino a buscar.
 */
import type { Request, Response } from 'express';
import { sb, TENANT_ID } from './supabase.js';
import type { JwtPayload } from './auth.js';
import { puedeArmarHojasDeRuta } from './permisos.js';
import { fechaArgentina } from './infomanager.js';
import { invalidarVista } from './vistaPresupuestos.js';

/** Sólo la oficina. Devuelve true si ya contestó el 403. */
function frenaSiNoPuede(req: Request & { user?: JwtPayload }, res: Response): boolean {
  if (!puedeArmarHojasDeRuta(String(req.user?.rol ?? ''))) {
    res.status(403).json({ error: 'Los retiros los maneja administración.' });
    return true;
  }
  return false;
}

/**
 * POST /api/retiros — marca comprobantes como "los retira el cliente".
 *
 * Body: `{ pedidos: [{ im_comprobante_id, im_numero, cod_cliente, cliente_nombre, fecha, total,
 * bultos, kg }] }`. Los comprobantes emitidos (factura y remito) se copian de
 * `presupuestos_facturados`: el cliente se lleva el remito igual que si viajara en el camión.
 */
export async function marcarRetiro(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  try {
    const entrada: any[] = Array.isArray(req.body?.pedidos) ? req.body.pedidos : [];
    if (!entrada.length) { res.status(400).json({ error: 'No mandaste ningún pedido.' }); return; }
    // Tope explícito: truncar la consulta de abajo dejaría pasar un pedido que ya está en una hoja.
    if (entrada.length > 300) { res.status(400).json({ error: 'Máximo 300 pedidos por vez.' }); return; }
    const ids = entrada.map(p => String(p.im_comprobante_id));

    // 🪤 Si ya está en una hoja, no puede además retirarlo el cliente. Y si la consulta falla,
    // no se marca nada: quedaría en la hoja Y en retiros, o sea cargado en el camión y retirado.
    const { data: enHoja, error: errHoja } = await sb().from('hojas_ruta_pedidos')
      .select('im_comprobante_id, im_numero, hoja_id').in('im_comprobante_id', ids);
    if (errHoja) { res.status(502).json({ error: `No pude verificar si ya están en una hoja: ${errHoja.message}` }); return; }
    if ((enHoja ?? []).length) {
      res.status(409).json({
        error: `Estos pedidos ya están en una hoja de ruta: ${(enHoja ?? []).map((h: any) => h.im_numero ?? h.im_comprobante_id).join(', ')}. Sacalos de la hoja primero.`,
      });
      return;
    }

    // Lo emitido viaja con el pedido: es el comprobante que se lleva el cliente.
    const { data: emitidos } = await sb().from('presupuestos_facturados')
      .select('im_comprobante_id, im_factura_id, im_factura_numero, im_remito_id, im_remito_numero')
      .eq('tenant_id', TENANT_ID).in('im_comprobante_id', ids);
    const facturado = new Map((emitidos ?? []).map((e: any) => [String(e.im_comprobante_id), e]));

    const filas = entrada.map((p) => {
      const e = facturado.get(String(p.im_comprobante_id));
      return {
        tenant_id: TENANT_ID,
        im_comprobante_id: String(p.im_comprobante_id),
        im_numero: p.im_numero != null ? Number(p.im_numero) : null,
        cod_cliente: Number(p.cod_cliente),
        cliente_nombre: p.cliente_nombre ? String(p.cliente_nombre) : null,
        fecha: /^\d{4}-\d{2}-\d{2}/.test(String(p.fecha ?? '')) ? String(p.fecha).slice(0, 10) : fechaArgentina(),
        total: Number(p.total) || 0,
        bultos: p.bultos != null ? Number(p.bultos) : null,
        kg: p.kg != null ? Number(p.kg) : null,
        im_factura_id: e?.im_factura_id ?? null,
        im_factura_numero: e?.im_factura_numero ?? null,
        im_remito_id: e?.im_remito_id ?? null,
        im_remito_numero: e?.im_remito_numero ?? null,
        created_by: req.user?.sub ?? null,
      };
    });

    const { error } = await sb().from('retiros_sucursal').upsert(filas, { onConflict: 'tenant_id,im_comprobante_id' });
    if (error) { res.status(500).json({ error: error.message }); return; }
    invalidarVista();
    res.json({ ok: true, agregados: filas.length, sin_facturar: filas.filter(f => !f.im_remito_numero).length });
  } catch (err: any) {
    console.error('[marcarRetiro]', err?.message);
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/**
 * DELETE /api/retiros/:comprobanteId — lo saca de retiros y vuelve a estar libre.
 *
 * 🪤 Si el cliente YA se lo llevó, no se borra: el registro del mes tiene que reflejar lo que
 * pasó. Para eso está `retirado_at`.
 */
export async function quitarRetiro(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  const id = String(req.params.comprobanteId);
  const { data: fila } = await sb().from('retiros_sucursal')
    .select('retirado_at, im_numero').eq('im_comprobante_id', id).eq('tenant_id', TENANT_ID).maybeSingle();
  if ((fila as any)?.retirado_at) {
    res.status(409).json({ error: `El cliente ya retiró este pedido (${(fila as any).im_numero ?? id}). No se puede borrar del registro del mes.` });
    return;
  }
  const { error } = await sb().from('retiros_sucursal')
    .delete().eq('im_comprobante_id', id).eq('tenant_id', TENANT_ID);
  if (error) { res.status(500).json({ error: error.message }); return; }
  invalidarVista();
  res.json({ ok: true });
}

/** PUT /api/retiros/:comprobanteId — el cliente pasó a buscarlo (o se deshace la marca). */
export async function marcarRetirado(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  const retirado = req.body?.retirado !== false;
  const { data, error } = await sb().from('retiros_sucursal')
    .update({ retirado_at: retirado ? new Date().toISOString() : null })
    .eq('im_comprobante_id', String(req.params.comprobanteId)).eq('tenant_id', TENANT_ID)
    .select().maybeSingle();
  if (error) { res.status(500).json({ error: error.message }); return; }
  if (!data) { res.status(404).json({ error: 'Ese pedido no está en retiros.' }); return; }
  res.json({ ok: true, retiro: data });
}

/** GET /api/retiros?desde=&hasta= — los retiros del rango, con sus totales. */
export async function listarRetiros(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  try {
    const ok = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : null;
    const hasta = ok(req.query.hasta) ?? fechaArgentina();
    const desde = ok(req.query.desde) ?? hasta;
    const { data, error } = await sb().from('retiros_sucursal')
      .select('*').eq('tenant_id', TENANT_ID).gte('fecha', desde).lte('fecha', hasta).order('fecha', { ascending: false });
    if (error) { res.status(500).json({ error: error.message }); return; }
    const filas = data ?? [];
    res.json({
      ok: true, desde, hasta, retiros: filas,
      totales: {
        pedidos: filas.length,
        pendientes: filas.filter((r: any) => !r.retirado_at).length,
        clientes: new Set(filas.map((r: any) => Number(r.cod_cliente))).size,
        importe: redondear(filas.reduce((s: number, r: any) => s + Number(r.total ?? 0), 0)),
        kg: redondear(filas.reduce((s: number, r: any) => s + Number(r.kg ?? 0), 0)),
        bultos: redondear(filas.reduce((s: number, r: any) => s + Number(r.bultos ?? 0), 0)),
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

const redondear = (n: number) => Math.round(n * 100) / 100;

/**
 * GET /api/retiros/resumen?mes=YYYY-MM — el acumulado del mes, que es para lo que se guarda.
 *
 * Mati pidió ver *"cantidad, kilos, importe, por cliente"*: sale el total del mes y el detalle
 * por cliente ordenado por importe, que es donde se ve quién retira siempre.
 */
export async function resumenRetiros(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  try {
    const mes = /^\d{4}-\d{2}$/.test(String(req.query.mes ?? '')) ? String(req.query.mes) : fechaArgentina().slice(0, 7);
    const desde = `${mes}-01`;
    // El último día del mes, sin depender de la zona horaria: día 0 del mes siguiente.
    const [a, m] = mes.split('-').map(Number);
    const hasta = `${mes}-${String(new Date(Date.UTC(a, m, 0)).getUTCDate()).padStart(2, '0')}`;

    const { data, error } = await sb().from('retiros_sucursal')
      .select('*').eq('tenant_id', TENANT_ID).gte('fecha', desde).lte('fecha', hasta);
    if (error) { res.status(500).json({ error: error.message }); return; }
    const filas = data ?? [];

    const porCliente = new Map<number, any>();
    for (const r of filas as any[]) {
      const k = Number(r.cod_cliente);
      if (!porCliente.has(k)) {
        porCliente.set(k, { cod_cliente: k, cliente_nombre: r.cliente_nombre, pedidos: 0, importe: 0, kg: 0, bultos: 0 });
      }
      const c = porCliente.get(k);
      c.pedidos += 1;
      c.importe += Number(r.total ?? 0);
      c.kg += Number(r.kg ?? 0);
      c.bultos += Number(r.bultos ?? 0);
    }
    const clientes = [...porCliente.values()]
      .map(c => ({ ...c, importe: redondear(c.importe), kg: redondear(c.kg), bultos: redondear(c.bultos) }))
      .sort((x, y) => y.importe - x.importe);

    res.json({
      ok: true, mes, desde, hasta,
      totales: {
        pedidos: filas.length,
        clientes: clientes.length,
        importe: redondear(clientes.reduce((s, c) => s + c.importe, 0)),
        kg: redondear(clientes.reduce((s, c) => s + c.kg, 0)),
        bultos: redondear(clientes.reduce((s, c) => s + c.bultos, 0)),
        // Los que todavía no pasaron a buscarlo: mercadería preparada ocupando lugar.
        sin_retirar: filas.filter((r: any) => !r.retirado_at).length,
      },
      clientes,
    });
  } catch (err: any) {
    console.error('[resumenRetiros]', err?.message);
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}
