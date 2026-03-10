import { useData } from '../hooks/useData';
import { processInvoices } from '../utils/calculations';
import { useMemo } from 'react';

export const BotJsonFeed = () => {
    // Using 10% interest as requested
    const { rawInvoices, clientDbMap, loading, error } = useData();

    const data = useMemo(() => {
        if (!rawInvoices.length) return [];
        return processInvoices(rawInvoices, 0.10, {}, clientDbMap, {});
    }, [rawInvoices, clientDbMap]);

    if (loading) return <pre>{"{ \"status\": \"loading\" }"}</pre>;
    if (error) return <pre>{JSON.stringify({ status: "error", message: error.message }, null, 2)}</pre>;

    // Group clients by Vendor, then by Locality
    const vendorsMap = new Map<string, any>();

    data.forEach(vendor => {
        const locationsMap = new Map<string, any[]>();
        
        vendor.clients.forEach(c => {
            // Only include clients with debt
            if (c.totalBalance > 0 || c.totalWithInterest > 0) {
                const loc = c.localidad || 'Sin Localidad';
                
                if (!locationsMap.has(loc)) {
                    locationsMap.set(loc, []);
                }
                
                locationsMap.get(loc)!.push({
                    nombre: c.clientName,
                    codigo_cliente: c.clientId,
                    maximos_dias_atraso: c.maxDaysOverdue,
                    saldo_original: c.totalBalance,
                    saldo_con_intereses: c.totalWithInterest,
                    cantidad_facturas: c.invoices.length,
                    facturas: c.invoices.map(i => ({
                        numero: `${i.type} ${i.invoiceNumber}`,
                        fecha_emision: i.date,
                        dias_vencida: i.daysOverdue,
                        interes_aplicado: i.interestAmount,
                        total_a_cobrar: i.totalWithInterest
                    }))
                });
            }
        });

        // Convert locations map to array to match JSON structure
        const localidades: any[] = [];
        locationsMap.forEach((clientes, nombre_localidad) => {
             localidades.push({
                 localidad: nombre_localidad,
                 total_clientes_deudores: clientes.length,
                 clientes: clientes.sort((a: any, b: any) => b.saldo_con_intereses - a.saldo_con_intereses)
             });
        });

        if (localidades.length > 0) {
            vendorsMap.set(vendor.vendorName, localidades);
        }
    });

    const reporteVendedores = Array.from(vendorsMap.entries()).map(([vendedor, localidades]) => ({
        vendedor,
        localidades
    }));

    const botPayload = {
        status: "success",
        timestamp: new Date().toISOString(),
        tasa_interes_aplicada: "10%",
        reporte_vendedores: reporteVendedores
    };

    // We simply render plain text inside a "pre" tag so the bot can fetch and parse
    return (
        <pre style={{ margin: 0, padding: '1rem', background: '#fff', color: '#000', fontSize: '12px' }}>
            {JSON.stringify(botPayload, null, 2)}
        </pre>
    );
};
