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

// ─── Google Sheets URLs (server-only) ─────────────────────────────────────────
// Use the same simple format that worked when the browser fetched directly
const INVOICES_URL = process.env.INVOICES_URL ||
    'https://docs.google.com/spreadsheets/d/1UMtdGkn7GTAIAZ8De9nWxYQThM6YruzVf1-W757xYmQ/export?format=csv';
const CLIENTS_URL = process.env.CLIENTS_URL ||
    'https://docs.google.com/spreadsheets/d/1k7B8Phi5QDn_6mFWiAfYBcqqisEWT6nqUwgmhE54Zy8/export?format=csv';

// ─── Auth ──────────────────────────────────────────────────────────────────────
const APP_PASSWORD = process.env.APP_PASSWORD;
const TOKEN_TTL = 8 * 60 * 60 * 1000; // 8 hours
const validTokens = new Map<string, number>(); // token → expiry timestamp

const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    if (!APP_PASSWORD) { next(); return; } // Auth disabled when no password configured
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) { res.status(401).json({ error: 'No autorizado' }); return; }
    const token = auth.slice(7);
    const expiry = validTokens.get(token);
    if (!expiry || Date.now() > expiry) { res.status(401).json({ error: 'Sesión expirada' }); return; }
    next();
};

app.post('/api/auth/login', (req: express.Request, res: express.Response) => {
    const { password } = req.body as { password?: string };
    if (!APP_PASSWORD || password === APP_PASSWORD) {
        const token = randomUUID();
        validTokens.set(token, Date.now() + TOKEN_TTL);
        // Cleanup expired tokens
        for (const [t, exp] of validTokens.entries()) {
            if (Date.now() > exp) validTokens.delete(t);
        }
        res.json({ success: true, token, authRequired: !!APP_PASSWORD });
        return;
    }
    res.status(401).json({ success: false, error: 'Contraseña incorrecta' });
});

app.get('/api/auth/check', requireAuth, (_req: express.Request, res: express.Response) => {
    res.json({ valid: true, authRequired: !!APP_PASSWORD });
});

// ─── Data Proxy (Google Sheets URLs remain server-side only) ──────────────────
app.get('/api/data', requireAuth, async (_req: express.Request, res: express.Response) => {
    try {
        const [invoicesRes, clientsRes] = await Promise.all([
            axios.get(INVOICES_URL, { responseType: 'text', timeout: 30000, maxRedirects: 10 }),
            axios.get(CLIENTS_URL, { responseType: 'text', timeout: 30000, maxRedirects: 10 })
        ]);
        res.json({ invoices: invoicesRes.data, clients: clientsRes.data });
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

// ─── Bot API (public — used by external chatbots/automations) ────────────────
app.get('/api/bot', async (_req: express.Request, res: express.Response) => {
    try {
        const [invoicesRes, clientsRes] = await Promise.all([
            axios.get(INVOICES_URL, { responseType: 'text', timeout: 30000, maxRedirects: 10 }),
            axios.get(CLIENTS_URL, { responseType: 'text', timeout: 30000, maxRedirects: 10 })
        ]);

        const clientsRaw = parse(clientsRes.data, { header: true, skipEmptyLines: true }).data as any[];
        const invoicesRaw = parse(invoicesRes.data, { header: true, skipEmptyLines: true }).data as any[];

        // Build client map — same field names as InvoiceRaw / calculations.ts
        const clientDbMap = new Map<string, { localidad: string; frecuencia: string }>();
        clientsRaw.forEach((c: any) => {
            const cod = c.Cod?.toString().trim() || c.COD_CLIENT?.toString().trim();
            if (cod) {
                clientDbMap.set(cod, {
                    localidad: c.Localidad?.trim() || c.LOCALIDAD?.trim() || '',
                    frecuencia: c.Frecuencia?.trim() || 'MENSUAL'
                });
            }
        });

        const interestRate = 0.10;

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
            // Use correct field names (same as InvoiceRaw type in calculations.ts)
            const clientId = String(raw['12'] || raw.COD_CLIENT || '').trim();
            const clientName = String(raw.CLIENTES_N || '').trim();
            const vendorName = String(raw.VENDEDORES || '').trim();
            const type = String(raw.TIPO_COMPR || '').toUpperCase();
            if (!clientId || !clientName || !vendorName) return;

            const emissionDateStr = String(raw.FECHA || raw[''] || '');
            let diffDays = 0;
            if (emissionDateStr.includes('/')) {
                const d = parseDate(emissionDateStr); d.setHours(0, 0, 0, 0);
                diffDays = Math.max(0, Math.floor((today.getTime() - d.getTime()) / 86400000));
            }

            const clientDb = clientDbMap.get(clientId);
            let threshold = 15;
            if (clientDb?.frecuencia === 'SEMANAL') threshold = 7;
            else if (clientDb?.frecuencia === 'MENSUAL') threshold = 30;

            const isOverdue = type !== 'NC' && diffDays > threshold;
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
            tasa_interes_aplicada: '10%',
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
    if (APP_PASSWORD) {
        console.log('Auth: ENABLED (APP_PASSWORD set)');
    } else {
        console.log('Auth: disabled — set APP_PASSWORD env var to enable');
    }
});
