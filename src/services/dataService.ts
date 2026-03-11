import Papa from 'papaparse';
import type { InvoiceRaw, ClientDBType } from '../types';
import { authHeaders, UnauthorizedError } from '../utils/auth';

export const fetchRawData = async (): Promise<{ invoices: InvoiceRaw[], clientDbMap: Map<string, ClientDBType> }> => {
    const response = await fetch('/api/data', { headers: authHeaders() });

    if (response.status === 401) throw new UnauthorizedError();
    if (!response.ok) {
        let detail = '';
        try { const body = await response.json() as { error?: string }; detail = body.error || ''; } catch {}
        throw new Error(`Error al cargar datos (${response.status})${detail ? ': ' + detail : ''}`);
    }

    const { invoices: invoicesCsvText, clients: clientsCsvText } = await response.json() as {
        invoices: string;
        clients: string;
    };

    return new Promise((resolve, reject) => {
        Papa.parse<ClientDBType>(clientsCsvText, {
            header: true,
            dynamicTyping: true,
            skipEmptyLines: true,
            complete: (clientsResult) => {
                const clientDbMap = new Map<string, ClientDBType>();
                clientsResult.data.forEach(c => {
                    if (c.Cod) {
                        clientDbMap.set(String(c.Cod), c);
                    }
                });

                Papa.parse<InvoiceRaw>(invoicesCsvText, {
                    header: true,
                    dynamicTyping: true,
                    skipEmptyLines: true,
                    complete: (invoicesResult) => {
                        resolve({ invoices: invoicesResult.data, clientDbMap });
                    },
                    error: (error: Error) => reject(error)
                });
            },
            error: (error: Error) => reject(error)
        });
    });
};
