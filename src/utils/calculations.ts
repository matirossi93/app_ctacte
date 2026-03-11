import type { InvoiceRaw, Invoice, VendorSummary, ClientDBType } from '../types';

export const processInvoices = (
    rawInvoices: InvoiceRaw[],
    interestRate: number,
    clientThresholds: Record<string, number> = {},
    clientDbMap: Map<string, ClientDBType> = new Map(),
    invoiceInterestOverrides: Record<string, boolean> = {}
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

        // Parse Argentine currency format (e.g., "$1.415.035,00" or "4026125" strings/numbers)
        const parseCurrency = (val: any): number => {
            if (typeof val === 'number') return val;
            if (!val) return 0;
            const strVal = String(val).replace(/\$/g, '').replace(/\./g, '').replace(',', '.').trim();
            const parsed = Number(strVal);
            return isNaN(parsed) ? 0 : parsed;
        };

        const type = String(raw.TIPO_COMPR).toUpperCase();
        
        // Fix for Notas de Crédito (NC): Their SALDO is 0 but TOTAL contains the negative value
        let balance = 0;
        if (type === 'NC') {
            balance = parseCurrency(raw.TOTAL);
        } else {
            balance = parseCurrency(raw.SALDO);
        }

        // Exact Recalculation of Overdue Days based on [Today] - [Emission Date]
        // The date appears in the unnamed first column raw[''] e.g. '9/2/2026' or '21/11/2025'
        const emissionDateStr = String(raw.FECHA || raw[''] || '');
        let diffDays = Number(raw.DIAS_EMISI) || 0; // Fallback
        
        if (emissionDateStr.includes('/')) {
            const parts = emissionDateStr.split('/');
            if (parts.length >= 3) {
                // Ensure YYYY-MM-DD
                const day = parseInt(parts[0], 10);
                const month = parseInt(parts[1], 10) - 1; // JS months are 0-indexed
                const year = parseInt(parts[2], 10);
                
                const emissionDate = new Date(year, month, day);
                const today = new Date();
                
                // Clear times for pure day diff
                emissionDate.setHours(0,0,0,0);
                today.setHours(0,0,0,0);
                
                const diffTime = today.getTime() - emissionDate.getTime();
                diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
            }
        }
        
        // Prevent negative days if the invoice date is in the future somehow
        diffDays = Math.max(0, diffDays);

        // Calculate if it's overdue using pure elapsed days against the threshold
        let isOverdue = false;
        let daysOverdue = 0;

        if (customThreshold !== undefined && customThreshold > 0) {
            isOverdue = diffDays > customThreshold;
            daysOverdue = isOverdue ? diffDays - customThreshold : 0;
        } else {
            isOverdue = diffDays > defaultThreshold;
            daysOverdue = isOverdue ? diffDays - defaultThreshold : 0;
        }
        
        // Never apply interest to Credit Notes
        if (type === 'NC') {
            isOverdue = false;
        }

        // Apply override if it exists
        const invoiceId = String(raw.ID);
        const hasManualOverride = invoiceInterestOverrides[invoiceId] !== undefined;
        const manuallyApplied = hasManualOverride ? invoiceInterestOverrides[invoiceId] : isOverdue;

        const appliedInterestRate = manuallyApplied ? interestRate : 0;
        const interestAmount = balance * appliedInterestRate;

        return {
            clientId: String(raw['12'] || raw.COD_CLIENT),
            clientName: String(raw.CLIENTES_N),
            vendorId: String(raw.COD_VENDED),
            vendorName: String(raw.VENDEDORES),
            invoiceNumber: String(raw.NUMERO),
            id: String(raw.ID),
            date: String(raw.FECHA || raw['']), // The CSV header for date is often empty
            totalStr: String(raw.TOTAL),
            balance,
            type,
            daysEmission: diffDays, 
            daysOverdue,
            isOverdue,
            interestRate: appliedInterestRate,
            interestAmount,
            totalWithInterest: balance + interestAmount
        };
    });

    // Remove null or negligible balances but KEEP negative balances (Credit Notes)
    const invoices = allMappedInvoices.filter(inv => Math.abs(inv.balance) > 1);

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
