import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import pkg from 'papaparse';
const { parse } = pkg;
import axios from 'axios';
import cron from 'node-cron';
import multer from 'multer';
import {
  findUsuarioByEmail, signJwt, verifyJwt, usuarioToJwtPayload,
  hashPassword, verifyPassword,
  requireAdmin,
  type JwtPayload
} from './server-lib/auth.js';
import { hasSupabase, sb, TENANT_ID } from './server-lib/supabase.js';
import { syncVentasMesActual, syncVentasMeses } from './server-lib/syncVentas.js';
import { getMonthlyVentasRaw, getMonthlyItemsRaw, snapshotCacheStats } from './server-lib/snapshotCache.js';
import { fetchArticulosCatalogo, imGetRetry } from './server-lib/infomanager.js';
import {
  uploadRecibo, listRecibos, getReciboById, facturasCandidatas, aprobarRecibo, rechazarRecibo, editarRecibo, cuentasDebug, cuentasRefresh, cuentasEfectivo,
  reverificarMP, elegirMatchMP, procesarColaMP, caducarRecibosPendientes, mpConfig
} from './server-lib/recibos.js';
import { listGoals, setGoal, syncVentasNow, setMonthConfig, listClientesObjetivo, debugClienteAvance, getGoalsSnapshot, botGoals } from './server-lib/goals.js';
import { listComisiones, listComisionesSucursal, probeVenta, comisionesSample, topArticulos, facturasVendedor, diagnoseArticulo } from './server-lib/comisiones.js';
import { listOverrides, addOverride, deleteOverride } from './server-lib/comisionOverrides.js';
import { listClientesLookup } from './server-lib/clientes.js';
import { historialComprasCliente } from './server-lib/historialCompras.js';
import { listActivity, createActivity, updateActivity, deleteActivity, listNotificaciones } from './server-lib/activity.js';
import {
  isWebPushEnabled, getVapidPublicKeyHandler, subscribePush, unsubscribePush, testPush,
  dispararRecordatoriosPromesa, dispatchPushNow,
} from './server-lib/webpush.js';
import {
  listUsuarios, createUsuario, updateUsuario, deleteUsuario, changePassword
} from './server-lib/usuarios.js';
import { importMaestroClientes } from './server-lib/sheetImport.js';
import { descargarReporte } from './server-lib/reportes.js';
import { getConciliacion, exportConciliacion, listSnapshotsConciliacion, guardarSnapshotConciliacion } from './server-lib/conciliacion.js';
import { cruceCarpetaHandler, exportCruceHandler } from './server-lib/cruceCarpeta.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Red de seguridad global: en Node 22 una promesa rechazada sin catch MATA el
// proceso (y el contenedor entra en crash-loop, incidente 06/07). Acá logueamos
// y seguimos: para esta app la disponibilidad pesa más que el riesgo teórico de
// continuar tras un error no manejado. El stack queda en los logs del contenedor.
process.on('unhandledRejection', (reason: any) => {
    console.error('[unhandledRejection]', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err: any) => {
    console.error('[uncaughtException]', err?.stack ?? err);
});

const app = express();
const PORT = process.env.PORT || 80;

// Estamos detrás de Traefik (EasyPanel) que setea X-Forwarded-For. Sin esto,
// express-rate-limit tira un warning y todas las requests parecen venir de la
// IP interna del proxy → el rate limit global queda inútil. trust proxy=1
// confía en el primer proxy (Traefik) sin abrir el riesgo de spoofing.
app.set('trust proxy', 1);

// CORS whitelist por env var. Formato CSV ("https://a.com,https://b.com").
// Default permite localhost para dev. En prod, setear ALLOWED_ORIGINS.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // same-origin / curl / capacitor
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS: origen no permitido — ${origin}`));
  },
  credentials: true,
}));

// Security headers. HSTS solo en prod (en dev sobre HTTP rompería).
const IS_PROD = process.env.NODE_ENV === 'production';
app.use((_req, res, next) => {
  if (IS_PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// gzip JSON responses (reduce ~80% el payload de /api/data y similares).
app.use(compression({ threshold: 1024 }));
app.use(express.json());

// Rate limit global por IP. 600 req/min = 10 req/s sustained, suficiente para
// polling normal (5-10 req/min por usuario) y bot (Amira a /api/bot). Si esta
// cifra empieza a quemar, conviene aumentar y monitorear. Los endpoints de
// login tienen su propio rate-limit más estricto (10 intentos / 15 min).
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiadas requests. Esperá un momento e intentá de nuevo.' },
});
app.use('/api/', apiLimiter);

// ─── SQLite Setup ─────────────────────────────────────────────────────────────
const dbDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}
const db = new DatabaseSync(path.join(dbDir, 'database.sqlite'));

db.exec(`
    CREATE TABLE IF NOT EXISTS invoice_overrides (
        invoice_id TEXT PRIMARY KEY,
        apply_interest INTEGER
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS client_thresholds (
        client_id TEXT PRIMARY KEY,
        days INTEGER NOT NULL
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS auth_tokens (
        token TEXT PRIMARY KEY,
        expiry INTEGER NOT NULL
    )
`);

// Clean up expired tokens on startup and every hour
const cleanExpiredTokens = () => {
    db.prepare('DELETE FROM auth_tokens WHERE expiry < ?').run(Date.now());
};
cleanExpiredTokens();
setInterval(cleanExpiredTokens, 60 * 60 * 1000);

// ─── Data Source Config ───────────────────────────────────────────────────────
const DATA_SOURCE = process.env.DATA_SOURCE || 'infomanager'; // 'infomanager' | 'sheets'

// Google Sheets URLs (fallback)
const INVOICES_URL = process.env.INVOICES_URL ||
    'https://docs.google.com/spreadsheets/d/1UMtdGkn7GTAIAZ8De9nWxYQThM6YruzVf1-W757xYmQ/export?format=csv';
const CLIENTS_URL = process.env.CLIENTS_URL ||
    'https://docs.google.com/spreadsheets/d/1k7B8Phi5QDn_6mFWiAfYBcqqisEWT6nqUwgmhE54Zy8/export?format=csv&gid=2120998313';

// InfoManager API config
const IM_BASE_URL = process.env.INFOMANAGER_BASE_URL || 'https://impedidos.infomanager.com.ar/api/v1';
const IM_CLIENT_ID = process.env.INFOMANAGER_CLIENT_ID || 'ck_elmanantialsrl_base';
// El fallback hardcoded ya se eliminó (también enforced en server-lib/infomanager.ts).
// Si llegamos acá sin la env, el módulo infomanager.ts ya habría abortado el proceso.
const IM_CLIENT_SECRET = process.env.INFOMANAGER_CLIENT_SECRET || '';

// ─── Cache ───────────────────────────────────────────────────────────────────
const CACHE_TTL = 10 * 60 * 1000; // 10 min — pre-warm cron refresca cada 4 min
let sheetsCache: { invoices: string; clients: string; timestamp: number } | null = null;

interface NormalizedData {
    invoices: any[];
    clientDbMap: Record<string, any>;
    source: 'infomanager' | 'sheets';
}
let dataCache: { data: NormalizedData; timestamp: number; key: number } | null = null;

// ─── Sheets Fetch ────────────────────────────────────────────────────────────
const fetchSheetsData = async (force = false): Promise<{ invoices: string; clients: string }> => {
    if (!force && sheetsCache && Date.now() - sheetsCache.timestamp < CACHE_TTL) {
        return sheetsCache;
    }
    const [invoicesRes, clientsRes] = await Promise.all([
        axios.get(INVOICES_URL, { responseType: 'text', timeout: 30000, maxRedirects: 10 }),
        axios.get(CLIENTS_URL, { responseType: 'text', timeout: 30000, maxRedirects: 10 })
    ]);
    sheetsCache = {
        invoices: invoicesRes.data,
        clients: clientsRes.data,
        timestamp: Date.now()
    };
    return sheetsCache;
};

// ─── InfoManager Token Management ────────────────────────────────────────────
let imToken: { jwt: string; expiresAt: number } | null = null;
let imTokenPromise: Promise<string> | null = null;

async function getIMToken(): Promise<string> {
    if (imToken && Date.now() < imToken.expiresAt - 5 * 60 * 1000) {
        return imToken.jwt;
    }
    if (!imTokenPromise) {
        imTokenPromise = (async () => {
            const res = await axios.post(`${IM_BASE_URL}/auth/login`, {
                client_id: IM_CLIENT_ID,
                client_secret: IM_CLIENT_SECRET
            }, { timeout: 15000 });
            const jwt = res.data.token;
            imToken = { jwt, expiresAt: Date.now() + 23 * 60 * 60 * 1000 };
            return jwt;
        })().finally(() => { imTokenPromise = null; });
    }
    return imTokenPromise;
}

// ─── Cache de /clientes de InfoManager (contactos) ──────────────────────────
// TTL largo: los teléfonos no cambian frecuentemente y el fetch puede traer
// miles de filas. Refresco cada 1h.
const IM_CLIENTES_TTL = 60 * 60 * 1000;
let imClientesCache: { data: any[]; timestamp: number } | null = null;
let imClientesPromise: Promise<any[]> | null = null;

async function getIMClientesCached(): Promise<any[]> {
    if (imClientesCache && Date.now() - imClientesCache.timestamp < IM_CLIENTES_TTL) {
        return imClientesCache.data;
    }
    if (imClientesPromise) return imClientesPromise;
    const { fetchClientesIM } = await import('./server-lib/infomanager.js');
    imClientesPromise = fetchClientesIM()
        .then(rows => { imClientesCache = { data: rows, timestamp: Date.now() }; return rows; })
        .catch(err => { console.error('[getIMClientesCached]', err?.message ?? err); return imClientesCache?.data ?? []; })
        .finally(() => { imClientesPromise = null; });
    return imClientesPromise;
}

async function enrichClientDbMapFromIM(clientDbMap: Record<string, any>) {
    try {
        const clientes = await getIMClientesCached();
        clientes.forEach((c: any) => {
            const cod = String(c.cod_cliente);
            if (!clientDbMap[cod]) return; // solo enriquecer los que ya están en el dataset activo
            clientDbMap[cod].telefono = c.telefono ?? null;
            clientDbMap[cod].whatsapp = c.whatsapp ?? c.telefono ?? null;
        });
    } catch (err: any) {
        console.error('[enrichClientDbMapFromIM] exception', err?.message ?? err);
    }
}

// ─── Enriquece clientDbMap con datos operativos del maestro (Supabase) ──────
// Agrega dirección, día visita, frecuencia, repartidor, ABC, notas, histórico,
// etc. al map existente. Si Supabase no está configurado, skip gracioso.
async function enrichClientDbMapFromSupabase(clientDbMap: Record<string, any>) {
    if (!hasSupabase()) return;
    try {
        const cods = Object.keys(clientDbMap).map(c => Number(c)).filter(n => Number.isFinite(n) && n > 0);
        if (cods.length === 0) return;
        // Supabase tiene un tope de items en .in(); procesamos en chunks de 500.
        const chunks: number[][] = [];
        for (let i = 0; i < cods.length; i += 500) chunks.push(cods.slice(i, i + 500));
        const allRows: any[] = [];
        for (const chunk of chunks) {
            const { data, error } = await sb()
                .from('client_operational')
                .select('cod_cliente, direccion, dia_visita, visita, frecuencia, hoja_ruta, repartidor, dia_entrega, cond_pago, tipo_abc, notas, fact_mes_pasado, fact_prom_3m, saldo_cta_cte')
                .eq('tenant_id', TENANT_ID)
                .in('cod_cliente', chunk);
            if (error) { console.error('[enrichClientDbMap]', error.message); continue; }
            if (data) allRows.push(...data);
        }
        allRows.forEach((row: any) => {
            const cod = String(row.cod_cliente);
            if (!clientDbMap[cod]) clientDbMap[cod] = { Cod: cod };
            const existing = clientDbMap[cod];
            existing.direccion = row.direccion ?? null;
            existing.dia_visita = row.dia_visita ?? null;
            existing.visita = row.visita ?? null;
            // Sheet ya puede haber llenado Frecuencia con mayúscula; preferimos ese si existe.
            if (!existing.Frecuencia && row.frecuencia) existing.Frecuencia = row.frecuencia;
            existing.hoja_ruta = row.hoja_ruta ?? null;
            existing.repartidor = row.repartidor ?? null;
            existing.dia_entrega = row.dia_entrega ?? null;
            existing.cond_pago = row.cond_pago ?? null;
            existing.tipo_abc = row.tipo_abc ?? null;
            existing.notas = row.notas ?? null;
            existing.fact_mes_pasado = row.fact_mes_pasado != null ? Number(row.fact_mes_pasado) : null;
            existing.fact_prom_3m = row.fact_prom_3m != null ? Number(row.fact_prom_3m) : null;
            existing.saldo_cta_cte = row.saldo_cta_cte != null ? Number(row.saldo_cta_cte) : null;
        });
    } catch (err: any) {
        console.error('[enrichClientDbMap] exception', err?.message ?? err);
    }
}

// ─── InfoManager Data Fetch ──────────────────────────────────────────────────
async function fetchIMData(codEmpresa?: number): Promise<NormalizedData> {
    const token = await getIMToken();
    const headers = { Authorization: `Bearer ${token}` };

    // Fetch comprob_pendientes for requested empresa(s) + vendedores + clients sheet
    const empresas = codEmpresa ? [codEmpresa] : [1]; // Default: solo empresa 1
    // Retry ante transitorios de IM (timeout/5xx/reset) — el caso documentado del
    // BI era "body vacío + resets". El Google Sheet (CLIENTS_URL) ya degrada con
    // .catch, no necesita retry.
    const invoicePromises = empresas.map(e =>
        imGetRetry(() => axios.get(`${IM_BASE_URL}/reportes/comprob_pendientes_clientes?tag=todos&codCliente=0&codEmpresa=${e}`, { headers, timeout: 60000 }), `comprob_pendientes emp${e} (/api/data)`)
    );
    const [vendedoresRes, clientsSheetRes, ...invoiceResults] = await Promise.all([
        imGetRetry(() => axios.get(`${IM_BASE_URL}/vendedores`, { headers, timeout: 15000 }), 'vendedores (/api/data)'),
        axios.get(CLIENTS_URL, { responseType: 'text', timeout: 30000, maxRedirects: 10 }).catch(() => null),
        ...invoicePromises,
    ]);

    // Build vendedor lookup
    const vendedorMap = new Map<number, string>();
    (vendedoresRes.data as any[]).forEach((v: any) => {
        vendedorMap.set(v.cod_vendedor, v.nombre);
    });

    // Build clientDb from Google Sheet (for Localidad/Frecuencia/VISITA — IM doesn't have these)
    const clientDbMap: Record<string, any> = {};
    if (clientsSheetRes?.data) {
        const clientsParsed = parse(clientsSheetRes.data, { header: true, skipEmptyLines: true }).data as any[];
        clientsParsed.forEach((c: any) => {
            const cod = String(c.Cod || '').trim();
            if (cod) {
                clientDbMap[cod] = {
                    Cod: cod,
                    'Razon Social': c['Razon Social'] || '',
                    Localidad: c.Localidad?.trim() || '',
                    Frecuencia: c.Frecuencia?.trim() || '',
                    // Plazo de pago de la cta cte en días ('7'/'15'). OJO: distinto de
                    // "visita" (minúscula, SI/NO) que agrega Supabase client_operational.
                    Visita: c.VISITA?.toString().trim() || '',
                };
            }
        });
    }

    // Normalize IM invoices to match InvoiceRaw shape
    const normalize = (imInvoices: any[], codEmpresa: number) => {
        return imInvoices.map((inv: any) => {
            // Convert ISO date to DD/MM/YYYY
            let fecha = '';
            if (inv.fecha_factura) {
                const d = new Date(inv.fecha_factura);
                if (!isNaN(d.getTime())) {
                    fecha = `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
                }
            }

            return {
                COD_CLIENT: String(inv.cod_cliente),
                CLIENTES_N: inv.nombre || '',
                COD_VENDED: String(inv.cod_vendedor),
                VENDEDORES: inv.cod_vendedor === 0 ? 'SIN VENDEDOR' : (vendedorMap.get(inv.cod_vendedor) || `VENDEDOR ${inv.cod_vendedor}`),
                NUMERO: String(inv.numero || ''),
                ID: `IM-${codEmpresa}-${inv.tipo_comprobante}-${inv.punto_de_venta || 0}-${inv.numero || 0}`,
                FECHA: fecha,
                TOTAL: inv.importe_factura,
                IMPORTE_PA: inv.importe_pagado,
                SALDO: inv.saldo,
                TIPO_COMPR: inv.tipo_comprobante || '',
                DIAS_EMISI: inv.dias_deuda || 0,
                COD_EMPRES: String(codEmpresa),
            };
        });
    };

    const allInvoices = empresas.flatMap((e, i) => normalize(invoiceResults[i].data, e));

    // Reasignar comprobantes con cod_vendedor=0 al vendedor real del cliente
    // (ASD/ASH del sistema no tienen vendedor asignado en InfoManager)
    const clientVendorMap = new Map<string, { id: string; name: string }>();
    allInvoices.forEach((inv: any) => {
        if (inv.COD_VENDED !== '0' && !clientVendorMap.has(inv.COD_CLIENT)) {
            clientVendorMap.set(inv.COD_CLIENT, { id: inv.COD_VENDED, name: inv.VENDEDORES });
        }
    });
    // Reasignar o descartar comprobantes sin vendedor
    const resolvedInvoices = allInvoices.filter((inv: any) => {
        if (inv.COD_VENDED !== '0') return true;
        const real = clientVendorMap.get(inv.COD_CLIENT);
        if (real) {
            inv.COD_VENDED = real.id;
            inv.VENDEDORES = real.name;
            return true;
        }
        return false; // Sin vendedor asignable → excluir
    });

    // Enriquecer con datos operativos del maestro (Supabase + InfoManager /clientes).
    // En paralelo: Supabase y IM /clientes son fuentes independientes.
    await Promise.all([
        enrichClientDbMapFromSupabase(clientDbMap),
        enrichClientDbMapFromIM(clientDbMap),
    ]);

    return { invoices: resolvedInvoices, clientDbMap, source: 'infomanager' };
}

// ─── Unified Data Fetch (IM primary, Sheets fallback) ────────────────────────
async function fetchData(force = false, codEmpresa?: number): Promise<NormalizedData> {
    const cacheKey = codEmpresa || 0;
    if (!force && dataCache && dataCache.key === cacheKey && Date.now() - dataCache.timestamp < CACHE_TTL) {
        return dataCache.data;
    }

    if (DATA_SOURCE === 'infomanager') {
        try {
            const data = await fetchIMData(codEmpresa);
            dataCache = { data, timestamp: Date.now(), key: cacheKey };
            return data;
        } catch (err: any) {
            console.error('InfoManager failed, falling back to Sheets:', err.message);
        }
    }

    // Sheets fallback — return CSV strings for backward compat
    const sheets = await fetchSheetsData(force);
    const result: NormalizedData = {
        invoices: sheets.invoices as any,
        clientDbMap: sheets.clients as any,
        source: 'sheets'
    };
    dataCache = { data: result, timestamp: Date.now(), key: 0 };
    return result;
}

// ─── Auth ──────────────────────────────────────────────────────────────────────
const APP_PASSWORD = process.env.APP_PASSWORD;
const TOKEN_TTL = 8 * 60 * 60 * 1000; // 8 hours

// Login rate limiting: max 10 attempts per IP per 15 min
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    if (!APP_PASSWORD) { next(); return; }
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { res.status(401).json({ error: 'No autorizado' }); return; }
    const token = auth.slice(7);
    const row = db.prepare('SELECT expiry FROM auth_tokens WHERE token = ?').get(token) as { expiry: number } | undefined;
    if (!row || Date.now() > row.expiry) { res.status(401).json({ error: 'Sesión expirada' }); return; }
    next();
};

app.post('/api/auth/login', (req: express.Request, res: express.Response) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();

    // Rate limiting
    const attempts = loginAttempts.get(ip);
    if (attempts && now < attempts.resetAt && attempts.count >= 10) {
        res.status(429).json({ success: false, error: 'Demasiados intentos. Esperá 15 minutos.' });
        return;
    }
    if (!attempts || now >= attempts.resetAt) {
        loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    } else {
        attempts.count++;
    }

    const { password } = req.body as { password?: string };
    if (!APP_PASSWORD || password === APP_PASSWORD) {
        loginAttempts.delete(ip); // Reset on success
        const token = randomUUID();
        db.prepare('INSERT INTO auth_tokens (token, expiry) VALUES (?, ?)').run(token, Date.now() + TOKEN_TTL);
        cleanExpiredTokens();
        res.json({ success: true, token, authRequired: !!APP_PASSWORD });
        return;
    }
    res.status(401).json({ success: false, error: 'Contraseña incorrecta' });
});

app.get('/api/auth/check', requireAuth, (_req: express.Request, res: express.Response) => {
    res.json({ valid: true, authRequired: !!APP_PASSWORD });
});

// ─── Auth v2: email+password+JWT (reusa tabla usuarios del CRM) ───────────────
app.post('/api/auth/login-v2', async (req: express.Request, res: express.Response) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const attempts = loginAttempts.get(ip);
    if (attempts && now < attempts.resetAt && attempts.count >= 10) {
        res.status(429).json({ success: false, error: 'Demasiados intentos. Esperá 15 minutos.' });
        return;
    }
    if (!attempts || now >= attempts.resetAt) {
        loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    } else {
        attempts.count++;
    }

    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) { res.status(400).json({ success: false, error: 'email y password requeridos' }); return; }
    if (!hasSupabase()) { res.status(500).json({ success: false, error: 'Supabase no configurado' }); return; }

    try {
        const user = await findUsuarioByEmail(email.trim());
        if (!user) { res.status(401).json({ success: false, error: 'Credenciales inválidas' }); return; }
        const { ok, needsRehash } = await verifyPassword(password, user.password_hash);
        if (!ok) { res.status(401).json({ success: false, error: 'Credenciales inválidas' }); return; }
        loginAttempts.delete(ip);
        // Migración seamless: si el hash era sha256 legacy, lo rehasheamos con
        // bcrypt aprovechando que tenemos la password en claro. El usuario no
        // necesita cambiar nada.
        if (needsRehash && hasSupabase()) {
            try {
                const newHash = await hashPassword(password);
                await sb().from('usuarios').update({ password_hash: newHash })
                    .eq('tenant_id', TENANT_ID).eq('id', user.id);
            } catch (e) { console.warn('Rehash bcrypt fallo (no bloqueante):', e); }
        }
        const jwt = signJwt(usuarioToJwtPayload(user));
        res.json({ success: true, jwt, user: { email: user.email, rol: user.rol, cod_vendedor: user.cod_vendedor, vendedor_key: user.vendedor_key, nombre: user.nombre } });
    } catch (err: any) {
        console.error('login-v2 error:', err);
        res.status(500).json({ success: false, error: err?.message ?? 'error' });
    }
});

// Middleware JWT: adjunta req.user si hay Bearer válido
const requireJwt = (req: express.Request & { user?: JwtPayload }, res: express.Response, next: express.NextFunction): void => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { res.status(401).json({ error: 'No autorizado' }); return; }
    const payload = verifyJwt(auth.slice(7));
    if (!payload) { res.status(401).json({ error: 'Sesión inválida o expirada' }); return; }
    req.user = payload;
    next();
};

// Middleware opcional: si hay JWT lo adjunta, sino sigue (compat con legacy SQLite tokens)
const maybeJwt = (req: express.Request & { user?: JwtPayload }, _res: express.Response, next: express.NextFunction): void => {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
        const payload = verifyJwt(auth.slice(7));
        if (payload) req.user = payload;
    }
    next();
};

// El rol repartidor solo opera sobre Recibos + su propia cuenta. Estos prefijos
// (ventas, cobranzas, objetivos, comisiones, reportes, config) quedan vedados
// aunque el repartidor tenga un JWT válido. maybeJwt corre primero para poblar
// req.user; denyRepartidor lo evalúa antes de que la ruta haga su propio
// requireJwt/requireAdmin. Este bloque debe ir ANTES de las definiciones de
// ruta /api/* para que los app.use se apliquen.
const denyRepartidor = (req: express.Request & { user?: JwtPayload }, res: express.Response, next: express.NextFunction): void => {
    if (req.user?.rol === 'repartidor') {
        res.status(403).json({ error: 'Los repartidores no tienen acceso a esta sección' });
        return;
    }
    next();
};
for (const prefix of [
    '/api/data', '/api/goals', '/api/comisiones', '/api/activity',
    '/api/month-config', '/api/reportes', '/api/cuentas', '/api/sheet-import',
    '/api/overrides', '/api/client-thresholds', '/api/debug', '/api/conciliacion',
]) {
    app.use(prefix, maybeJwt, denyRepartidor);
}

app.get('/api/me', requireJwt, (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    res.json({ ok: true, user: req.user });
});

// ─── Recibos ──────────────────────────────────────────────────────────────────
// Uploads van a /tmp (diskStorage) en vez de memoria para no quemar RAM si hay
// uploads concurrentes. 10 uploads × 10MB en memoryStorage = 100MB de heap;
// con diskStorage el peak de RAM por upload es O(1). Cleanup del archivo se
// hace en cleanupUploadedFile (middleware abajo) cuando termina la response.
const uploadTmpDir = path.join(__dirname, '..', 'data', 'uploads-tmp');
if (!fs.existsSync(uploadTmpDir)) fs.mkdirSync(uploadTmpDir, { recursive: true });
const upload = multer({
    storage: multer.diskStorage({
        destination: uploadTmpDir,
        filename: (_req, file, cb) => cb(null, `${randomUUID()}-${Date.now()}${path.extname(file.originalname) || ''}`),
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
});

// Después de cada response de un endpoint con upload, borrar el archivo temporal.
// `res.on('finish')` corre cuando los bytes salen al cliente; `res.on('close')`
// corre también si el cliente abortó, así cubrimos ambos casos.
function cleanupUploadedFile(req: express.Request, res: express.Response, next: express.NextFunction): void {
    const cleanup = () => {
        const f = (req as any).file;
        if (f?.path) fs.promises.unlink(f.path).catch(() => {});
    };
    res.on('finish', cleanup);
    res.on('close', cleanup);
    next();
}

app.post('/api/recibos/upload', requireJwt, upload.single('foto'), cleanupUploadedFile, (req: any, res) => uploadRecibo(req, res));
app.get('/api/recibos', requireJwt, (req: any, res) => listRecibos(req, res));
// IMPORTANTE: antes de /api/recibos/:id para que ":id" no capture "mp-config".
app.get('/api/recibos/mp-config', requireJwt, (req: any, res) => mpConfig(req, res));
app.get('/api/recibos/:id', requireJwt, (req: any, res) => getReciboById(req, res));
app.get('/api/recibos/:id/facturas-candidatas', requireJwt, (req: any, res) => facturasCandidatas(req, res));
app.post('/api/recibos/:id/aprobar', requireJwt, (req: any, res) => aprobarRecibo(req, res));
app.post('/api/recibos/:id/rechazar', requireJwt, (req: any, res) => rechazarRecibo(req, res));
app.post('/api/recibos/:id/editar', requireJwt, (req: any, res) => editarRecibo(req, res));
app.post('/api/recibos/:id/reverificar-mp', requireJwt, (req: any, res) => reverificarMP(req, res));
app.post('/api/recibos/:id/elegir-match', requireJwt, (req: any, res) => elegirMatchMP(req, res));

// Reportes admin-only (xlsx)
app.get('/api/reportes/:tipo', requireJwt, (req: any, res) => descargarReporte(req, res));

// Conciliación de cta cte de clientes (admin/gerente): saldo IM + cobranzas
// en tránsito de la app, agrupado por vendedor. Export xlsx con 3 hojas.
app.get('/api/conciliacion', requireJwt, (req: any, res) => getConciliacion(req, res));
app.get('/api/conciliacion/export', requireJwt, (req: any, res) => exportConciliacion(req, res));

// Cruce carpeta vs sistema (admin/gerente): sube el .xlsx del Sheet de la
// carpeta física y lo cruza contra la cta cte IM a una fecha de corte.
// El xlsx del cruce va en memoria (memoryStorage): archivos chicos (~100KB),
// se parsean al toque y no tocan disco — a diferencia de las fotos de recibos.
// fileFilter rechaza ANTES de bufferizar 10MB de cualquier cosa que no sea
// una planilla (extensión .xlsx/.xlsm o mimetype de spreadsheet).
const uploadXlsxMem = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const okExt = /\.(xlsx|xlsm)$/i.test(file.originalname ?? '');
        const okMime = /spreadsheet|excel|octet-stream/i.test(file.mimetype ?? '');
        if (okExt || okMime) cb(null, true);
        else cb(new Error('Solo se aceptan planillas .xlsx/.xlsm'));
    },
});
app.get('/api/conciliacion/snapshots', requireJwt, (req: any, res) => listSnapshotsConciliacion(req, res));
// Wrapper del middleware de multer para responder JSON 400 ante rechazo del
// fileFilter o archivo demasiado grande (sin esto, el error caía al handler
// default de Express como HTML 500).
app.post('/api/conciliacion/cruce', requireJwt, (req: any, res) => {
    uploadXlsxMem.single('file')(req, res, (err: any) => {
        if (err) { res.status(400).json({ error: err?.message ?? 'Archivo inválido' }); return; }
        cruceCarpetaHandler(req, res);
    });
});
app.get('/api/conciliacion/cruce/export', requireJwt, (req: any, res) => exportCruceHandler(req, res));
app.get('/api/cuentas/debug', requireJwt, (req: any, res) => cuentasDebug(req, res));
app.get('/api/cuentas/efectivo', requireJwt, (req: any, res) => cuentasEfectivo(req, res));

// Diagnóstico público del estado de cache (sin secretos). Sirve para
// verificar si el prewarm completó tras un deploy. Si esto responde lento,
// el problema no es de auth/handlers.
app.get('/api/debug/cache-state', (_req, res) => {
    res.json({
        ok: true,
        now: new Date().toISOString(),
        snapshot: snapshotCacheStats(),
    });
});
app.post('/api/cuentas/refresh', requireJwt, (req: any, res) => cuentasRefresh(req, res));

// ─── Refrescar contactos (teléfonos/WhatsApp) desde InfoManager ─────────────
// Los teléfonos se leen de IM y viven en DOS cachés: imClientesCache (contactos
// crudos de IM, TTL 1h) y dataCache (respuesta armada de /api/data, TTL 10min).
// Tras corregir un teléfono en InfoManager, este endpoint invalida ambas capas
// y re-lee IM en el acto, sin esperar el TTL ni reiniciar el container. Admin-only.
app.post('/api/clientes/refresh-contactos', requireJwt, requireAdmin, async (_req: any, res) => {
    try {
        // Re-leemos IM PRIMERO (fetch en vivo). Solo si trajo contactos pisamos la
        // caché: si IM está caído o responde vacío, preservamos los teléfonos que
        // ya teníamos (no dejamos la app sin contactos). fetchClientesIM tira si IM
        // falla → cae al catch (500) sin tocar nada.
        const { fetchClientesIM } = await import('./server-lib/infomanager.js');
        const rows = await fetchClientesIM();
        if (rows.length === 0) {
            res.json({ ok: false, contactos: 0, warning: 'InfoManager no devolvió contactos; se conservan los actuales.' });
            return;
        }
        imClientesCache = { data: rows, timestamp: Date.now() }; // pisa contactos IM (TTL 1h)
        dataCache = null; // invalida /api/data para que rearme con los teléfonos nuevos
        res.json({ ok: true, contactos: rows.length, refreshedAt: new Date().toISOString() });
    } catch (err: any) {
        console.error('[refresh-contactos]', err?.message ?? err);
        res.status(500).json({ error: err?.message ?? 'Error refrescando contactos desde InfoManager' });
    }
});

// Debug admin-only: probar endpoints no documentados de edición de recibo IM.
// Swagger v1 solo lista POST /recibo, pero el cliente desktop SÍ edita las
// fechas Fec.Em./Fec.Pago de un recibo creado → debe haber un endpoint oculto.
// Esto prueba 10 combos (GET/PUT/PATCH/POST) y devuelve qué respondió cada uno.
// Llamar con POST /api/debug/im-edit-recibo body {recibo_id, fecha}.
// Si no se pasa recibo_id, usa el último recibo imputado en Supabase.
app.post('/api/debug/im-edit-recibo', requireJwt, async (req: any, res) => {
  try {
    if (req.user?.rol !== 'admin' && req.user?.rol !== 'gerente') {
      res.status(403).json({ error: 'Requiere admin/gerente' });
      return;
    }
    let reciboId = String(req.body?.recibo_id ?? '').trim();
    let pagoId = String(req.body?.pago_id ?? '').trim();
    let fecha = String(req.body?.fecha ?? '').trim();
    let ultimoComp: any = null;
    // Si no se pasa recibo_id, buscamos el último imputado de Supabase
    // y extraemos el id del recibo y del primer pago desde infomanager_response
    if (!reciboId) {
      const { sb, TENANT_ID } = await import('./server-lib/supabase.js');
      const { data } = await sb().from('comprobantes_pago')
        .select('id, infomanager_recibo_id, infomanager_response, fecha_comprobante, cod_cliente, monto')
        .eq('tenant_id', TENANT_ID).eq('status', 'imputado')
        .order('imputado_at', { ascending: false }).limit(1).maybeSingle();
      ultimoComp = data;
      // Preferimos data.infomanager_recibo_id; si está vacío usamos
      // infomanager_response.recibo.id (el ID interno verdadero).
      reciboId = String(data?.infomanager_recibo_id || data?.infomanager_response?.recibo?.id || '');
      if (!pagoId) {
        pagoId = String(data?.infomanager_response?.recibo?.pagos?.[0]?.id || '');
      }
      if (!fecha) fecha = String(data?.fecha_comprobante ?? '');
    }
    if (!reciboId) {
      res.status(400).json({
        error: 'No hay recibo_id. Pasalo explícito en body, o aprobá un recibo nuevo antes.',
        ultimoComp,
      });
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      res.status(400).json({ error: `fecha inválida: "${fecha}". Usá YYYY-MM-DD.` });
      return;
    }
    const { probarEditarReciboIM } = await import('./server-lib/infomanager.js');
    const resultados = await probarEditarReciboIM(reciboId, fecha, pagoId || undefined);
    res.json({ ok: true, recibo_id: reciboId, pago_id: pagoId, fecha, ultimoComp, resultados });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
});

// Debug admin-only: devuelve el último comprobante imputado de Supabase con
// el infomanager_response completo. Útil para ver qué nos contestó IM al crear.
app.get('/api/debug/ultimo-recibo', requireJwt, async (req: any, res) => {
  try {
    if (req.user?.rol !== 'admin' && req.user?.rol !== 'gerente') {
      res.status(403).json({ error: 'Requiere admin/gerente' });
      return;
    }
    const { sb, TENANT_ID } = await import('./server-lib/supabase.js');
    const { data, error } = await sb().from('comprobantes_pago')
      .select('id, cod_cliente, monto, fecha_comprobante, status, infomanager_recibo_id, infomanager_response, imputado_at, error_msg')
      .eq('tenant_id', TENANT_ID)
      .in('status', ['imputado', 'error'])
      .order('imputado_at', { ascending: false, nullsFirst: false })
      .order('reviewed_at', { ascending: false, nullsFirst: false })
      .limit(3);
    if (error) { res.status(500).json({ error: error.message }); return; }
    res.json({ ok: true, recibos: data ?? [] });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
});

// ─── Objetivos ───────────────────────────────────────────────────────────────
app.get('/api/goals', requireJwt, (req: any, res) => listGoals(req, res));
app.post('/api/goals', requireJwt, (req: any, res) => setGoal(req, res));
app.post('/api/goals/sync-now', requireJwt, (req: any, res) => syncVentasNow(req, res));
app.post('/api/goals/backfill', requireJwt, requireAdmin, async (req: any, res) => {
    try {
        const months = Math.max(1, Math.min(24, Number(req.body?.months) || 6));
        const sync = req.query.sync === '1' || req.body?.sync === true;
        if (sync) {
            // Modo síncrono: útil para CLI o smoke test. Bloquea hasta terminar.
            const results = await syncVentasMeses(months);
            res.json({ ok: results.every(r => r.ok), months, results });
            return;
        }
        // Por default: arranca en background, responde enseguida.
        // Logs del progreso quedan en console del server.
        setImmediate(async () => {
            console.log(`[backfill] arrancando ${months} meses…`);
            const t0 = Date.now();
            const results = await syncVentasMeses(months);
            const ok = results.filter(r => r.ok).length;
            const fail = results.filter(r => !r.ok).length;
            const totComp = results.reduce((a, r) => a + (r.comprobantes || 0), 0);
            console.log(`[backfill] terminado en ${Date.now() - t0}ms · ${ok} ok / ${fail} fail · ${totComp} comprob procesados`);
        });
        res.json({ ok: true, started: true, months, message: 'Backfill arrancado en background. Mirá los logs del server para el progreso.' });
    } catch (err: any) {
        res.status(500).json({ error: err?.message ?? 'error' });
    }
});
app.post('/api/month-config', requireJwt, (req: any, res) => setMonthConfig(req, res));
app.get('/api/goals/clientes', requireJwt, (req: any, res) => listClientesObjetivo(req, res));
app.get('/api/goals/debug-cliente/:cod', requireJwt, requireAdmin, (req: any, res) => debugClienteAvance(req, res));
app.get('/api/goals/snapshot', requireJwt, (req: any, res) => getGoalsSnapshot(req, res));

// ─── Comisiones por vendedor (calculadas desde /ventas + /ventas/items) ──────
// Vendedor: ve solo la suya. Admin/gerente: ve todas (whitelist 5 visibles).
app.get('/api/comisiones', requireJwt, (req: any, res) => listComisiones(req, res));
// Comisiones por ventas en SUCURSAL (San Martín) — SOLO admin/gerente, no visible
// para vendedores. Clientes de Casa Central que retiran en la sucursal.
app.get('/api/comisiones/sucursal', requireJwt, requireAdmin, (req: any, res) => listComisionesSucursal(req, res));
app.get('/api/comisiones/probe-venta/:id', requireJwt, requireAdmin, (req: any, res) => probeVenta(req, res));
app.get('/api/comisiones/sample', requireJwt, requireAdmin, (req: any, res) => comisionesSample(req, res));
app.get('/api/comisiones/top-articulos', requireJwt, requireAdmin, (req: any, res) => topArticulos(req, res));
app.get('/api/comisiones/facturas-vendedor', requireJwt, requireAdmin, (req: any, res) => facturasVendedor(req, res));
app.get('/api/comisiones/diagnose-articulo/:cod', requireJwt, requireAdmin, (req: any, res) => diagnoseArticulo(req, res));
// Override manual de vendedor por comprobante (factura emitida en IM con
// vendedor equivocado e inmutable). Admin-only.
app.get('/api/comisiones/overrides', requireJwt, requireAdmin, (req: any, res) => listOverrides(req, res));
app.post('/api/comisiones/overrides', requireJwt, requireAdmin, (req: any, res) => addOverride(req, res));
app.delete('/api/comisiones/overrides/:id', requireJwt, requireAdmin, (req: any, res) => deleteOverride(req, res));

// ─── Clientes lookup (maestro completo, con y sin deuda) ─────────────────────
app.get('/api/clientes/lookup', requireJwt, (req: any, res) => listClientesLookup(req, res));
app.get('/api/clientes/:cod/historial-compras', requireJwt, (req: any, res) => historialComprasCliente(req, res));

// ─── DEBUG: sample crudo de /clientes de InfoManager (admin-only) ────────────
// Uso: curl/browser con JWT admin → ver el shape real para ajustar el mapping
// de telefono/whatsapp en fetchClientesIM cuando no traigan los nombres
// comunes que asumimos por defecto.
app.get('/api/debug/im-clientes-sample', requireJwt, requireAdmin, async (req: any, res) => {
    try {
        const limit = Number(req.query.limit) || 3;
        const page = Number(req.query.page) || 1;
        const codFilter = req.query.cod ? Number(req.query.cod) : null;
        const token = await getIMToken();
        const { data } = await axios.get(`${IM_BASE_URL}/clientes`, {
            params: { page, limit },
            headers: { Authorization: `Bearer ${token}` },
            timeout: 30000,
        });
        const rows = Array.isArray(data) ? data
            : (data?.results ?? data?.clientes ?? data?.data ?? data?.items ?? []);
        const filtered = codFilter != null
            ? rows.filter((r: any) => Number(r.cod_cliente ?? r.codigo ?? r.id ?? r.cod) === codFilter)
            : rows;
        // Sample devuelve el row crudo + las keys disponibles + el envelope top-level
        // para detectar el nombre correcto de cada campo de contacto y del paginador.
        res.json({
            ok: true,
            envelope_keys: (data && typeof data === 'object' && !Array.isArray(data)) ? Object.keys(data) : [],
            envelope_meta: (data && typeof data === 'object' && !Array.isArray(data))
                ? Object.fromEntries(Object.entries(data).filter(([k]) => k !== 'results' && k !== 'clientes' && k !== 'data' && k !== 'items'))
                : null,
            rows_count: rows.length,
            sample_count: filtered.length,
            available_keys: rows[0] ? Object.keys(rows[0]) : [],
            sample: filtered,
        });
    } catch (err: any) {
        res.status(500).json({ ok: false, error: err?.message ?? 'error', status: err?.response?.status, raw: err?.response?.data });
    }
});

// ─── Actividad ───────────────────────────────────────────────────────────────
app.get('/api/activity', requireJwt, (req: any, res) => listActivity(req, res));
app.post('/api/activity', requireJwt, (req: any, res) => createActivity(req, res));
app.put('/api/activity/:id', requireJwt, (req: any, res) => updateActivity(req, res));
app.delete('/api/activity/:id', requireJwt, (req: any, res) => deleteActivity(req, res));
app.get('/api/notificaciones', requireJwt, (req: any, res) => listNotificaciones(req, res));

// ─── Web Push (notificaciones nativas browser) ───────────────────────────────
app.get('/api/push/vapid-public-key', requireJwt, (req: any, res) => getVapidPublicKeyHandler(req, res));
app.post('/api/push/subscribe', requireJwt, (req: any, res) => subscribePush(req, res));
app.post('/api/push/unsubscribe', requireJwt, (req: any, res) => unsubscribePush(req, res));
app.post('/api/push/test', requireJwt, (req: any, res) => testPush(req, res));
app.post('/api/push/dispatch-now', requireJwt, (req: any, res) => dispatchPushNow(req, res));

// Estado del cron de push (admin-only) — declarado acá para que el endpoint
// quede registrado ANTES del catch-all de la SPA (línea ~1060). Las mismas
// variables las modifica el cron tick más abajo.
let lastPushCronAt: Date | null = null;
let lastPushCronResult: any = null;
app.get('/api/push/cron-status', requireJwt, (req: any, res) => {
    if (req.user?.rol !== 'admin' && req.user?.rol !== 'gerente') {
        res.status(403).json({ error: 'Requiere admin/gerente' });
        return;
    }
    res.json({
        ok: true,
        lastRunAt: lastPushCronAt?.toISOString() ?? null,
        secondsSinceLastRun: lastPushCronAt ? Math.round((Date.now() - lastPushCronAt.getTime()) / 1000) : null,
        lastResult: lastPushCronResult,
    });
});

// ─── Gestión de usuarios ─────────────────────────────────────────────────────
app.get('/api/usuarios', requireJwt, requireAdmin, (req: any, res) => listUsuarios(req, res));
app.post('/api/usuarios', requireJwt, requireAdmin, (req: any, res) => createUsuario(req, res));
app.put('/api/usuarios/:id', requireJwt, requireAdmin, (req: any, res) => updateUsuario(req, res));
app.delete('/api/usuarios/:id', requireJwt, requireAdmin, (req: any, res) => deleteUsuario(req, res));
app.post('/api/usuarios/change-password', requireJwt, (req: any, res) => changePassword(req, res));

// ─── Import sheet Maestro Clientes ───────────────────────────────────────────
app.post('/api/sheet-import/maestro-clientes', requireJwt, requireAdmin, upload.single('file'), cleanupUploadedFile,
    (req: any, res) => importMaestroClientes(req, res));

// ─── Data Proxy ───────────────────────────────────────────────────────────────
// Si el JWT es de un vendedor, filtramos los invoices solo a los suyos.
app.get('/api/data', maybeJwt, requireAuth, async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    try {
        const force = req.query.nocache === '1';
        const codEmpresa = req.query.codEmpresa ? Number(req.query.codEmpresa) : undefined;
        const data = await fetchData(force, codEmpresa);

        // Filtro por rol: vendedor solo ve sus invoices.
        // Admin/gerente puede pedir uno específico con ?cod_vendedor=X
        // o una lista con ?cods=3,4,11 (vista "Todos" con selección manual).
        const userRol = req.user?.rol;
        let filterCodVend: number | null = null;
        let filterCods: Set<string> | null = null;
        if (userRol === 'vendedor') {
            filterCodVend = req.user!.cod_vendedor ?? -1;
        } else if (req.query.cod_vendedor) {
            const n = Number(req.query.cod_vendedor);
            if (n > 0) filterCodVend = n;
        } else if (req.query.cods) {
            const cods = String(req.query.cods).split(',').map(s => s.trim()).filter(Boolean);
            if (cods.length) filterCods = new Set(cods);
        }
        // IMPORTANTE: `data` es el cache compartido. NO mutar data.invoices.
        // Se construye una respuesta nueva con invoices filtrados si aplica.
        let responseInvoices = data.invoices;
        if (data.source === 'infomanager' && Array.isArray(data.invoices)) {
            if (filterCodVend != null) {
                const vkey = userRol === 'vendedor' ? (req.user?.vendedor_key ?? '').toLowerCase() : '';
                responseInvoices = data.invoices.filter((inv: any) => {
                    if (String(inv.COD_VENDED) === String(filterCodVend)) return true;
                    if (vkey && String(inv.VENDEDORES || '').toLowerCase().includes(vkey)) return true;
                    return false;
                });
            } else if (filterCods) {
                responseInvoices = data.invoices.filter((inv: any) => filterCods!.has(String(inv.COD_VENDED)));
            }
        }

        res.json({ ...data, invoices: responseInvoices });
    } catch (err: any) {
        const detail = err.response ? ` (HTTP ${err.response.status})` : ` (${err.code || 'network error'})`;
        console.error('GET /api/data error:', err.message + detail);
        res.status(500).json({ error: err.message + detail });
    }
});

// ─── Overrides API ─────────────────────────────────────────────────────────────
app.get('/api/overrides', requireAuth, (_req: express.Request, res: express.Response) => {
    try {
        const rows = db.prepare('SELECT invoice_id, apply_interest FROM invoice_overrides').all() as Array<{ invoice_id: string; apply_interest: number }>;
        const map: Record<string, boolean> = {};
        rows.forEach(r => { map[r.invoice_id] = r.apply_interest === 1; });
        res.json(map);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/overrides', requireAuth, (req: express.Request, res: express.Response) => {
    try {
        const { invoiceId, apply } = req.body as { invoiceId?: string; apply?: boolean };
        if (!invoiceId || typeof apply !== 'boolean') {
            res.status(400).json({ error: 'Payload inválido' });
            return;
        }
        db.prepare(`
            INSERT INTO invoice_overrides (invoice_id, apply_interest) VALUES (?, ?)
            ON CONFLICT(invoice_id) DO UPDATE SET apply_interest = excluded.apply_interest
        `).run(invoiceId, apply ? 1 : 0);
        res.json({ status: 'success' });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Client Thresholds API ────────────────────────────────────────────────────
app.get('/api/client-thresholds', requireAuth, (_req: express.Request, res: express.Response) => {
    try {
        const rows = db.prepare('SELECT client_id, days FROM client_thresholds').all() as Array<{ client_id: string; days: number }>;
        const map: Record<string, number> = {};
        rows.forEach(r => { map[r.client_id] = r.days; });
        res.json(map);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/client-thresholds', requireAuth, (req: express.Request, res: express.Response) => {
    try {
        const { clientId, days } = req.body as { clientId?: string; days?: number };
        if (!clientId || typeof days !== 'number') {
            res.status(400).json({ error: 'Payload inválido' });
            return;
        }
        if (days === 0) {
            db.prepare('DELETE FROM client_thresholds WHERE client_id = ?').run(clientId);
        } else {
            db.prepare(`
                INSERT INTO client_thresholds (client_id, days) VALUES (?, ?)
                ON CONFLICT(client_id) DO UPDATE SET days = excluded.days
            `).run(clientId, days);
        }
        res.json({ status: 'success' });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Bot API ─────────────────────────────────────────────────────────────────
// Consumido por Amira (CRM WhatsApp) para responder consultas de saldo a clientes.
// Auth: bearer token en header `Authorization: Bearer <BOT_API_TOKEN>` o
// `x-bot-token: <BOT_API_TOKEN>`. Modo migración: si la env var no está seteada,
// permite paso con WARN para no romper Amira durante el deploy. Una vez configurado
// en EasyPanel + Amira, queda enforced automáticamente.
const BOT_API_TOKEN = process.env.BOT_API_TOKEN || '';
if (!BOT_API_TOKEN) {
  if (IS_PROD) {
    // /api/bot expone datos de facturación (saldos, clientes, vendedores) en
    // solo-lectura. En producción NO puede quedar público: fail-loud como
    // JWT_SECRET / INFOMANAGER_CLIENT_SECRET. Setear BOT_API_TOKEN en EasyPanel.
    console.error('FATAL: BOT_API_TOKEN no definida en producción — /api/bot expondría datos de facturación. Abortando.');
    process.exit(1);
  }
  console.warn('⚠️  BOT_API_TOKEN no definida — /api/bot queda PÚBLICO (solo dev). Configurar en EasyPanel + Amira para enforce.');
}
function requireBotToken(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!BOT_API_TOKEN) { next(); return; } // modo migración (solo dev; en prod ya abortó arriba)
  const auth = String(req.headers['authorization'] || '');
  const xToken = String(req.headers['x-bot-token'] || '');
  const provided = auth.startsWith('Bearer ') ? auth.slice(7).trim() : xToken.trim();
  if (provided && provided === BOT_API_TOKEN) { next(); return; }
  res.status(401).json({ error: 'Token inválido o ausente' });
}
// Accepts optional ?rate=0.10 query param (default 10%)
// Objetivo/avance del mes de UN vendedor (Amira modo equipo). Gating estructural:
// el cod_vendedor lo resuelve Amira desde el número remitente, nunca del prompt.
app.get('/api/bot/goals', requireBotToken, (req: express.Request, res: express.Response) => botGoals(req, res));

app.get('/api/bot', requireBotToken, async (req: express.Request, res: express.Response) => {
    try {
        const interestRate = Math.min(1, Math.max(0, parseFloat(req.query.rate as string) || 0.10));
        const data = await fetchData();

        let invoicesRaw: any[];
        const clientDbMap = new Map<string, { localidad: string; frecuencia: string; visita: string }>();

        if (data.source === 'infomanager') {
            invoicesRaw = data.invoices;
            // clientDbMap from normalized data
            Object.entries(data.clientDbMap).forEach(([cod, c]: [string, any]) => {
                clientDbMap.set(cod, {
                    localidad: c.Localidad || '',
                    frecuencia: c.Frecuencia || 'MENSUAL',
                    visita: c.Visita?.toString().trim() || ''
                });
            });
        } else {
            // Sheets fallback — parse CSV
            const clientsRaw = parse(data.clientDbMap as any, { header: true, skipEmptyLines: true }).data as any[];
            invoicesRaw = parse(data.invoices as any, { header: true, skipEmptyLines: true }).data as any[];
            clientsRaw.forEach((c: any) => {
                const cod = c.Cod?.toString().trim() || c.COD_CLIENT?.toString().trim();
                if (cod) {
                    clientDbMap.set(cod, {
                        localidad: c.Localidad?.trim() || c.LOCALIDAD?.trim() || '',
                        frecuencia: c.Frecuencia?.trim() || 'MENSUAL',
                        visita: c.VISITA?.toString().trim() || ''
                    });
                }
            });
        }

        const parseNum = (val: any): number => {
            if (!val) return 0;
            if (typeof val === 'number') return val;
            const clean = val.toString().replace(/\$/g, '').replace(/\./g, '').replace(',', '.').trim();
            const n = Number(clean);
            return isNaN(n) ? 0 : n;
        };

        const parseDate = (dateStr: string): Date => {
            const parts = dateStr.split('/');
            if (parts.length === 3) {
                return new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
            }
            return new Date(dateStr);
        };

        const today = new Date(); today.setHours(0, 0, 0, 0);
        const vendorsMap = new Map<string, Map<string, any>>();

        invoicesRaw.forEach((raw: any) => {
            const clientId = String(raw['12'] || raw.COD_CLIENT || '').trim();
            const clientName = String(raw.CLIENTES_N || '').trim();
            const vendorName = String(raw.VENDEDORES || '').trim();
            const type = String(raw.TIPO_COMPR || '').toUpperCase();
            if (!clientId || !clientName || !vendorName) return;

            const emissionDateStr = String(raw.FECHA || raw[''] || '');
            let diffDays = Number(raw.DIAS_EMISI) || 0;
            if (emissionDateStr.includes('/')) {
                const d = parseDate(emissionDateStr); d.setHours(0, 0, 0, 0);
                diffDays = Math.max(0, Math.floor((today.getTime() - d.getTime()) / 86400000));
            }

            const clientDb = clientDbMap.get(clientId);
            // Plazo real de pago = columna VISITA del maestro ('7'/'15').
            // "Frecuencia" NO es el plazo (incidente cobranzas 02/07/2026: 6 avisos
            // indebidos) — queda solo como fallback para filas sin VISITA.
            let threshold = 15;
            if (clientDb?.visita === '7') threshold = 7;
            else if (clientDb?.visita === '15') threshold = 15;
            else if (clientDb?.frecuencia === 'SEMANAL') threshold = 7;
            else if (clientDb?.frecuencia === 'MENSUAL') threshold = 30;

            const balance = parseNum(raw.SALDO);
            // Ignorar comprobantes de saldo despreciable (centavos, residuos de
            // pagos parciales, ajustes contables) — mismo criterio que la vista
            // vendedor (umbral $2000) y el dashboard admin.
            if (Math.abs(balance) <= 2000) return;

            const isOverdue = type === 'FA' && diffDays > threshold;
            const interest = isOverdue ? balance * interestRate : 0;

            if (!vendorsMap.has(vendorName)) vendorsMap.set(vendorName, new Map());
            const vendorClients = vendorsMap.get(vendorName)!;
            if (!vendorClients.has(clientId)) {
                vendorClients.set(clientId, {
                    clientName, clientId,
                    localidad: clientDb?.localidad || '',
                    maxDaysOverdue: 0, totalBalance: 0, totalInterest: 0, totalWithInterest: 0,
                    invoices: []
                });
            }
            const c = vendorClients.get(clientId)!;
            // Aging: solo saldo DEUDOR (FA y ND positivos) suma a los días de
            // atraso. NC/recibos (saldo a favor, negativo) no inflan la mora.
            if (balance > 0 && diffDays > c.maxDaysOverdue) c.maxDaysOverdue = diffDays;
            c.totalBalance += balance;
            c.totalInterest += interest;
            c.totalWithInterest += balance + interest;
            c.invoices.push({
                numero: `${raw.TIPO_COMPR || ''} ${raw.NUMERO || ''}`.trim(),
                fecha_emision: emissionDateStr,
                dias_vencida: diffDays,
                interes_aplicado: interest,
                total_a_cobrar: balance + interest
            });
        });

        const reporte_vendedores = Array.from(vendorsMap.entries())
            .map(([vendedor, clientsMap]) => {
                const locMap = new Map<string, any[]>();
                Array.from(clientsMap.values()).forEach((c: any) => {
                    if (c.totalBalance > 0) {
                        const loc = c.localidad || 'Sin Localidad';
                        if (!locMap.has(loc)) locMap.set(loc, []);
                        locMap.get(loc)!.push({
                            nombre: c.clientName,
                            codigo_cliente: c.clientId,
                            maximos_dias_atraso: c.maxDaysOverdue,
                            saldo_original: c.totalBalance,
                            saldo_con_intereses: c.totalWithInterest,
                            cantidad_facturas: c.invoices.length,
                            facturas: c.invoices
                        });
                    }
                });
                const localidades = Array.from(locMap.entries()).map(([localidad, clientes]) => ({
                    localidad,
                    total_clientes_deudores: clientes.length,
                    clientes: clientes.sort((a: any, b: any) => b.saldo_con_intereses - a.saldo_con_intereses)
                }));
                return localidades.length > 0 ? { vendedor, localidades } : null;
            })
            .filter(Boolean);

        res.json({
            status: 'success',
            timestamp: new Date().toISOString(),
            source: data.source,
            tasa_interes_aplicada: `${(interestRate * 100).toFixed(0)}%`,
            reporte_vendedores
        });
    } catch (err: any) {
        console.error('GET /api/bot error:', err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ─── Serve Frontend ────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'dist')));
app.use((_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'dist', 'index.html'));
});

// Error-handling middleware (4 args = signature Express). Captura cualquier
// excepción no manejada en los handlers async (Express 5 propaga rejections
// de funciones async). En prod devolvemos mensaje genérico para no leakear
// detalles técnicos; en dev mostramos el mensaje completo para debugging.
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[unhandled]', req.method, req.path, err);
    if (res.headersSent) return; // ya respondió: solo loguear
    const safe = IS_PROD ? 'Error interno. Avisá al admin.' : (err?.message ?? 'error');
    res.status(500).json({ error: safe });
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Auth: ${APP_PASSWORD ? 'ENABLED' : 'disabled — set APP_PASSWORD env var to enable'}`);
    console.log(`Data source: ${DATA_SOURCE}${DATA_SOURCE === 'infomanager' ? ' (with Sheets fallback)' : ''}`);
    console.log(`Supabase: ${hasSupabase() ? 'ENABLED' : 'disabled'}`);
});

// ─── Crons ────────────────────────────────────────────────────────────────────
// Lock contra overlap: si IM responde lento y el cron */30 todavía está
// corriendo cuando dispara la próxima invocación, saltamos sin tirar nada.
// Antes el sync podía solaparse y generar race en vendor_sales_monthly.
let syncVentasInFlight = false;
if (hasSupabase()) {
    cron.schedule('*/30 * * * *', async () => {
        if (syncVentasInFlight) {
            console.warn('[cron syncVentas] skip · todavía está corriendo el anterior');
            return;
        }
        syncVentasInFlight = true;
        try {
            const r = await syncVentasMesActual();
            if (r.ok) {
                console.log(`[cron syncVentas] ok · ${r.comprobantes} comprob → ${r.clientes} clientes, ${r.vendedores} vendedores · ${r.elapsedMs}ms`);
            } else {
                console.error(`[cron syncVentas] FAIL · ${r.error}`);
            }
        } finally {
            syncVentasInFlight = false;
        }
    });
    if (process.env.SYNC_ON_START === 'true') {
        syncVentasMesActual()
            .then(r => console.log('[sync on start]', r))
            .catch(err => console.error('[sync on start] fallo:', err?.message ?? err));
    }
    console.log('Cron syncVentasMesActual: */30 * * * *');

    // Cron diario 4am: re-sync últimos 6 meses (mes actual + 5 anteriores).
    // Captura NCs tardías que afectan meses cerrados — sin esto, una NC del 30/04
    // que se carga el 02/05 nunca actualizaría el row de abril en vendor_sales_monthly.
    cron.schedule('0 4 * * *', async () => {
        try {
            const t0 = Date.now();
            const results = await syncVentasMeses(6);
            const ok = results.filter(r => r.ok).length;
            const fail = results.filter(r => !r.ok).length;
            const totComp = results.reduce((a, r) => a + (r.comprobantes || 0), 0);
            console.log(`[cron syncVentasMeses(6)] ${ok} ok / ${fail} fail · ${totComp} comprob · ${Date.now() - t0}ms`);
            if (fail > 0) {
                results.filter(r => !r.ok).forEach(r => console.error(`  fail ${r.label}: ${r.error}`));
            }
        } catch (err: any) {
            console.error(`[cron syncVentasMeses(6)] FAIL: ${err?.message ?? err}`);
        }
    });
    console.log('Cron syncVentasMeses(6): 0 4 * * *');
} else {
    console.log('Cron deshabilitado (Supabase no configurado)');
}

// Pre-warm del cache de /api/data cada 8 min — el cache vive 10 min, así que
// con */8 nos aseguramos refresco antes del expiry sin reventar IM con
// requests innecesarios. Antes era */4 (15 fetches/hora) que era overkill.
let prewarmInFlight = false;
cron.schedule('*/8 * * * *', async () => {
    if (prewarmInFlight) return;
    prewarmInFlight = true;
    try {
        const t0 = Date.now();
        await fetchData(true);
        console.log(`[cron pre-warm] /api/data refreshed in ${Date.now() - t0}ms`);
    } catch (err: any) {
        console.warn(`[cron pre-warm] fallo: ${err?.message ?? err}`);
    } finally {
        prewarmInFlight = false;
    }
});
// Primer pre-warm al arrancar el server (3s de delay para no competir con boot).
// PREWARM_BOOT=off lo apaga por env var (sin rebuild): escape para diagnóstico
// si el contenedor muere durante el arranque (ej. OOM). Los caches se ganan
// on-demand igual, solo que el primer request de cada cosa es más lento.
const PREWARM_BOOT = process.env.PREWARM_BOOT !== 'off';
if (PREWARM_BOOT) setTimeout(() => {
    fetchData(true)
        .then(() => console.log('[pre-warm on start] /api/data cache listo'))
        .catch(err => console.warn('[pre-warm on start] fallo:', err?.message));
    // Resolver de cod_cuenta desde /planes de InfoManager — evita env vars manuales
    import('./server-lib/cuentasResolver.js')
        .then(m => m.prewarmCuentasCache())
        .catch(err => console.warn('[pre-warm cuentas] fallo:', err?.message ?? err));
}, 3000);
else console.log('Pre-warm de boot DESACTIVADO (PREWARM_BOOT=off)');
console.log('Cron pre-warm /api/data: */8 * * * *');

// Pre-warm del snapshotCache: trae las ventas crudas de los últimos 3 meses
// a RAM para que el primer corte intra-mes que solicite el usuario sea
// instantáneo (sin esperar 3-5s por el fetch a InfoManager).
//
// TTL del snapshotCache es 5min para mes actual y 1h para histórico. Boot
// warm + cron horario mantienen siempre fresco lo histórico; el mes actual
// se reganará por demanda igualmente (tiene TTL corto a propósito).
async function prewarmSnapshotCache() {
    const now = new Date();
    // 6 meses: trimestre actual + trimestre anterior. Necesitamos los 6
    // calientes para que el endpoint /api/clientes/:cod/historial-compras
    // pueda calcular alertas (cliente sin comprar / producto en abandono) y
    // comparación contra el trimestre anterior sin cold fetches en el path
    // del usuario. El trimestre actual de igual modo lo usan /api/goals/snapshot
    // y /api/comisiones.
    const meses: Array<{ year: number; month: number }> = [];
    for (let i = 0; i < 6; i++) {
        let m = now.getUTCMonth() + 1 - i;
        let y = now.getUTCFullYear();
        while (m <= 0) { m += 12; y -= 1; }
        meses.push({ year: y, month: m });
    }
    // SECUENCIAL, del mes más reciente al más viejo. Antes iba en dos fases de
    // 3 meses en paralelo (6 fetches gordos de ventas+items en vuelo a la vez):
    // ese pico de RAM ~15-20s post-boot coincidía con el crash-loop del 06/07
    // (OOM sospechado). Secuencial tarda más el warm frío (~2-3 min) pero el
    // pico de memoria es 1 mes en vez de 3, y los endpoints igual se ganan el
    // cache on-demand con stale-while-revalidate mientras tanto.
    async function warmMes({ year, month }: { year: number; month: number }) {
        try {
            const t0 = Date.now();
            const [r, ri] = await Promise.all([
                getMonthlyVentasRaw(year, month, { force: true }),
                getMonthlyItemsRaw(year, month, { force: true }),
            ]);
            console.log(`[snapshot prewarm] ${year}-${String(month).padStart(2, '0')}: ${r.ventas.length} ventas + ${ri.items.length} items en ${Date.now() - t0}ms`);
        } catch (e: any) {
            console.warn(`[snapshot prewarm] ${year}-${String(month).padStart(2, '0')} fail: ${e?.message ?? e}`);
        }
    }
    for (const mes of meses) await warmMes(mes);
    // Catálogo de artículos (precio_venta + cod_rubro) para comisiones.
    try {
        const t0 = Date.now();
        const m = await fetchArticulosCatalogo(true);
        console.log(`[snapshot prewarm] articulos catalogo: ${m.size} en ${Date.now() - t0}ms`);
    } catch (e: any) {
        console.warn(`[snapshot prewarm] articulos catalogo fail: ${e?.message ?? e}`);
    }
}
// Boot warm con delay 60s: escalonado respecto del pre-warm de /api/data (+3s)
// para que los dos picos de memoria/red no se sumen durante el arranque.
// También respeta PREWARM_BOOT=off como escape sin rebuild.
if (PREWARM_BOOT) setTimeout(() => { prewarmSnapshotCache().catch(() => { }); }, 60_000);
// Cron cada 20 min: refresca los 6 meses agresivamente para que el cache
// histórico (TTL 24h) y el actual (TTL 5min) nunca lleguen vencidos a un
// request real. Combinado con stale-while-revalidate en snapshotCache, esto
// elimina cold fetches sincrónicos en el path del usuario.
cron.schedule('*/20 * * * *', () => { prewarmSnapshotCache().catch(() => { }); });
console.log('Cron snapshot prewarm: */20 * * * *');

// MP verification — reintenta comprobantes MP pendientes/no encontrados en ventana 24h
cron.schedule('*/5 * * * *', async () => {
    try {
        const r = await procesarColaMP(20);
        if (r.procesados > 0) {
            console.log(`[cron MP] procesados=${r.procesados} verificados=${r.verificados} ambiguos=${r.ambiguos}`);
        }
    } catch (err: any) {
        console.warn(`[cron MP] fallo: ${err?.message ?? err}`);
    }
});
console.log('Cron MP verify: */5 * * * *');

// ─── Cron: disparar Web Push de recordatorios vencidos ───────────────────────
// Cada minuto chequea promesas con fecha+hora <= now y push_notificado_at IS NULL.
// Solo arranca si VAPID está configurado. Lock contra overlap por las dudas.
let pushInFlight = false;
if (hasSupabase()) {
    cron.schedule('* * * * *', async () => {
        if (pushInFlight) return;
        pushInFlight = true;
        try {
            if (!isWebPushEnabled()) return;
            const r = await dispararRecordatoriosPromesa();
            lastPushCronAt = new Date();
            lastPushCronResult = r;
            // Log siempre (no solo cuando hay candidatos) para confirmar que el
            // cron está vivo. Volumen bajo: 1 línea/minuto.
            console.log(`[cron push] ${new Date().toISOString()} candidatos=${r.candidatos} enviados=${r.enviados} fallidos=${r.fallidos} sinSub=${r.sinSub}`);
        } catch (err: any) {
            console.warn(`[cron push] fallo: ${err?.message ?? err}`);
        } finally {
            pushInFlight = false;
        }
    });
    console.log('Cron push recordatorios: * * * * *');
}

// ─── Cron: caducar recibos en pendiente_revision >30 días ────────────────────
// Diario 09:00. Evita que un comprobante quede colgado sin imputar para siempre
// (plata pagada que nunca se acreditó). Pasa a 'error' con motivo [CADUCADO]
// claro y reversible para que el admin lo reprocese o descarte.
if (hasSupabase()) {
    cron.schedule('0 9 * * *', async () => {
        try {
            const r = await caducarRecibosPendientes(30);
            if (r.caducados > 0) console.log(`[cron caducar recibos] ${r.caducados} recibo(s) caducado(s)`);
        } catch (err: any) {
            console.warn(`[cron caducar recibos] fallo: ${err?.message ?? err}`);
        }
    });
    console.log('Cron caducar recibos pendientes: 0 9 * * *');
}

// ─── Cron: snapshot diario de la cta cte para Conciliación ───────────────────
// 23:50 ART con timezone EXPLÍCITA (autodocumenta y no depende del TZ del
// host). Los demás crons del archivo quedan en la convención UTC histórica.
// Guarda la foto del reporte comprob_pendientes de IM en conciliacion_snapshot
// para que el "Cruce carpeta" pueda usar cortes EXACTOS a cualquier fecha.
// Idempotente: upsert por (empresa, fecha) — correrlo dos veces pisa la foto.
if (hasSupabase()) {
    cron.schedule('50 23 * * *', async () => {
        try {
            const r = await guardarSnapshotConciliacion(1);
            if (r.guardado) console.log(`[cron snapshot conciliacion] ${r.fecha}: ${r.n_rows} filas`);
            else console.warn(`[cron snapshot conciliacion] ${r.fecha}: IM devolvió 0 filas, snapshot NO guardado`);
        } catch (err: any) {
            console.warn(`[cron snapshot conciliacion] fallo: ${err?.message ?? err}`);
        }
    }, { timezone: 'America/Argentina/Buenos_Aires' });
    console.log('Cron snapshot conciliacion: 50 23 * * * (America/Argentina/Buenos_Aires)');
}

