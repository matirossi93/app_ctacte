import Papa from 'papaparse';
import type { InvoiceRaw, ClientDBType } from '../types';

// Official sheet link provided by the user, formatted for CSV export
const DATA_URL = 'https://docs.google.com/spreadsheets/d/1UMtdGkn7GTAIAZ8De9nWxYQThM6YruzVf1-W757xYmQ/export?format=csv';
// New client DB sheet
const CLIENTS_DB_URL = 'https://docs.google.com/spreadsheets/d/1k7B8Phi5QDn_6mFWiAfYBcqqisEWT6nqUwgmhE54Zy8/export?format=csv';

const fetchCsv = async (url: string) => {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    return await response.text();
};

export const fetchRawData = async (): Promise<{ invoices: InvoiceRaw[], clientDbMap: Map<string, ClientDBType> }> => {
    try {
        const [invoicesCsvText, clientsCsvText] = await Promise.all([
            fetchCsv(DATA_URL),
            fetchCsv(CLIENTS_DB_URL)
        ]);

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
                        error: (error: any) => reject(error)
                    });
                },
                error: (error: any) => reject(error)
            });
        });
    } catch (error) {
        console.error("Fetch Error:", error);
        throw error;
    }
};
