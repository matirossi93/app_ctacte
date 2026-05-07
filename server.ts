import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
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
  findUsuarioByEmail, signJwt, verifyJwt, sha256hex, usuarioToJwtPayload,
  requireAdmin,
  type JwtPayload
} from './server-lib/auth.js';
import { hasSupabase, sb, TENANT_ID } from './server-lib/supabase.js';
import { syncVentasMesActual, syncVentasMeses } from './server-lib/syncVentas.js';
import { getMonthlyVentasRaw, getMonthlyItemsRaw } from './server-lib/snapshotCache.js';
import { fetchArticulosCatalogo } from './server-lib/infomanager.js';
import {
  uploadRecibo, listRecibos, getReciboById, facturasCandidatas, aprobarRecibo, rechazarRecibo, cuentasDebug, cuentasRefresh,
  reverificarMP, elegirMatchMP, procesarColaMP
} from './server-lib/recibos.js';
import { listGoals, setGoal, syncVentasNow, setMonthConfig, listClientesObjetivo, debugClienteAvance, getGoalsSnapshot, rawRows } from './server-lib/goals.js';
import { listComisiones, probeVenta, comisionesSample, topArticulos, facturasVendedor, diagnoseArticulo, diffGoalsVsComisiones } from './server-lib/comisiones.js';
import { listClientesLookup } from './server-lib/clientes.js';
import { listActivity, createActivity, updateActivity, deleteActivity } from './server-lib/activity.js';
import {
  listUsuarios, createUsuario, updateUsuario, deleteUsuario, changePassword
} from './server-lib/usuarios.js';
import { importMaestroClientes } from './server-lib/sheetImport.js';
import { descargarReporte } from './server-lib/reportes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 80;

app.use(cors());
// gzip JSON responses (reduce ~80% el payload de /api/data y similares).
app.use(compression({ threshold: 1024 }));
app.use(express.json());

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
const IM_CLIENT_SECRET = process.env.INFOMANAGER_CLIENT_SECRET || 'e4MCtm6L_PzdnTL';

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
    const invoicePromises = empresas.map(e =>
        axios.get(`${IM_BASE_URL}/reportes/comprob_pendientes_clientes?tag=todos&codCliente=0&codEmpresa=${e}`, { headers, timeout: 60000 })
    );
    const [vendedoresRes, clientsSheetRes, ...invoiceResults] = await Promise.all([
        axios.get(`${IM_BASE_URL}/vendedores`, { headers, timeout: 15000 }),
        axios.get(CLIENTS_URL, { responseType: 'text', timeout: 30000, maxRedirects: 10 }).catch(() => null),
        ...invoicePromises,
    ]);

    // Build vendedor lookup
    const vendedorMap = new Map<number, string>();
    (vendedoresRes.data as any[]).forEach((v: any) => {
        vendedorMap.set(v.cod_vendedor, v.nombre);
    });

    // Build clientDb from Google Sheet (for Localidad/Frecuencia — IM doesn't have these)
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
        const hash = sha256hex(password);
        if (hash !== user.password_hash) { res.status(401).json({ success: false, error: 'Credenciales inválidas' }); return; }
        loginAttempts.delete(ip);
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

app.get('/api/me', requireJwt, (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    res.json({ ok: true, user: req.user });
});

// ─── Recibos ──────────────────────────────────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.post('/api/recibos/upload', requireJwt, upload.single('foto'), (req: any, res) => uploadRecibo(req, res));
app.get('/api/recibos', requireJwt, (req: any, res) => listRecibos(req, res));
app.get('/api/recibos/:id', requireJwt, (req: any, res) => getReciboById(req, res));
app.get('/api/recibos/:id/facturas-candidatas', requireJwt, (req: any, res) => facturasCandidatas(req, res));
app.post('/api/recibos/:id/aprobar', requireJwt, (req: any, res) => aprobarRecibo(req, res));
app.post('/api/recibos/:id/rechazar', requireJwt, (req: any, res) => rechazarRecibo(req, res));
app.post('/api/recibos/:id/reverificar-mp', requireJwt, (req: any, res) => reverificarMP(req, res));
app.post('/api/recibos/:id/elegir-match', requireJwt, (req: any, res) => elegirMatchMP(req, res));

// Reportes admin-only (xlsx)
app.get('/api/reportes/:tipo', requireJwt, (req: any, res) => descargarReporte(req, res));
app.get('/api/cuentas/debug', requireJwt, (req: any, res) => cuentasDebug(req, res));
app.post('/api/cuentas/refresh', requireJwt, (req: any, res) => cuentasRefresh(req, res));

// ─── Objetivos ───────────────────────────────────────────────────────────────
app.get('/api/goals', requireJwt, (req: any, res) => listGoals(req, res));
app.get('/api/goals/raw-rows', requireJwt, requireAdmin, (req: any, res) => rawRows(req, res));
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
app.get('/api/comisiones/probe-venta/:id', requireJwt, requireAdmin, (req: any, res) => probeVenta(req, res));
app.get('/api/comisiones/sample', requireJwt, requireAdmin, (req: any, res) => comisionesSample(req, res));
app.get('/api/comisiones/top-articulos', requireJwt, requireAdmin, (req: any, res) => topArticulos(req, res));
app.get('/api/comisiones/facturas-vendedor', requireJwt, requireAdmin, (req: any, res) => facturasVendedor(req, res));
app.get('/api/comisiones/diagnose-articulo/:cod', requireJwt, requireAdmin, (req: any, res) => diagnoseArticulo(req, res));
app.get('/api/comisiones/diff-goals', requireJwt, requireAdmin, (req: any, res) => diffGoalsVsComisiones(req, res));

// ─── Clientes lookup (maestro completo, con y sin deuda) ─────────────────────
app.get('/api/clientes/lookup', requireJwt, (req: any, res) => listClientesLookup(req, res));

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

// ─── Gestión de usuarios ─────────────────────────────────────────────────────
app.get('/api/usuarios', requireJwt, requireAdmin, (req: any, res) => listUsuarios(req, res));
app.post('/api/usuarios', requireJwt, requireAdmin, (req: any, res) => createUsuario(req, res));
app.put('/api/usuarios/:id', requireJwt, requireAdmin, (req: any, res) => updateUsuario(req, res));
app.delete('/api/usuarios/:id', requireJwt, requireAdmin, (req: any, res) => deleteUsuario(req, res));
app.post('/api/usuarios/change-password', requireJwt, (req: any, res) => changePassword(req, res));

// ─── Import sheet Maestro Clientes ───────────────────────────────────────────
app.post('/api/sheet-import/maestro-clientes', requireJwt, requireAdmin, upload.single('file'),
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

// ─── Bot API (public) ─────────────────────────────────────────────────────────
// Accepts optional ?rate=0.10 query param (default 10%)
app.get('/api/bot', async (req: express.Request, res: express.Response) => {
    try {
        const interestRate = Math.min(1, Math.max(0, parseFloat(req.query.rate as string) || 0.10));
        const data = await fetchData();

        let invoicesRaw: any[];
        const clientDbMap = new Map<string, { localidad: string; frecuencia: string }>();

        if (data.source === 'infomanager') {
            invoicesRaw = data.invoices;
            // clientDbMap from normalized data
            Object.entries(data.clientDbMap).forEach(([cod, c]: [string, any]) => {
                clientDbMap.set(cod, {
                    localidad: c.Localidad || '',
                    frecuencia: c.Frecuencia || 'MENSUAL'
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
                        frecuencia: c.Frecuencia?.trim() || 'MENSUAL'
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
            let threshold = 15;
            if (clientDb?.frecuencia === 'SEMANAL') threshold = 7;
            else if (clientDb?.frecuencia === 'MENSUAL') threshold = 30;

            const isOverdue = type === 'FA' && diffDays > threshold;
            const balance = parseNum(raw.SALDO);
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
            if (diffDays > c.maxDaysOverdue) c.maxDaysOverdue = diffDays;
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

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Auth: ${APP_PASSWORD ? 'ENABLED' : 'disabled — set APP_PASSWORD env var to enable'}`);
    console.log(`Data source: ${DATA_SOURCE}${DATA_SOURCE === 'infomanager' ? ' (with Sheets fallback)' : ''}`);
    console.log(`Supabase: ${hasSupabase() ? 'ENABLED' : 'disabled'}`);
});

// ─── Crons ────────────────────────────────────────────────────────────────────
if (hasSupabase()) {
    cron.schedule('*/30 * * * *', async () => {
        const r = await syncVentasMesActual();
        if (r.ok) {
            console.log(`[cron syncVentas] ok · ${r.comprobantes} comprob → ${r.clientes} clientes, ${r.vendedores} vendedores · ${r.elapsedMs}ms`);
        } else {
            console.error(`[cron syncVentas] FAIL · ${r.error}`);
        }
    });
    if (process.env.SYNC_ON_START === 'true') {
        syncVentasMesActual().then(r => console.log('[sync on start]', r));
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

// Pre-warm del cache de /api/data cada 4 min — así el cache (TTL 10 min)
// nunca entra en cold. Los vendedores siempre pegan a cache caliente.
cron.schedule('*/4 * * * *', async () => {
    try {
        const t0 = Date.now();
        await fetchData(true);
        console.log(`[cron pre-warm] /api/data refreshed in ${Date.now() - t0}ms`);
    } catch (err: any) {
        console.warn(`[cron pre-warm] fallo: ${err?.message ?? err}`);
    }
});
// Primer pre-warm al arrancar el server (3s de delay para no competir con boot).
setTimeout(() => {
    fetchData(true)
        .then(() => console.log('[pre-warm on start] /api/data cache listo'))
        .catch(err => console.warn('[pre-warm on start] fallo:', err?.message));
    // Resolver de cod_cuenta desde /planes de InfoManager — evita env vars manuales
    import('./server-lib/cuentasResolver.js').then(m => m.prewarmCuentasCache());
}, 3000);
console.log('Cron pre-warm /api/data: */4 * * * *');

// Pre-warm del snapshotCache: trae las ventas crudas de los últimos 3 meses
// a RAM para que el primer corte intra-mes que solicite el usuario sea
// instantáneo (sin esperar 3-5s por el fetch a InfoManager).
//
// TTL del snapshotCache es 5min para mes actual y 1h para histórico. Boot
// warm + cron horario mantienen siempre fresco lo histórico; el mes actual
// se reganará por demanda igualmente (tiene TTL corto a propósito).
async function prewarmSnapshotCache() {
    const now = new Date();
    const meses: Array<{ year: number; month: number }> = [];
    for (let i = 0; i < 3; i++) {
        let m = now.getUTCMonth() + 1 - i;
        let y = now.getUTCFullYear();
        while (m <= 0) { m += 12; y -= 1; }
        meses.push({ year: y, month: m });
    }
    for (const { year, month } of meses) {
        try {
            const t0 = Date.now();
            // force:true para refrescar incluso si el TTL todavía no expiró
            // (mantiene el cache caliente sin huecos).
            // Ventas + items en paralelo: items son necesarios para /api/comisiones
            // y la primera carga de un mes es lenta (varios miles de líneas).
            const [r, ri] = await Promise.all([
                getMonthlyVentasRaw(year, month, { force: true }),
                getMonthlyItemsRaw(year, month, { force: true }),
            ]);
            console.log(`[snapshot prewarm] ${year}-${String(month).padStart(2, '0')}: ${r.ventas.length} ventas + ${ri.items.length} items en ${Date.now() - t0}ms`);
        } catch (e: any) {
            console.warn(`[snapshot prewarm] ${year}-${String(month).padStart(2, '0')} fail: ${e?.message ?? e}`);
        }
    }
    // Catálogo de artículos (precio_venta + cod_rubro) para comisiones.
    try {
        const t0 = Date.now();
        const m = await fetchArticulosCatalogo(true);
        console.log(`[snapshot prewarm] articulos catalogo: ${m.size} en ${Date.now() - t0}ms`);
    } catch (e: any) {
        console.warn(`[snapshot prewarm] articulos catalogo fail: ${e?.message ?? e}`);
    }
}
// Boot warm con delay 12s para no competir con el resto del startup.
setTimeout(() => { prewarmSnapshotCache().catch(() => { }); }, 12000);
// Cron horario en el minuto 5 (después del posible cron 0 4 * * * que re-syncea).
cron.schedule('5 * * * *', () => { prewarmSnapshotCache().catch(() => { }); });
console.log('Cron snapshot prewarm: 5 * * * *');

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
