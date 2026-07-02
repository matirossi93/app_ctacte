// Formatters a nivel módulo: crear un Intl.NumberFormat por llamada es caro
// (compila locale data cada vez) y estos se usan en listas largas.
const NF_ARS_0 = new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
});

const NF_ARS_2 = new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
});

const NF_PCT = new Intl.NumberFormat('es-AR', {
    style: 'percent',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
});

export const formatCurrency = (amount: number): string => NF_ARS_0.format(amount);

/** Igual que formatCurrency pero con centavos (detalle de comprobantes/recibos). */
export const formatCurrency2 = (amount: number): string => NF_ARS_2.format(amount);

export const formatPercent = (rate: number): string => NF_PCT.format(rate);
