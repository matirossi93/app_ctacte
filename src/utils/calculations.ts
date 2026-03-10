import type { InvoiceRaw, Invoice, VendorSummary, ClientDBType } from '../types';

export const processInvoices = (
    rawInvoices: InvoiceRaw[],
    interestRate: number,
    clientThresholds: Record<string, number> = {},
    clientDbMap: Map<string, ClientDBType> = new Map()
): VendorSummary[] => {
    // Basic sanity check to avoid parsing headers or empty rows incorrectly.
    // In the new CSV, COD_CLIENT is under column '12'
    const validInvoices = rawInvoices.filter(raw => (raw['12'] || raw.COD_CLIENT) && raw.COD_VENDED && raw.SALDO !== undefined);

    // 1. Map raw to clean structured items
    const allMappedInvoices: Invoice[] = validInvoices.map(raw => {
        const rawClientId = raw['12'] || raw.COD_CLIENT;
        const clientId = String(rawClientId);
        
        // Get client from DB
        const clientDbDetails = clientDbMap.get(clientId);
        
        // Determine system threshold based on Frecuencia
        let defaultThreshold = 0;
        if (clientDbDetails?.Frecuencia) {
            const freq = clientDbDetails.Frecuencia.toUpperCase();
            if (freq.includes('SEMANAL')) defaultThreshold = 7;
            else if (freq.includes('QUINCENAL')) defaultThreshold = 15;
            else if (freq.includes('MENSUAL')) defaultThreshold = 30;
        }

        // Custom threshold overrides the default system threshold
        const customThreshold = clientThresholds[clientId] || defaultThreshold;

        // If 'DIAS DEUDA' is a number and > 0, it means the invoice is overdue based on the client's term
        // USER UPDATE: If customThreshold is set, use DIAS_EMISI vs customThreshold
        let isOverdue = false;
        let daysOverdue = 0;

        if (customThreshold !== undefined && customThreshold > 0) {
            const diasmEmi = Number(raw.DIAS_EMISI) || 0;
            isOverdue = diasmEmi > customThreshold;
            daysOverdue = isOverdue ? diasmEmi - customThreshold : 0;
        } else {
            isOverdue = typeof raw['DIAS DEUDA'] === 'number' ? raw['DIAS DEUDA'] > 0 : false;
            daysOverdue = typeof raw['DIAS DEUDA'] === 'number' ? Math.max(0, raw['DIAS DEUDA']) : 0;
        }

        // Parse Argentine currency format (e.g., "$1.415.035,00" or "4026125" strings/numbers)
        const parseCurrency = (val: any): number => {
            if (typeof val === 'number') return val;
            if (!val) return 0;
            const strVal = String(val).replace(/\$/g, '').replace(/\./g, '').replace(',', '.').trim();
            const parsed = Number(strVal);
            return isNaN(parsed) ? 0 : parsed;
        };

        const balance = parseCurrency(raw.SALDO);

        // The user rules: "10% interest on balance once the days of debt are reached"
        const appliedInterestRate = isOverdue ? interestRate : 0;
        const interestAmount = balance * appliedInterestRate;

        return {
            clientId: String(raw['12'] || raw.COD_CLIENT),
            clientName: String(raw.CLIENTES_N),
            vendorId: String(raw.COD_VENDED),
            vendorName: String(raw.VENDEDORES),
            invoiceNumber: String(raw.NUMERO),
            id: String(raw.ID),
            date: String(raw.FECHA),
            totalStr: String(raw.TOTAL),
            balance,
            type: String(raw.TIPO_COMPR),
            daysEmission: Number(raw.DIAS_EMISI) || 0,
            daysOverdue,
            isOverdue,
            interestRate: appliedInterestRate,
            interestAmount,
            totalWithInterest: balance + interestAmount
        };
    });

    // Remove null or negligible balances to clean up the view (filters out $0, $0.01 etc.)
    const invoices = allMappedInvoices.filter(inv => inv.balance > 1);

    // 2. Group by Vendor
    const vendorMap = new Map<string, VendorSummary>();

    invoices.forEach(inv => {
        if (!vendorMap.has(inv.vendorId)) {
            vendorMap.set(inv.vendorId, {
                vendorId: inv.vendorId,
                vendorName: inv.vendorName,
                totalBalance: 0,
                totalInterest: 0,
                totalWithInterest: 0,
                clients: []
            });
        }

        const vendorSummary = vendorMap.get(inv.vendorId)!;

        // Find client inside this vendor
        let clientSummary = vendorSummary.clients.find(c => c.clientId === inv.clientId);
        if (!clientSummary) {
            const dbDetails = clientDbMap.get(inv.clientId);
            
            // Determine default threshold for reporting/UI
            let defaultThreshold = 0;
            if (dbDetails?.Frecuencia) {
                const freq = dbDetails.Frecuencia.toUpperCase();
                if (freq.includes('SEMANAL')) defaultThreshold = 7;
                else if (freq.includes('QUINCENAL')) defaultThreshold = 15;
                else if (freq.includes('MENSUAL')) defaultThreshold = 30;
            }

            clientSummary = {
                clientId: inv.clientId,
                clientName: inv.clientName,
                vendorId: inv.vendorId,
                vendorName: inv.vendorName,
                totalBalance: 0,
                totalInterest: 0,
                totalWithInterest: 0,
                maxDaysOverdue: 0,
                localidad: dbDetails?.Localidad || '',
                defaultThreshold,
                invoices: []
            };
            vendorSummary.clients.push(clientSummary);
        }

        // Accumulate Client Data
        clientSummary.totalBalance += inv.balance;
        clientSummary.totalInterest += inv.interestAmount;
        clientSummary.totalWithInterest += inv.totalWithInterest;
        clientSummary.maxDaysOverdue = Math.max(clientSummary.maxDaysOverdue, inv.daysOverdue);
        clientSummary.invoices.push(inv);

        // Accumulate Vendor Data directly
        vendorSummary.totalBalance += inv.balance;
        vendorSummary.totalInterest += inv.interestAmount;
        vendorSummary.totalWithInterest += inv.totalWithInterest;
    });

    // Sort vendors by name, and clients by total balance descending
    let vendorsArray = Array.from(vendorMap.values());

    vendorsArray.forEach(v => {
        // Filter out clients with negligible balances (e.g. $0 or $0.01)
        v.clients = v.clients.filter(c => c.totalBalance > 1 || c.totalWithInterest > 1);

        v.clients.sort((a, b) => b.totalBalance - a.totalBalance);

        // Sort invoices in client by age (days overdue desc, then emission desc)
        v.clients.forEach(c => {
            c.invoices.sort((a, b) => b.daysOverdue - a.daysOverdue || b.daysEmission - a.daysEmission);
        });
    });

    // Remove vendors that end up having 0 clients after the filtering
    vendorsArray = vendorsArray.filter(v => v.clients.length > 0);

    // Final vendor sort by name
    vendorsArray.sort((a, b) => a.vendorName.localeCompare(b.vendorName));

    return vendorsArray;
};
