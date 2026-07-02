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
        
        // Plazo real de pago = columna VISITA del maestro ('7'/'15'). "Frecuencia"
        // NO es el plazo (incidente cobranzas 02/07/2026) — queda como fallback.
        let defaultThreshold = 0;
        const visita = String(clientDbDetails?.Visita ?? clientDbDetails?.VISITA ?? '').trim();
        if (visita === '7') defaultThreshold = 7;
        else if (visita === '15') defaultThreshold = 15;
        else if (clientDbDetails?.Frecuencia) {
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
        
        // As requested, always read from raw.SALDO (even for NCs)
        const balance = parseCurrency(raw.SALDO);

        // Exact Recalculation of Overdue Days based on [Today] - [Emission Date]
        // The date appears in the unnamed first column raw[''] e.g. '9/2/2026' or '21/11/2025'
        const emissionDateStr = String(raw.FECHA || raw[''] || '');
        let diffDays = Number(raw.DIAS_EMISI) || 0; // Fallback (InfoManager provides this directly)

        if (emissionDateStr.includes('/')) {
            const parts = emissionDateStr.split('/');
            if (parts.length >= 3) {
                const day = parseInt(parts[0], 10);
                const month = parseInt(parts[1], 10) - 1; // JS months are 0-indexed
                const year = parseInt(parts[2], 10);

                const emissionDate = new Date(year, month, day);
                const today = new Date();

                emissionDate.setHours(0,0,0,0);
                today.setHours(0,0,0,0);

                const diffTime = today.getTime() - emissionDate.getTime();
                diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
            }
        } else if (emissionDateStr.includes('-') && emissionDateStr.length >= 10) {
            // ISO format from InfoManager (YYYY-MM-DD)
            const [y, m, d] = emissionDateStr.split('-').map(Number);
            if (y && m && d) {
                const emissionDate = new Date(y, m - 1, d);
                const today = new Date();
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
            daysOverdue = isOverdue ? diffDays : 0;
        } else {
            isOverdue = diffDays > defaultThreshold;
            daysOverdue = isOverdue ? diffDays : 0;
        }
        
        // FA y ND generan ATRASO: ambas son deuda real del cliente (saldo deudor).
        // El INTERÉS, en cambio, solo se calcula sobre FA (ver appliedInterestRate
        // abajo, gateado por type === 'FA'), así que contar la ND para la mora NO
        // le cobra interés. NC, RC, ASD, ASH son saldo a favor/pagos/ajustes: no
        // generan atraso. Antes solo FA contaba y una ND vieja salía "Al día".
        if (type !== 'FA' && type !== 'ND') {
            isOverdue = false;
            daysOverdue = 0;
        }

        // Apply override if it exists (solo para FA — no se calcula interés sobre interés)
        const invoiceId = String(raw.ID);
        let appliedInterestRate = 0;
        if (type === 'FA') {
            const hasManualOverride = invoiceInterestOverrides[invoiceId] !== undefined;
            const manuallyApplied = hasManualOverride ? invoiceInterestOverrides[invoiceId] : isOverdue;
            appliedInterestRate = manuallyApplied ? interestRate : 0;
        }
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

    // Remove negligible balances (residuos de pagos parciales) and KEEP negative (Credit Notes)
    const invoices = allMappedInvoices.filter(inv => Math.abs(inv.balance) > 2000);

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
            
            // Plazo para reporte/UI: VISITA ('7'/'15') primero, Frecuencia como fallback
            let defaultThreshold = 0;
            const visitaCli = String(dbDetails?.Visita ?? dbDetails?.VISITA ?? '').trim();
            if (visitaCli === '7') defaultThreshold = 7;
            else if (visitaCli === '15') defaultThreshold = 15;
            else if (dbDetails?.Frecuencia) {
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
        // FA y ND con saldo deudor (positivo) cuentan para el atraso máximo del
        // cliente. NC/recibos/ajustes con saldo a favor (negativo) no.
        if ((inv.type === 'FA' || inv.type === 'ND') && inv.balance > 0) {
            clientSummary.maxDaysOverdue = Math.max(clientSummary.maxDaysOverdue, inv.daysOverdue);
        }
        clientSummary.invoices.push(inv);

        // Accumulate Vendor Data directly
        vendorSummary.totalBalance += inv.balance;
        vendorSummary.totalInterest += inv.interestAmount;
        vendorSummary.totalWithInterest += inv.totalWithInterest;
    });

    // Sort vendors by name, and clients by total balance descending
    let vendorsArray = Array.from(vendorMap.values());

    vendorsArray.forEach(v => {
        // Filter out clients with negligible balances (residuos de pagos parciales)
        v.clients = v.clients.filter(c => c.totalBalance > 2000 || c.totalWithInterest > 2000);

        // Recalculate vendor totals after filtering clients
        v.totalBalance = v.clients.reduce((sum, c) => sum + c.totalBalance, 0);
        v.totalInterest = v.clients.reduce((sum, c) => sum + c.totalInterest, 0);
        v.totalWithInterest = v.clients.reduce((sum, c) => sum + c.totalWithInterest, 0);

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
