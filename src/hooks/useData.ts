import { useState, useEffect } from 'react';
import { fetchRawData } from '../services/dataService';
import type { InvoiceRaw, ClientDBType } from '../types';

export const useData = () => {
    const [rawInvoices, setRawInvoices] = useState<InvoiceRaw[]>([]);
    const [clientDbMap, setClientDbMap] = useState<Map<string, ClientDBType>>(new Map());
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<Error | null>(null);

    useEffect(() => {
        let active = true;

        const loadData = async () => {
            setLoading(true);
            setError(null);
            try {
                const result = await fetchRawData();
                if (active) {
                    setRawInvoices(result.invoices);
                    setClientDbMap(result.clientDbMap);
                }
            } catch (e: any) {
                if (active) {
                    setError(e);
                }
            } finally {
                if (active) {
                    setLoading(false);
                }
            }
        };

        loadData();

        return () => {
            active = false;
        };
    }, []); // Only run once on mount

    return { rawInvoices, clientDbMap, loading, error };
};
