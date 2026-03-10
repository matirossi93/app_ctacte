import { useData } from '../hooks/useData';

export const BotJsonFeed = () => {
    // Using 10% interest as requested
    const { data, loading, error } = useData(0.10);

    if (loading) return <pre>{"{ \"status\": \"loading\" }"}</pre>;
    if (error) return <pre>{JSON.stringify({ status: "error", message: error.message }, null, 2)}</pre>;

    // Sort and extract the worst offenders across the entire company
    const allClients = data.flatMap(v => v.clients);
    allClients.sort((a, b) => b.maxDaysOverdue - a.maxDaysOverdue);

    const topDebtors = allClients.filter(c => c.maxDaysOverdue > 0).map(c => ({
        nombre: c.clientName,
        codigo_cliente: c.clientId,
        vendedor: c.vendorName,
        maximos_dias_atraso: c.maxDaysOverdue,
        saldo_original: c.totalBalance,
        saldo_con_intereses: c.totalWithInterest,
        interes_aplicado: c.totalInterest,
        cantidad_facturas: c.invoices.length,
        facturas_vencidas: c.invoices.filter(i => i.isOverdue).map(i => ({
            numero: `${i.type} ${i.invoiceNumber}`,
            dias_vencida: i.daysOverdue,
            total_a_cobrar: i.totalWithInterest
        }))
    }));

    const botPayload = {
        status: "success",
        tasa_interes_aplicada: "10%",
        total_clientes_en_mora: topDebtors.length,
        top_deudores: topDebtors
    };

    // We simply render plain text inside a "pre" tag so the bot can fetch and parse
    return (
        <pre style={{ margin: 0, padding: '1rem', background: '#fff', color: '#000', fontSize: '12px' }}>
            {JSON.stringify(botPayload, null, 2)}
        </pre>
    );
};
