import 'dotenv/config';
import express from 'express';
import cors from 'cors';
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
import { hasSupabase } from './server-lib/supabase.js';
import { syncVentasMesActual } from './server-lib/syncVentas.js';
import {
  uploadRecibo, listRecibos, facturasCandidatas, aprobarRecibo, rechazarRecibo
} from './server-lib/recibos.js';
import { listGoals, setGoal, syncVentasNow, setMonthConfig, listClientesObjetivo, debugClienteAvance } from './server-lib/goals.js';
import { listActivity, createActivity, deleteActivity } from './server-lib/activity.js';
import {
  listUsuarios, createUsuario, updateUsuario, deleteUsuario, changePassword
} from './server-lib/usuarios.js';
import { importMaestroClientes } from './server-lib/sheetImport.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 80;

app.use(cors());
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
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
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
app.get('/api/recibos/:id/facturas-candidatas', requireJwt, (req: any, res) => facturasCandidatas(req, res));
app.post('/api/recibos/:id/aprobar', requireJwt, (req: any, res) => aprobarRecibo(req, res));
app.post('/api/recibos/:id/rechazar', requireJwt, (req: any, res) => rechazarRecibo(req, res));

// ─── Objetivos ───────────────────────────────────────────────────────────────
app.get('/api/goals', requireJwt, (req: any, res) => listGoals(req, res));
app.post('/api/goals', requireJwt, (req: any, res) => setGoal(req, res));
app.post('/api/goals/sync-now', requireJwt, (req: any, res) => syncVentasNow(req, res));
app.post('/api/month-config', requireJwt, (req: any, res) => setMonthConfig(req, res));
app.get('/api/goals/clientes', requireJwt, (req: any, res) => listClientesObjetivo(req, res));
app.get('/api/goals/debug-cliente/:cod', requireJwt, requireAdmin, (req: any, res) => debugClienteAvance(req, res));

// ─── Actividad ───────────────────────────────────────────────────────────────
app.get('/api/activity', requireJwt, (req: any, res) => listActivity(req, res));
app.post('/api/activity', requireJwt, (req: any, res) => createActivity(req, res));
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
        const userRol = req.user?.rol;
        let filterCodVend: number | null = null;
        if (userRol === 'vendedor') {
            filterCodVend = req.user!.cod_vendedor ?? -1;
        } else if (req.query.cod_vendedor) {
            const n = Number(req.query.cod_vendedor);
            if (n > 0) filterCodVend = n;
        }
        // IMPORTANTE: `data` es el cache compartido. NO mutar data.invoices.
        // Se construye una respuesta nueva con invoices filtrados si aplica.
        let responseInvoices = data.invoices;
        if (filterCodVend != null && data.source === 'infomanager' && Array.isArray(data.invoices)) {
            const vkey = userRol === 'vendedor' ? (req.user?.vendedor_key ?? '').toLowerCase() : '';
            responseInvoices = data.invoices.filter((inv: any) => {
                if (String(inv.COD_VENDED) === String(filterCodVend)) return true;
                if (vkey && String(inv.VENDEDORES || '').toLowerCase().includes(vkey)) return true;
                return false;
            });
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
} else {
    console.log('Cron deshabilitado (Supabase no configurado)');
}
