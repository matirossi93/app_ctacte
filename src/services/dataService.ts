import Papa from 'papaparse';
import type { InvoiceRaw, VendorSummary } from '../types';
import { processInvoices } from '../utils/calculations';

// Official sheet link provided by the user, formatted for CSV export
const DATA_URL = 'https://docs.google.com/spreadsheets/d/1UMtdGkn7GTAIAZ8De9nWxYQThM6YruzVf1-W757xYmQ/export?format=csv';

export const fetchAndProcessData = async (
    interestRate: number = 0.10,
    clientThresholds: Record<string, number> = {}
): Promise<VendorSummary[]> => {
    return new Promise((resolve, reject) => {
        Papa.parse<InvoiceRaw>(DATA_URL, {
            download: true,
            header: true,
            dynamicTyping: true,
            skipEmptyLines: true,
            complete: (results) => {
                try {
                    const vendorsSummary = processInvoices(results.data, interestRate, clientThresholds);
                    resolve(vendorsSummary);
                } catch (error) {
                    reject(error);
                }
            },
            error: (error) => {
                reject(error);
            }
        });
    });
};
