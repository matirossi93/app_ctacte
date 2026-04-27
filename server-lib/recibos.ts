import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { sb, TENANT_ID } from './supabase.js';
import { ocrRecibo } from './ocrRecibo.js';
import { crearRecibo, fetchComprobPendientes, type ReciboPago, type ReciboComprobante } from './infomanager.js';
import { getFormaPagoIM } from './mediosPago.js';
import { resolveCuentaCod, debugCuentasResolver, invalidateCuentasCache } from './cuentasResolver.js';
import { buscarPagoEnMP, todayISO_AR, type MPMatch, type MPCuenta } from './mercadopago.js';
import type { JwtPayload } from './auth.js';

const { env } = process;
const IM_USUARIO = env.INFOMANAGER_USUARIO || 'matias';
const IM_CENTRO_COSTO_DEFAULT = (env.IM_CENTRO_COSTO_DEFAULT || 'S') as 'S' | 'N';
const IM_CUENTA_ANTICIPO_CLIENTES = env.IM_CUENTA_ANTICIPO_CLIENTES || '2124000';

const BUCKET = 'recibos';
const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']);

function extFromMime(mime: string): string {
  switch (mime) {
    case 'image/jpeg': return 'jpg';
    case 'image/png': return 'png';
    case 'image/webp': return 'webp';
    case 'image/heic': return 'heic';
    case 'application/pdf': return 'pdf';
    default: return 'bin';
  }
}

/**
 * POST /api/recibos/upload
 * multipart/form-data: foto (file), cod_cliente, monto?, medio_pago?, observaciones?
 * Requiere JWT (vendedor).
 */
export async function uploadRecibo(req: Request & { user?: JwtPayload; file?: any }, res: Response) {
  try {
    const user = req.user;
    if (!user) { res.status(401).json({ error: 'No autorizado' }); return; }
    if (user.rol === 'vendedor' && user.cod_vendedor == null) {
      res.status(400).json({ error: 'Tu usuario no tiene cod_vendedor asignado. Pedile a Matías que lo setee.' });
      return;
    }

    const file = req.file;
    if (!file) { res.status(400).json({ error: 'Falta la foto del comprobante (campo "foto")' }); return; }
    if (file.size > MAX_BYTES) { res.status(413).json({ error: 'Imagen demasiado grande (>10MB)' }); return; }
    if (!ALLOWED_MIMES.has(file.mimetype)) {
      res.status(415).json({ error: `Tipo no soportado: ${file.mimetype}` });
      return;
    }

    const codCliente = Number(req.body?.cod_cliente);
    if (!codCliente || isNaN(codCliente)) { res.status(400).json({ error: 'cod_cliente inválido' }); return; }
    const codVendedor = user.rol === 'vendedor'
      ? user.cod_vendedor!
      : (Number(req.body?.cod_vendedor) || 0);

    // 1. Subir a Supabase Storage
    const ext = extFromMime(file.mimetype);
    const id = randomUUID();
    const objectPath = `tenant/${TENANT_ID}/vendedor/${codVendedor}/${new Date().getUTCFullYear()}/${String(new Date().getUTCMonth() + 1).padStart(2, '0')}/${id}.${ext}`;

    const { error: upErr } = await sb().storage.from(BUCKET).upload(objectPath, file.buffer, {
      contentType: file.mimetype,
      upsert: false
    });
    if (upErr) { res.status(500).json({ error: `upload storage: ${upErr.message}` }); return; }

    // 2. OCR (async, no bloquea si falla)
    let ocr: any = null;
    let ocrConfidence: number | null = null;
    try {
      if (file.mimetype.startsWith('image/')) {
        const base64 = file.buffer.toString('base64');
        const parsed = await ocrRecibo(base64, file.mimetype);
        ocr = parsed;
        ocrConfidence = parsed.confidence;
      }
    } catch (e: any) {
      console.warn('OCR failed (sigue sin OCR):', e?.message);
    }

    // 3. Insertar en comprobantes_pago
    const montoBody = req.body?.monto ? Number(String(req.body.monto).replace(/\./g, '').replace(',', '.')) : null;
    const monto = montoBody ?? ocr?.monto ?? null;
    if (!monto || monto <= 0) {
      // Se permite crear con monto null si OCR falló — el backoffice completa
      // Pero preferimos al menos uno. Si no hay ninguno, avisamos.
    }

    const row = {
      id,
      tenant_id: TENANT_ID,
      cod_cliente: codCliente,
      cod_vendedor: codVendedor,
      monto: monto ?? 0.01,        // placeholder; se corrige en approval
      fecha_comprobante: req.body?.fecha_comprobante ?? ocr?.fecha ?? null,
      medio_pago: req.body?.medio_pago ?? ocr?.medio_pago ?? null,
      banco_origen: ocr?.banco_origen ?? null,
      referencia: ocr?.referencia ?? null,
      observaciones: req.body?.observaciones ?? null,
      foto_url: objectPath,
      foto_mime: file.mimetype,
      ocr_raw: ocr,
      ocr_confidence: ocrConfidence,
      status: 'pendiente_revision' as const,
      created_by: user.sub,
      created_at: new Date().toISOString()
    };

    const { data, error } = await sb().from('comprobantes_pago').insert(row).select().single();
    if (error) {
      // Rollback storage
      await sb().storage.from(BUCKET).remove([objectPath]).catch(() => {});
      res.status(500).json({ error: `insert comprobantes_pago: ${error.message}` });
      return;
    }

    // MP auto-verify: fire-and-forget si es mercadopago, skip para otros medios
    if (data.medio_pago === 'mercadopago') {
      verificarReciboMP(data.id).catch(err =>
        console.error('[MP] verify async failed', data.id, err?.message ?? err)
      );
    } else if (data.medio_pago) {
      // Marcar skipped inmediato para que el cron no lo levante
      sb().from('comprobantes_pago').update({ mp_status: 'skipped' })
        .eq('id', data.id).then(() => {}, () => {});
    }

    res.json({ ok: true, comprobante: data, ocr });
  } catch (err: any) {
    console.error('uploadRecibo error:', err);
    res.status(500).json({ error: err?.message ?? 'error interno' });
  }
}

/**
 * GET /api/recibos — listar
 * Query: status?, cod_cliente?, cod_vendedor?, limit?=50
 * Vendedor solo ve los suyos. admin/gerente ven todo.
 */
export async function listRecibos(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const user = req.user!;
    let q = sb().from('comprobantes_pago').select('*').eq('tenant_id', TENANT_ID);
    if (user.rol === 'vendedor') q = q.eq('cod_vendedor', user.cod_vendedor ?? -1);
    if (req.query.status) q = q.eq('status', String(req.query.status));
    if (req.query.cod_cliente) q = q.eq('cod_cliente', Number(req.query.cod_cliente));
    if (req.query.cod_vendedor && user.rol !== 'vendedor') q = q.eq('cod_vendedor', Number(req.query.cod_vendedor));
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    q = q.order('created_at', { ascending: false }).limit(limit);
    const { data, error } = await q;
    if (error) { res.status(500).json({ error: error.message }); return; }

    // Generar signed URLs para las fotos (1h)
    const withUrls = await Promise.all((data ?? []).map(async (r: any) => {
      if (!r.foto_url) return r;
      const { data: signed } = await sb().storage.from(BUCKET).createSignedUrl(r.foto_url, 3600);
      return { ...r, foto_signed_url: signed?.signedUrl ?? null };
    }));

    res.json({ ok: true, recibos: withUrls });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/**
 * GET /api/recibos/:id/facturas-candidatas — facturas pendientes del cliente del comprobante
 * Para que backoffice elija a cuál imputar. Auth admin/gerente.
 */
export async function facturasCandidatas(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const user = req.user!;
    if (user.rol !== 'admin' && user.rol !== 'gerente') { res.status(403).json({ error: 'Requiere admin/gerente' }); return; }
    const { data: comp, error } = await sb().from('comprobantes_pago').select('*')
      .eq('id', req.params.id).eq('tenant_id', TENANT_ID).maybeSingle();
    if (error || !comp) { res.status(404).json({ error: 'Comprobante no encontrado' }); return; }

    const codEmpresa = Number(req.query.cod_empresa) || 1;
    const pendientes = await fetchComprobPendientes(codEmpresa, comp.cod_cliente);
    res.json({ ok: true, cod_cliente: comp.cod_cliente, cod_empresa: codEmpresa, facturas: pendientes });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/**
 * POST /api/recibos/:id/aprobar
 * Body: { monto, fecha, medio_pago, cod_empresa, facturas: [{tipo_comprobante, punto_de_venta, numero, importe}], observaciones? }
 * Dispara POST InfoManager /recibo. Si OK, marca imputado y guarda recibo_id.
 * Auth admin/gerente.
 */
export async function aprobarRecibo(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const user = req.user!;
    if (user.rol !== 'admin' && user.rol !== 'gerente') { res.status(403).json({ error: 'Requiere admin/gerente' }); return; }

    const { data: comp, error: fetchErr } = await sb().from('comprobantes_pago').select('*')
      .eq('id', req.params.id).eq('tenant_id', TENANT_ID).maybeSingle();
    if (fetchErr || !comp) { res.status(404).json({ error: 'Comprobante no encontrado' }); return; }
    if (comp.status === 'imputado') { res.status(409).json({ error: 'Ya está imputado' }); return; }

    const body = req.body ?? {};
    const monto = Number(body.monto ?? comp.monto);
    const fecha = String(body.fecha ?? comp.fecha_comprobante ?? new Date().toISOString().slice(0, 10));
    const codEmpresa = Number(body.cod_empresa);
    if (!codEmpresa) { res.status(400).json({ error: 'cod_empresa obligatorio' }); return; }
    const medioPago = String(body.medio_pago ?? comp.medio_pago ?? 'transferencia');
    const centroCosto: 'S' | 'N' = body.centro_costo === 'N' ? 'N' : IM_CENTRO_COSTO_DEFAULT;
    const usuario = String(body.usuario ?? IM_USUARIO);
    const esAnticipo = body.es_anticipo === true;

    // comprobantes: [{id, importe_a_pagar}] — id viene del endpoint comprob_pendientes_clientes.
    // En anticipos no se imputa a facturas → queda vacío, la cuenta de destino es 2124000.
    const comprobantesBody: Array<{ id: string | number; importe_a_pagar: number | string }> =
      esAnticipo ? [] : (Array.isArray(body.comprobantes) ? body.comprobantes : []);
    const comprobantes: ReciboComprobante[] = comprobantesBody
      .filter(c => c && c.id != null && c.importe_a_pagar != null)
      .map(c => ({ id: String(c.id), importe_a_pagar: Number(c.importe_a_pagar).toFixed(2) }));

    // pagos: si el front no envía explícitamente, armo uno solo a partir de medio + monto.
    // En anticipos se fuerza la cuenta 2124000 (Anticipo de clientes), replicando el
    // comportamiento manual actual en InfoManager.
    const pagosBody: Array<Partial<ReciboPago>> = Array.isArray(body.pagos) ? body.pagos : [];
    const cuentaDefault = esAnticipo ? IM_CUENTA_ANTICIPO_CLIENTES : await resolveCuentaCod(medioPago);
    let pagos: ReciboPago[];
    if (pagosBody.length && !esAnticipo) {
      pagos = pagosBody.map(p => ({
        forma_pago: (p.forma_pago ?? getFormaPagoIM(medioPago)) as any,
        importe: Number(p.importe ?? 0).toFixed(2),
        cod_cuenta: String(p.cod_cuenta ?? cuentaDefault ?? '0'),
        cod_unidad_negocio: p.cod_unidad_negocio ?? '',
        tarjeta_numero: p.tarjeta_numero ?? '',
        tarjeta_numero_cupon: p.tarjeta_numero_cupon ?? '',
      }));
    } else {
      pagos = [{
        forma_pago: getFormaPagoIM(medioPago),
        importe: monto.toFixed(2),
        cod_cuenta: cuentaDefault || '0',
        cod_unidad_negocio: '',
        tarjeta_numero: '',
        tarjeta_numero_cupon: '',
      }];
    }

    if (!pagos[0].cod_cuenta || pagos[0].cod_cuenta === '0') {
      const debug = await debugCuentasResolver();
      res.status(400).json({
        error: `cod_cuenta no resuelta para medio "${medioPago}". Revisá /api/cuentas/debug o seteá IM_CUENTA_* como fallback.`,
        resolverStatus: debug[medioPago] ?? null,
      });
      return;
    }
    if (!esAnticipo && !comprobantes.length) {
      res.status(400).json({ error: 'Tenés que seleccionar al menos un comprobante a imputar (o marcá "Es anticipo de cliente")' });
      return;
    }

    const detalleBase = body.observaciones ?? comp.observaciones ?? comp.referencia ?? '';
    const detalleFinal = esAnticipo
      ? `[ANTICIPO] ${detalleBase}`.trim()
      : detalleBase;

    const imRes = await crearRecibo({
      cod_empresa: String(codEmpresa),
      fecha,
      centro_costo: centroCosto,
      cod_cliente: String(comp.cod_cliente),
      usuario,
      detalle: detalleFinal,
      moneda: 'P',
      cotizacion: '1.0',
      pagos,
      comprobantes
    });

    if (!imRes.ok) {
      await sb().from('comprobantes_pago').update({
        status: 'error',
        error_msg: imRes.error,
        infomanager_response: imRes.raw ?? null,
        reviewed_by: user.sub,
        reviewed_at: new Date().toISOString()
      }).eq('id', comp.id);
      res.status(502).json({ ok: false, error: imRes.error, raw: imRes.raw });
      return;
    }

    const now = new Date().toISOString();
    const facturaResumen = esAnticipo
      ? `ANTICIPO cta ${IM_CUENTA_ANTICIPO_CLIENTES} $${monto.toFixed(2)}`
      : comprobantes.length
        ? comprobantes.map(c => `#${c.id}·$${c.importe_a_pagar}`).join(',')
        : null;
    const { error: updErr } = await sb().from('comprobantes_pago').update({
      status: 'imputado',
      monto,
      fecha_comprobante: fecha,
      medio_pago: medioPago,
      cod_empresa: codEmpresa,
      factura_asociada: facturaResumen,
      infomanager_recibo_id: imRes.id ?? null,
      infomanager_response: imRes.raw,
      reviewed_by: user.sub,
      reviewed_at: now,
      imputado_at: now
    }).eq('id', comp.id);
    if (updErr) { res.status(500).json({ error: `update final: ${updErr.message}` }); return; }

    res.json({ ok: true, recibo_id: imRes.id, raw: imRes.raw });
  } catch (err: any) {
    console.error('aprobarRecibo error:', err);
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/**
 * POST /api/recibos/:id/rechazar
 * Body: { motivo }. Auth admin/gerente.
 */
export async function rechazarRecibo(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const user = req.user!;
    if (user.rol !== 'admin' && user.rol !== 'gerente') { res.status(403).json({ error: 'Requiere admin/gerente' }); return; }
    const motivo = String(req.body?.motivo ?? '').trim();
    if (!motivo) { res.status(400).json({ error: 'motivo obligatorio' }); return; }
    const { error } = await sb().from('comprobantes_pago').update({
      status: 'rechazado',
      motivo_rechazo: motivo,
      reviewed_by: user.sub,
      reviewed_at: new Date().toISOString()
    }).eq('id', req.params.id).eq('tenant_id', TENANT_ID);
    if (error) { res.status(500).json({ error: error.message }); return; }
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/**
 * GET /api/cuentas/debug — admin-only. Muestra el mapping medio→cod_cuenta
 * resuelto desde /planes de InfoManager, con fallback a env vars.
 */
export async function cuentasDebug(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const user = req.user!;
    if (user.rol !== 'admin' && user.rol !== 'gerente') { res.status(403).json({ error: 'Requiere admin/gerente' }); return; }
    const mapping = await debugCuentasResolver();
    res.json({ ok: true, mapping });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/**
 * POST /api/cuentas/refresh — admin-only. Fuerza re-consulta a /planes.
 */
export async function cuentasRefresh(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const user = req.user!;
    if (user.rol !== 'admin' && user.rol !== 'gerente') { res.status(403).json({ error: 'Requiere admin/gerente' }); return; }
    invalidateCuentasCache();
    const mapping = await debugCuentasResolver();
    res.json({ ok: true, mapping });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MP verification — busca el pago en las 3 cuentas MP y actualiza mp_status
// ═══════════════════════════════════════════════════════════════════════════

export async function verificarReciboMP(id: string): Promise<{ status: string; matches: number }> {
  const { data: comp, error } = await sb().from('comprobantes_pago')
    .select('id, monto, fecha_comprobante, medio_pago, mp_lookup_attempts')
    .eq('id', id).eq('tenant_id', TENANT_ID).maybeSingle();
  if (error || !comp) throw new Error('comprobante no encontrado');
  if (comp.medio_pago !== 'mercadopago') {
    await sb().from('comprobantes_pago').update({ mp_status: 'skipped' }).eq('id', id);
    return { status: 'skipped', matches: 0 };
  }

  const monto = Number(comp.monto);
  const desdeISO = comp.fecha_comprobante || todayISO_AR();
  const hastaISO = todayISO_AR();
  const nowIso = new Date().toISOString();

  let matches: MPMatch[] = [];
  let errored = false;
  try {
    matches = await buscarPagoEnMP({ monto, desdeISO, hastaISO });
  } catch (e: any) {
    console.warn(`[MP] buscarPagoEnMP threw id=${id} err=${e?.message}`);
    errored = true;
  }

  const baseUpdate: any = {
    mp_lookup_attempts: (comp.mp_lookup_attempts ?? 0) + 1,
    mp_last_lookup_at: nowIso,
  };

  if (errored) {
    await sb().from('comprobantes_pago').update({ ...baseUpdate, mp_status: 'error' }).eq('id', id);
    return { status: 'error', matches: 0 };
  }

  if (matches.length === 1) {
    const m = matches[0];
    await sb().from('comprobantes_pago').update({
      ...baseUpdate,
      mp_status: 'verified',
      mp_payment_id: m.payment_id,
      mp_cuenta: m.cuenta,
      mp_verified_at: nowIso,
      mp_candidates: matches,
    }).eq('id', id);
    console.log(`[MP] verified id=${id} payment=${m.payment_id} cuenta=${m.cuenta}`);
    return { status: 'verified', matches: 1 };
  }

  if (matches.length >= 2) {
    await sb().from('comprobantes_pago').update({
      ...baseUpdate,
      mp_status: 'ambiguous',
      mp_candidates: matches,
    }).eq('id', id);
    console.log(`[MP] ambiguous id=${id} candidates=${matches.length}`);
    return { status: 'ambiguous', matches: matches.length };
  }

  await sb().from('comprobantes_pago').update({
    ...baseUpdate,
    mp_status: 'not_found',
  }).eq('id', id);
  return { status: 'not_found', matches: 0 };
}

/**
 * Proceso batch: levanta comprobantes MP pendientes/errados dentro de ventana 24h
 * y los reverifica. Llamado desde cron every 5min.
 */
export async function procesarColaMP(limit: number = 20): Promise<{ procesados: number; verificados: number; ambiguos: number }> {
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data, error } = await sb().from('comprobantes_pago')
    .select('id')
    .eq('tenant_id', TENANT_ID)
    .eq('medio_pago', 'mercadopago')
    .in('mp_status', ['pending', 'not_found', 'ambiguous', 'error'])
    .gte('created_at', cutoff)
    .lt('mp_lookup_attempts', 50)
    .order('mp_last_lookup_at', { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) { console.error('[MP] procesarColaMP select', error.message); return { procesados: 0, verificados: 0, ambiguos: 0 }; }
  let verificados = 0, ambiguos = 0;
  for (const row of data ?? []) {
    try {
      const r = await verificarReciboMP(row.id);
      if (r.status === 'verified') verificados++;
      if (r.status === 'ambiguous') ambiguos++;
    } catch (e: any) {
      console.warn(`[MP] cola fail id=${row.id} err=${e?.message}`);
    }
  }
  return { procesados: (data ?? []).length, verificados, ambiguos };
}

/**
 * POST /api/recibos/:id/reverificar-mp — fuerza lookup ad-hoc (admin/gerente)
 */
export async function reverificarMP(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const user = req.user!;
    if (user.rol !== 'admin' && user.rol !== 'gerente') { res.status(403).json({ error: 'Requiere admin/gerente' }); return; }
    const id = String(req.params.id);
    const result = await verificarReciboMP(id);
    const { data } = await sb().from('comprobantes_pago').select('*').eq('id', id).maybeSingle();
    res.json({ ok: true, result, comprobante: data });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/**
 * POST /api/recibos/:id/elegir-match — resuelve ambigüedad (admin/gerente)
 * Body: { payment_id, cuenta }
 */
export async function elegirMatchMP(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const user = req.user!;
    if (user.rol !== 'admin' && user.rol !== 'gerente') { res.status(403).json({ error: 'Requiere admin/gerente' }); return; }
    const id = String(req.params.id);
    const { payment_id, cuenta } = req.body ?? {};
    if (!payment_id || !cuenta) { res.status(400).json({ error: 'Faltan payment_id y cuenta' }); return; }
    if (!['principal', 'recaudadora_1', 'recaudadora_2'].includes(cuenta)) {
      res.status(400).json({ error: `cuenta invalida: ${cuenta}` }); return;
    }

    const { data: comp } = await sb().from('comprobantes_pago')
      .select('mp_candidates').eq('id', id).eq('tenant_id', TENANT_ID).maybeSingle();
    if (!comp) { res.status(404).json({ error: 'Comprobante no encontrado' }); return; }
    const candidates: MPMatch[] = comp.mp_candidates ?? [];
    const match = candidates.find(c => c.payment_id === String(payment_id) && c.cuenta === cuenta);
    if (!match) { res.status(400).json({ error: 'El payment_id/cuenta no esta en los candidatos del comprobante' }); return; }

    await sb().from('comprobantes_pago').update({
      mp_status: 'verified',
      mp_payment_id: match.payment_id,
      mp_cuenta: match.cuenta as MPCuenta,
      mp_verified_at: new Date().toISOString(),
    }).eq('id', id);

    const { data } = await sb().from('comprobantes_pago').select('*').eq('id', id).maybeSingle();
    res.json({ ok: true, comprobante: data });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}
