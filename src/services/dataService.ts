import Papa from 'papaparse';
import type { InvoiceRaw, ClientDBType } from '../types';
import { authHeaders, UnauthorizedError } from '../utils/auth';

export const fetchRawData = async (force = false): Promise<{ invoices: InvoiceRaw[], clientDbMap: Map<string, ClientDBType> }> => {
    const url = force ? '/api/data?nocache=1' : '/api/data';
    const response = await fetch(url, { headers: authHeaders() });

    if (response.status === 401) throw new UnauthorizedError();
    if (!response.ok) {
        let detail = '';
        try { const body = await response.json() as { error?: string }; detail = body.error || ''; } catch {}
        throw new Error(`Error al cargar datos (${response.status})${detail ? ': ' + detail : ''}`);
    }

    const body = await response.json();

    // InfoManager path: server returns structured JSON
    if (body.source === 'infomanager') {
        const clientDbMap = new Map<string, ClientDBType>();
        if (body.clientDbMap) {
            Object.entries(body.clientDbMap).forEach(([key, val]) => {
                clientDbMap.set(key, val as ClientDBType);
            });
        }
        return { invoices: body.invoices as InvoiceRaw[], clientDbMap };
    }

    // Sheets fallback: parse CSV strings
    const invoicesCsvText = body.invoices as string;
    const clientsCsvText = body.clientDbMap as string;

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
