import Papa from 'papaparse';
import type { InvoiceRaw, VendorSummary, ClientDBType } from '../types';
import { processInvoices } from '../utils/calculations';

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

export const fetchAndProcessData = async (
    interestRate: number = 0.10,
    clientThresholds: Record<string, number> = {},
    invoiceInterestOverrides: Record<string, boolean> = {}
): Promise<VendorSummary[]> => {
    try {
        // Obtenemos ambos CSVs en paralelo
        const [invoicesCsvText, clientsCsvText] = await Promise.all([
            fetchCsv(DATA_URL),
            fetchCsv(CLIENTS_DB_URL)
        ]);

        return new Promise((resolve, reject) => {
            // First parse the clients DB
            Papa.parse<ClientDBType>(clientsCsvText, {
                header: true,
                dynamicTyping: true,
                skipEmptyLines: true,
                complete: (clientsResult) => {
                    // Create a Map of clients for O(1) lookups
                    const clientDbMap = new Map<string, ClientDBType>();
                    clientsResult.data.forEach(c => {
                        if (c.Cod) {
                            clientDbMap.set(String(c.Cod), c);
                        }
                    });

                    // Then parse the invoices
                    Papa.parse<InvoiceRaw>(invoicesCsvText, {
                        header: true,
                        dynamicTyping: true,
                        skipEmptyLines: true,
                        complete: (invoicesResult) => {
                            try {
                                const vendorsSummary = processInvoices(
                                    invoicesResult.data, 
                                    interestRate, 
                                    clientThresholds,
                                    clientDbMap,
                                    invoiceInterestOverrides
                                );
                                resolve(vendorsSummary);
                            } catch (error) {
                                console.error("Error processing invoices:", error);
                                reject(error);
                            }
                        },
                        error: (error: any) => {
                            console.error("PapaParse invoices parsing error:", error);
                            reject(error);
                        }
                    });
                },
                error: (error: any) => {
                    console.error("PapaParse clients parsing error:", error);
                    reject(error);
                }
            });
        });
    } catch (error) {
        console.error("Fetch Error:", error);
        throw error;
    }
};
