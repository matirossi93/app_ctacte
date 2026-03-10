import Papa from 'papaparse';
import type { InvoiceRaw, VendorSummary } from '../types';
import { processInvoices } from '../utils/calculations';

// Official sheet link provided by the user, formatted for CSV export
const DATA_URL = 'https://docs.google.com/spreadsheets/d/1UMtdGkn7GTAIAZ8De9nWxYQThM6YruzVf1-W757xYmQ/export?format=csv';

export const fetchAndProcessData = async (
    interestRate: number = 0.10,
    clientThresholds: Record<string, number> = {}
): Promise<VendorSummary[]> => {
    try {
        // Obtenemos el CSV crudo manualmente para manejar mejor el redirect de Google
        const response = await fetch(DATA_URL, {
            redirect: 'follow'
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const csvText = await response.text();

        return new Promise((resolve, reject) => {
            Papa.parse<InvoiceRaw>(csvText, {
                header: true,
                dynamicTyping: true,
                skipEmptyLines: true,
                complete: (results) => {
                    try {
                        const vendorsSummary = processInvoices(results.data, interestRate, clientThresholds);
                        resolve(vendorsSummary);
                    } catch (error) {
                        console.error("Error processing invoices:", error);
                        reject(error);
                    }
                },
                error: (error: any) => {
                    console.error("PapaParse parsing error:", error);
                    reject(error);
                }
            });
        });
    } catch (error) {
        console.error("Fetch Error:", error);
        throw error;
    }
};
