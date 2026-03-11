import { useState, useEffect, useCallback } from 'react';
import { fetchRawData } from '../services/dataService';
import { UnauthorizedError } from '../utils/auth';
import type { InvoiceRaw, ClientDBType } from '../types';

export const useData = (onUnauthorized?: () => void) => {
    const [rawInvoices, setRawInvoices] = useState<InvoiceRaw[]>([]);
    const [clientDbMap, setClientDbMap] = useState<Map<string, ClientDBType>>(new Map());
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<Error | null>(null);
    const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
    const [refreshKey, setRefreshKey] = useState(0);

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
                    setLastRefreshed(new Date());
                }
            } catch (e: any) {
                if (!active) return;
                if (e instanceof UnauthorizedError) {
                    onUnauthorized?.();
                } else {
                    setError(e);
                }
            } finally {
                if (active) setLoading(false);
            }
        };

        loadData();

        return () => { active = false; };
    }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

    const refresh = useCallback(() => {
        setRefreshKey(k => k + 1);
    }, []);

    return { rawInvoices, clientDbMap, loading, error, lastRefreshed, refresh };
};
