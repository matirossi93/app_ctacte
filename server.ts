import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import pkg from 'papaparse';
const { parse } = pkg;
import axios from 'axios';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 80;

app.use(cors());

// Google Sheets URLs
const INVOICES_URL = 'https://docs.google.com/spreadsheets/d/1UMtdGkn7GTAIAZ8De9nWxYQThM6YruzVf1-W757xYmQ/export?format=csv&id=1UMtdGkn7GTAIAZ8De9nWxYQThM6YruzVf1-W757xYmQ&gid=0';
const CLIENTS_URL = 'https://docs.google.com/spreadsheets/d/1k7B8Phi5QDn_6mFWiAfYBcqqisEWT6nqUwgmhE54Zy8/export?format=csv&id=1k7B8Phi5QDn_6mFWiAfYBcqqisEWT6nqUwgmhE54Zy8&gid=0';

// API Route for Bot
app.get('/api/bot', async (req, res) => {
    try {
        const [invoicesRes, clientsRes] = await Promise.all([
            axios.get(INVOICES_URL, { responseType: 'text' }),
            axios.get(CLIENTS_URL, { responseType: 'text' })
        ]);

        const clientsRaw = parse(clientsRes.data, { header: true, skipEmptyLines: true }).data;
        const invoicesRaw = parse(invoicesRes.data, { header: true, skipEmptyLines: true }).data;

        // Build Client Map
        const clientDbMap = new Map();
        clientsRaw.forEach((c: any) => {
            if (c.COD_CLIENT) {
                clientDbMap.set(c.COD_CLIENT.toString().trim(), {
                    localidad: c.LOCALIDAD?.trim() || '',
                    frecuencia: c.Frecuencia?.trim() || 'MENSUAL'
                });
            }
        });

        // Variables for calculation
        const interestRate = 0.10;
        const vendorsMap = new Map();

        // Safe Number parser
        const parseNum = (val: any) => {
            if (!val) return 0;
            if (typeof val === 'number') return val;
            let clean = val.toString().replace(/^\$/, '').trim();
            if (clean.includes(',') && clean.includes('.')) {
                clean = clean.replace(/\./g, '').replace(',', '.');
            } else if (clean.includes(',')) {
                clean = clean.replace(',', '.');
            }
            const parsed = Number(clean);
            return isNaN(parsed) ? 0 : parsed;
        };

        // Date helper (similar to frontend)
        const parseRefDate = (dateStr: string) => {
            if (!dateStr) return new Date();
            const parts = dateStr.split('/');
            if (parts.length === 3) {
                return new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
            }
            return new Date(dateStr);
        };

        const today = new Date();
        const normalizeDate = (d: Date) => {
            d.setHours(0, 0, 0, 0);
            return d;
        };

        const clientsByVendor = new Map();

        invoicesRaw.forEach((raw: any) => {
            const dateStr = String(raw.FECHA || raw[''] || '');
            if (!dateStr || dateStr.toLowerCase() === 'undefined') return;

            const invoiceDate = normalizeDate(parseRefDate(dateStr));
            let daysOverdue = Math.floor((normalizeDate(new Date()).getTime() - invoiceDate.getTime()) / (1000 * 60 * 60 * 24));
            
            const clientId = String(raw.COD_CLIENT || raw['12'] || '');
            const clientName = String(raw.NOMBRE || '');
            const vendorName = String(raw.VENDEDOR || '');
            if (!clientId || !clientName) return;

            const clientDb = clientDbMap.get(clientId);
            let defaultThreshold = 15;
            if (clientDb?.frecuencia === 'SEMANAL') defaultThreshold = 7;
            else if (clientDb?.frecuencia === 'MENSUAL') defaultThreshold = 30;

            const applyInterest = daysOverdue > defaultThreshold;
            const originalAmount = parseNum(raw.SALDO);
            const interestAmount = applyInterest ? originalAmount * interestRate : 0;
            const totalAmount = originalAmount + interestAmount;

            if (!vendorsMap.has(vendorName)) {
                vendorsMap.set(vendorName, new Map());
            }
            
            const vendorClients = vendorsMap.get(vendorName);
            if (!vendorClients.has(clientId)) {
                vendorClients.set(clientId, {
                    clientName,
                    clientId,
                    localidad: clientDb?.localidad || '',
                    maxDaysOverdue: 0,
                    totalBalance: 0,
                    totalInterest: 0,
                    totalWithInterest: 0,
                    invoices: []
                });
            }

            const clientAgg = vendorClients.get(clientId);
            if (daysOverdue > clientAgg.maxDaysOverdue) clientAgg.maxDaysOverdue = daysOverdue;
            clientAgg.totalBalance += originalAmount;
            clientAgg.totalInterest += interestAmount;
            clientAgg.totalWithInterest += totalAmount;
            
            clientAgg.invoices.push({
                type: String(raw.TIPO || ''),
                invoiceNumber: String(raw.NRO_COMP || ''),
                date: dateStr,
                daysOverdue,
                originalAmount,
                interestAmount,
                totalWithInterest: totalAmount,
                isOverdue: applyInterest
            });
        });

        // Format to JSON identical to frontend
        const resultVendorsMap = new Map();
        
        vendorsMap.forEach((clientsMap, vendorName) => {
            const locationsMap = new Map();
            Array.from(clientsMap.values()).forEach((c: any) => {
                if (c.totalBalance > 0 || c.totalWithInterest > 0) {
                    const loc = c.localidad || 'Sin Localidad';
                    if (!locationsMap.has(loc)) locationsMap.set(loc, []);
                    
                    locationsMap.get(loc).push({
                        nombre: c.clientName,
                        codigo_cliente: c.clientId,
                        maximos_dias_atraso: c.maxDaysOverdue,
                        saldo_original: c.totalBalance,
                        saldo_con_intereses: c.totalWithInterest,
                        cantidad_facturas: c.invoices.length,
                        facturas: c.invoices.map((i: any) => ({
                            numero: `${i.type} ${i.invoiceNumber}`,
                            fecha_emision: i.date,
                            dias_vencida: i.daysOverdue,
                            interes_aplicado: i.interestAmount,
                            total_a_cobrar: i.totalWithInterest
                        }))
                    });
                }
            });

            const localidades: any[] = [];
            locationsMap.forEach((clientes, nombre_localidad) => {
                localidades.push({
                    localidad: nombre_localidad,
                    total_clientes_deudores: clientes.length,
                    clientes: clientes.sort((a: any, b: any) => b.saldo_con_intereses - a.saldo_con_intereses)
                });
            });

            if (localidades.length > 0) {
                resultVendorsMap.set(vendorName, localidades);
            }
        });

        const reporteVendedores = Array.from(resultVendorsMap.entries()).map(([vendedor, localidades]) => ({
            vendedor,
            localidades
        }));

        res.json({
            status: "success",
            timestamp: new Date().toISOString(),
            tasa_interes_aplicada: "10%",
            reporte_vendedores: reporteVendedores
        });

    } catch (err: any) {
        console.error(err);
        res.status(500).json({ status: "error", message: err.message });
    }
});

// Serve frontend
app.use(express.static(path.join(__dirname, '..', 'dist')));

// Fallback for React Router
app.use((req, res) => {
    res.sendFile(path.join(__dirname, '..', 'dist', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
