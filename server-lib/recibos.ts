import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import type { Request, Response } from 'express';
import { sb, TENANT_ID } from './supabase.js';
import { ocrRecibo } from './ocrRecibo.js';
import { crearRecibo, fetchComprobPendientes, fetchClientesIMCached, type ReciboPago, type ReciboComprobante } from './infomanager.js';
import { getFormaPagoIM, isValidMedio } from './mediosPago.js';
import { resolveCuentaCod, debugCuentasResolver, invalidateCuentasCache } from './cuentasResolver.js';
import { buscarPagoEnMP, todayISO_AR, mpConfigStatus, type MPMatch, type MPCuenta } from './mercadopago.js';
import { ajustarImputacionIM } from './recibosImputacion.js';
import type { JwtPayload } from './auth.js';

const { env } = process;
const IM_USUARIO = env.INFOMANAGER_USUARIO || '';
if (!IM_USUARIO) {
  console.error('FATAL: INFOMANAGER_USUARIO no está definida en el entorno. Abortando.');
  process.exit(1);
}
const IM_CENTRO_COSTO_DEFAULT = (env.IM_CENTRO_COSTO_DEFAULT || 'S') as 'S' | 'N';
const IM_CUENTA_ANTICIPO_CLIENTES = env.IM_CUENTA_ANTICIPO_CLIENTES || '2124000';
// Feature flag: agregar fec_emision/fec_pago a cada pago del recibo. Estos
// campos NO están en el swagger oficial pero IM la grilla los muestra como
// "Fec. Em." y "Fec. Pago". Probamos empíricamente si IM los acepta. Si
// rechaza con 400 por additionalProperties, apagar esta var.
const IM_RECIBO_FECHAS_PAGO = String(env.IM_RECIBO_FECHAS_PAGO || '').toLowerCase() === 'true';

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

// Cache en memoria de signed URLs para evitar pegarle a Supabase Storage en cada
// listRecibos. Cada signed URL dura 1h; cacheamos hasta 50min antes de regenerar.
const SIGNED_URL_TTL_SEC = 3600;
const SIGNED_URL_REFRESH_BEFORE_MS = 10 * 60 * 1000; // refresh 10min antes de expirar
const signedUrlCache = new Map<string, { url: string; expiresAt: number }>();

// Firma N URLs en una sola llamada batch a Supabase Storage. Antes hacíamos un
// Promise.all con N round-trips secuenciales — para listas de 30-50 recibos eso
// era 1-2s solo en signing, sobre todo post-deploy cuando el cache estaba frío.
// createSignedUrls (plural) firma todo el batch en una sola request.
async function getSignedUrlsCached(paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const now = Date.now();
  const toSign: string[] = [];
  for (const p of paths) {
    if (!p) continue;
    const cached = signedUrlCache.get(p);
    if (cached && cached.expiresAt - SIGNED_URL_REFRESH_BEFORE_MS > now) {
      out.set(p, cached.url);
    } else {
      toSign.push(p);
    }
  }
  if (toSign.length === 0) return out;
  const { data: signed } = await sb().storage.from(BUCKET).createSignedUrls(toSign, SIGNED_URL_TTL_SEC);
  if (!signed) return out;
  const expiresAt = Date.now() + SIGNED_URL_TTL_SEC * 1000;
  for (const item of signed) {
    if (item.path && item.signedUrl) {
      signedUrlCache.set(item.path, { url: item.signedUrl, expiresAt });
      out.set(item.path, item.signedUrl);
    }
  }
  return out;
}

async function getSignedUrlCached(path: string): Promise<string | null> {
  const map = await getSignedUrlsCached([path]);
  return map.get(path) ?? null;
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
    let codVendedor: number;
    if (user.rol === 'vendedor') {
      codVendedor = user.cod_vendedor!;
    } else if (user.rol === 'repartidor') {
      // El repartidor no tiene cod_vendedor propio. Derivamos el del cliente
      // para que el comprobante también le aparezca al vendedor que lo atiende.
      // Fuente primaria: InfoManager (incluye clientes nuevos del mes que aún
      // no están en el maestro de Supabase). Fallback: client_operational.
      // Si no se resuelve, queda en 0 (visible solo para backoffice y
      // repartidores, que ven la lista completa).
      codVendedor = 0;
      try {
        const imClientes = await fetchClientesIMCached();
        const hit = imClientes.find((c) => Number(c.cod_cliente) === codCliente);
        if (hit?.cod_vendedor != null) codVendedor = Number(hit.cod_vendedor);
      } catch (e: any) {
        console.warn('[uploadRecibo] IM clientes fallo, fallback Supabase:', e?.message);
      }
      if (!codVendedor) {
        const { data: cliOp } = await sb().from('client_operational')
          .select('cod_vendedor')
          .eq('tenant_id', TENANT_ID)
          .eq('cod_cliente', codCliente)
          .maybeSingle();
        codVendedor = cliOp?.cod_vendedor ?? 0;
      }
    } else {
      codVendedor = Number(req.body?.cod_vendedor) || 0;
    }

    // 1. Subir a Supabase Storage
    const ext = extFromMime(file.mimetype);
    const id = randomUUID();
    const objectPath = `tenant/${TENANT_ID}/vendedor/${codVendedor}/${new Date().getUTCFullYear()}/${String(new Date().getUTCMonth() + 1).padStart(2, '0')}/${id}.${ext}`;

    // Multer ahora usa diskStorage: el archivo está en file.path, no en file.buffer.
    // Lo leemos una vez y lo reutilizamos para storage upload + OCR.
    const fileBuffer = await fsp.readFile(file.path);

    const { error: upErr } = await sb().storage.from(BUCKET).upload(objectPath, fileBuffer, {
      contentType: file.mimetype,
      upsert: false
    });
    if (upErr) { res.status(500).json({ error: `upload storage: ${upErr.message}` }); return; }

    // 2. OCR (async, no bloquea si falla)
    let ocr: any = null;
    let ocrConfidence: number | null = null;
    try {
      if (file.mimetype.startsWith('image/')) {
        const base64 = fileBuffer.toString('base64');
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

// Columnas mínimas que necesita la UI para renderizar una fila en la lista.
// Excluimos JSONs grandes (ocr_raw, mp_candidates, infomanager_response) que solo
// se consumen en el detalle y agregaban cientos de KB al payload sin uso visible.
const LIST_COLUMNS = 'id,cod_cliente,cod_vendedor,monto,fecha_comprobante,medio_pago,status,foto_url,ocr_confidence,created_at';

/**
 * Caduca recibos que quedaron en 'pendiente_revision' demasiado tiempo (default
 * 30 días): los pasa a 'error' con un motivo claro [CADUCADO] para que dejen de
 * estar colgados invisiblemente (plata que el cliente pagó pero nunca se imputó)
 * y el admin los reprocese o descarte. Reversible: el recibo sigue en la tabla,
 * solo cambia de estado. Pensado para correr por cron una vez al día.
 */
export async function caducarRecibosPendientes(diasMax = 30): Promise<{ caducados: number; ids: string[] }> {
  const corte = new Date(Date.now() - diasMax * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await sb().from('comprobantes_pago')
    .update({ status: 'error', error_msg: `[CADUCADO] Más de ${diasMax} días en pendiente_revisión sin imputar — revisar y reprocesar o descartar.` })
    .eq('tenant_id', TENANT_ID)
    .eq('status', 'pendiente_revision')
    .lt('created_at', corte)
    .select('id');
  if (error) { console.warn(`[caducar recibos] error: ${error.message}`); return { caducados: 0, ids: [] }; }
  const ids = (data ?? []).map((r: any) => String(r.id));
  if (ids.length) console.log(`[caducar recibos] ${ids.length} recibo(s) en pendiente_revision >${diasMax}d marcados como error: ${ids.join(', ')}`);
  return { caducados: ids.length, ids };
}

/**
 * GET /api/recibos/mp-config — estado de configuración de MercadoPago (admin).
 * Le permite al backoffice ver si la verificación automática está activa y
 * qué cuentas tienen token válido, en vez de descubrirlo por prueba y error.
 */
export async function mpConfig(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const user = req.user!;
    if (user.rol !== 'admin' && user.rol !== 'gerente') { res.status(403).json({ error: 'Requiere admin/gerente' }); return; }
    const force = req.query.force === '1';
    const cuentas = await mpConfigStatus(force);
    const activas = cuentas.filter(c => c.valid === true).length;
    res.json({ ok: true, activas, total: cuentas.length, cuentas });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
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
    let q = sb().from('comprobantes_pago').select(LIST_COLUMNS).eq('tenant_id', TENANT_ID);
    if (user.rol === 'vendedor') q = q.eq('cod_vendedor', user.cod_vendedor ?? -1);
    if (req.query.status) q = q.eq('status', String(req.query.status));
    if (req.query.cod_cliente) q = q.eq('cod_cliente', Number(req.query.cod_cliente));
    if (req.query.cod_vendedor && user.rol !== 'vendedor') q = q.eq('cod_vendedor', Number(req.query.cod_vendedor));
    // Default 200 (max). Antes era 30 y los recibos más viejos del mes
    // desaparecían cuando se acumulaban nuevos. 200 cubre 1-2 meses de
    // carga típica del equipo; si en el futuro hay más, agregar paginación
    // o filtro por rango de fecha.
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    q = q.order('created_at', { ascending: false }).limit(limit);
    const { data, error } = await q;
    if (error) { res.status(500).json({ error: error.message }); return; }

    const rows = data ?? [];
    const paths = rows.map((r: any) => r.foto_url).filter(Boolean);
    const urlMap = await getSignedUrlsCached(paths);
    const withUrls = rows.map((r: any) => ({
      ...r,
      foto_signed_url: r.foto_url ? (urlMap.get(r.foto_url) ?? null) : null,
    }));

    res.json({ ok: true, recibos: withUrls });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/**
 * GET /api/recibos/:id — detalle completo de UN recibo (con todos los JSONs).
 * Antes el frontend pedía toda la lista (limit=200) para encontrar uno solo,
 * lo que duplicaba el costo cada vez que se abría un detalle.
 * Vendedor solo ve los suyos; admin/gerente ven cualquiera.
 */
export async function getReciboById(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const user = req.user!;
    let q = sb().from('comprobantes_pago').select('*')
      .eq('id', req.params.id).eq('tenant_id', TENANT_ID);
    if (user.rol === 'vendedor') q = q.eq('cod_vendedor', user.cod_vendedor ?? -1);
    const { data, error } = await q.maybeSingle();
    if (error) { res.status(500).json({ error: error.message }); return; }
    if (!data) { res.status(404).json({ error: 'Comprobante no encontrado' }); return; }
    const foto_signed_url = data.foto_url ? await getSignedUrlCached(data.foto_url) : null;
    res.json({ ok: true, recibo: { ...data, foto_signed_url } });
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
    // Fecha del comprobante REAL — la que graba IM. No caer a new Date()
    // porque eso quedaba como "fecha del día de aprobación" en IM en vez de
    // la fecha del comprobante. Si no llega ni del body ni de la BD, error.
    const fechaRaw = body.fecha ?? comp.fecha_comprobante ?? null;
    const fecha = fechaRaw ? String(fechaRaw).trim() : '';
    if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      res.status(400).json({ error: 'Falta la fecha del comprobante (YYYY-MM-DD). Cargala en el modal antes de aprobar.' });
      return;
    }
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
    let detalleFinal = esAnticipo
      ? `[ANTICIPO] ${detalleBase}`.trim()
      : detalleBase;

    // IM trunca silenciosamente `comprobantes.importe_a_pagar` a entero y exige
    // que la suma de pagos == suma de comprobantes (si no, rechaza el recibo).
    // La lógica pura del ajuste vive en ./recibosImputacion.ts (testeada).
    if (!esAnticipo && comprobantes.length > 0) {
      const sumPagosOrig = pagos.reduce((a, p) => a + Number(p.importe), 0);
      const ajuste = ajustarImputacionIM(sumPagosOrig, comprobantes.map(c => Number(c.importe_a_pagar)));
      if (!ajuste.ok) { res.status(400).json({ error: ajuste.error }); return; }
      // Aplicar los enteros truncados a cada comprobante e igualar el pago total.
      comprobantes.forEach((c, i) => { c.importe_a_pagar = ajuste.comprobantesEnteros[i].toFixed(2); });
      const pagoOrig = pagos[0].importe;
      pagos[0].importe = ajuste.pagoTotal.toFixed(2);
      if (Math.abs(ajuste.ajusteTotal) > 0.01) {
        console.log(`[aprobar] redondeo IM: pagos[0] $${pagoOrig} -> $${pagos[0].importe}, comprobantes truncados a entero (ajuste total $${ajuste.ajusteTotal.toFixed(2)})`);
        detalleFinal = `${detalleFinal} [auto-ajuste $${ajuste.ajusteTotal.toFixed(2)}]`.trim();
      }
    }

    // Inyectar fec_emision/fec_pago en cada pago si está activado el flag.
    // IM por default pone hoy en las columnas "Fec. Em." y "Fec. Pago".
    // Verificado 12/05/2026: IM acepta estos campos en el POST sin error
    // pero los ignora silenciosamente (la grilla sigue mostrando hoy).
    // Dejamos los 2 nombres más estándar por si el proveedor IM agrega
    // soporte oficial usando esos nombres — los otros 8 que probamos
    // (fecha_emision, fec_em, etc) fueron descartados.
    // Ver mail al proveedor en c:/tmp/mail_soporte_infomanager.md.
    if (IM_RECIBO_FECHAS_PAGO) {
      pagos.forEach(p => {
        p.fec_emision = fecha;
        p.fec_pago = fecha;
      });
    }

    console.log('[aprobar] payload IM:', JSON.stringify({
      cod_empresa: String(codEmpresa),
      cod_cliente: String(comp.cod_cliente),
      fecha,
      fecha_origen: body.fecha ? 'body' : (comp.fecha_comprobante ? 'comp' : 'fallback'),
      fecha_comp_bd: comp.fecha_comprobante,
      fecha_body: body.fecha,
      fechas_pago_extra: IM_RECIBO_FECHAS_PAGO,
      centro_costo: centroCosto,
      usuario,
      pagos,  // objeto completo: incluye todas las variantes de fecha cuando IM_RECIBO_FECHAS_PAGO=true
      comprobantes
    }));

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

    // Si IM devolvió una fecha distinta a la que enviamos, lo logueamos para
    // detectar el bug "IM ignora el campo fecha y usa la del servidor".
    if (imRes.ok && imRes.raw) {
      const fechaIM = imRes.raw?.fecha ?? imRes.raw?.fecha_recibo ?? null;
      if (fechaIM && String(fechaIM).slice(0, 10) !== fecha) {
        console.warn(`[aprobar] ⚠️ IM grabó fecha distinta: enviada=${fecha} recibida=${fechaIM} (recibo IM ${imRes.id ?? '?'})`);
      }
    }

    if (!imRes.ok) {
      console.error('[aprobar] IM rechazo:', imRes.error, '| raw:', JSON.stringify(imRes.raw));
      // Enriquecer error_msg con detalles del raw IM. IM puede devolver `detalles`
      // o `errores` (array {campo, mensajes}) según el endpoint — mostramos ambos.
      const errorIM = imRes.raw?.errores
        ? ` | ${imRes.raw.errores.map((e: any) => `${e.campo}: ${(e.mensajes || []).join(', ')}`).join(' · ')}`
        : (imRes.raw?.detalles ? ` | detalles: ${JSON.stringify(imRes.raw.detalles).slice(0, 300)}` : '');
      const mensajeIM = imRes.raw?.mensaje ? ` (${imRes.raw.mensaje})` : '';
      const errorMsg = `IM rechazó el recibo${mensajeIM}${errorIM}`;
      await sb().from('comprobantes_pago').update({
        status: 'error',
        error_msg: errorMsg,
        infomanager_response: imRes.raw ?? null,
        reviewed_by: user.sub,
        reviewed_at: new Date().toISOString()
      }).eq('id', comp.id);
      // status 400 (no 502) para que Traefik/EasyPanel NO intercepte la respuesta
      // como "Bad Gateway" y muestre su HTML default — antes el frontend
      // recibía HTML en vez del JSON con el mensaje real de IM.
      res.status(400).json({ ok: false, error: errorMsg, raw: imRes.raw });
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
 * POST /api/recibos/:id/editar — edición de un recibo ya cargado (admin/gerente).
 *
 * Permite corregir los datos de un comprobante en CUALQUIER estado, incluido
 * 'imputado'. Campos editables: cod_cliente, monto, fecha_comprobante,
 * medio_pago, banco_origen, referencia, observaciones.
 *
 * ⚠️ Si el recibo ya está 'imputado', esta edición solo cambia el registro de
 * ESTA app — el recibo emitido en InfoManager NO se modifica (IM no expone API
 * de edición). Sirve para corregir/anotar el comprobante local.
 *
 * Body opcional `reabrir: true` — solo para recibos 'rechazado'/'error': los
 * vuelve a 'pendiente_revision' para reprocesarlos (limpia motivo/error).
 */
const CAMPOS_EDITABLES_TEXTO = ['banco_origen', 'referencia', 'observaciones'] as const;

export async function editarRecibo(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const user = req.user!;
    if (user.rol !== 'admin' && user.rol !== 'gerente') { res.status(403).json({ error: 'Requiere admin/gerente' }); return; }

    const { data: comp, error: fErr } = await sb().from('comprobantes_pago').select('*')
      .eq('id', req.params.id).eq('tenant_id', TENANT_ID).maybeSingle();
    if (fErr) { res.status(500).json({ error: fErr.message }); return; }
    if (!comp) { res.status(404).json({ error: 'Comprobante no encontrado' }); return; }

    const body = req.body ?? {};
    const update: Record<string, any> = {};

    if (body.cod_cliente !== undefined) {
      const n = Number(body.cod_cliente);
      if (!Number.isFinite(n) || n <= 0) { res.status(400).json({ error: 'cod_cliente inválido' }); return; }
      update.cod_cliente = n;
    }
    if (body.monto !== undefined) {
      const m = Number(body.monto);
      if (!Number.isFinite(m) || m <= 0) { res.status(400).json({ error: 'monto debe ser mayor a 0' }); return; }
      update.monto = m;
    }
    if (body.fecha_comprobante !== undefined) {
      const f = body.fecha_comprobante ? String(body.fecha_comprobante).trim() : null;
      if (f && !/^\d{4}-\d{2}-\d{2}$/.test(f)) { res.status(400).json({ error: 'fecha_comprobante debe ser YYYY-MM-DD' }); return; }
      update.fecha_comprobante = f;
    }
    if (body.medio_pago !== undefined) {
      const mp = body.medio_pago ? String(body.medio_pago) : null;
      if (mp && !isValidMedio(mp)) { res.status(400).json({ error: `medio_pago inválido: ${mp}` }); return; }
      update.medio_pago = mp;
    }
    for (const campo of CAMPOS_EDITABLES_TEXTO) {
      if (body[campo] !== undefined) {
        const v = body[campo];
        update[campo] = v == null || v === '' ? null : String(v);
      }
    }

    // Reapertura: rechazado/error → pendiente_revision para reprocesar.
    if (body.reabrir === true) {
      if (comp.status !== 'rechazado' && comp.status !== 'error') {
        res.status(400).json({ error: `Solo se puede reabrir un recibo rechazado o con error (estado actual: ${comp.status})` });
        return;
      }
      update.status = 'pendiente_revision';
      update.motivo_rechazo = null;
      update.error_msg = null;
    }

    if (Object.keys(update).length === 0) { res.status(400).json({ error: 'No hay nada para actualizar' }); return; }

    update.reviewed_by = user.sub;
    update.reviewed_at = new Date().toISOString();

    const { data, error } = await sb().from('comprobantes_pago').update(update)
      .eq('id', comp.id).eq('tenant_id', TENANT_ID).select().single();
    if (error) { res.status(500).json({ error: `update: ${error.message}` }); return; }

    console.log(`[editarRecibo] ${comp.id} editado por ${user.sub} · campos=${Object.keys(update).join(',')}`);
    const foto_signed_url = data.foto_url ? await getSignedUrlCached(data.foto_url) : null;
    res.json({ ok: true, recibo: { ...data, foto_signed_url } });
  } catch (err: any) {
    console.error('editarRecibo error:', err);
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
