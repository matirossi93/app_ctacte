import { useState, useEffect } from 'react';
import { fetchAndProcessData } from '../services/dataService';
import type { VendorSummary } from '../types';

export const useData = (interestRate: number, clientThresholds: Record<string, number> = {}, invoiceInterestOverrides: Record<string, boolean> = {}) => {
    const [data, setData] = useState<VendorSummary[]>([]);
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<Error | null>(null);

    useEffect(() => {
        let active = true;

        const loadData = async () => {
            setLoading(true);
            setError(null);
            try {
                const result = await fetchAndProcessData(interestRate, clientThresholds, invoiceInterestOverrides);
                if (active) {
                    setData(result);
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
    }, [interestRate, JSON.stringify(clientThresholds), JSON.stringify(invoiceInterestOverrides)]); // Stringify to detect deep changes

    return { data, loading, error };
};
