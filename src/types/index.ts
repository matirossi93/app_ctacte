export interface InvoiceRaw {
    [key: string]: any; // Allow dynamic columns like '12' from the raw CSV
    COD_CLIENT?: string | number;
    CLIENTES_N: string;
    COD_VENDED: string | number;
    VENDEDORES: string;
    NUMERO: string | number;
    ID: string | number;
    FECHA: string;
    TOTAL: string;
    IMPORTE_PA: string;
    SALDO: number;
    FEC_ULT_VE: string;
    FEC_PROX_V: string;
    IMPORTE_VE: string;
    TIPO_COMPR: string;
    DIAS_EMISI: number;
    GRUPO_DEUD: string | number;
    COD_EMPRES: string | number;
    MONEDA: string;
    TAG: string;
    'FECHA HOY': string;
    'DIAS DEUDA': number | string;
    HR: string;
}

export interface Invoice {
    clientId: string;
    clientName: string;
    vendorId: string;
    vendorName: string;
    invoiceNumber: string;
    id: string;
    date: string;
    totalStr: string;
    balance: number;
    type: string;
    daysEmission: number;
    daysOverdue: number;
    isOverdue: boolean;
    interestRate: number;
    interestAmount: number;
    totalWithInterest: number;
}

export interface ClientDBType {
    Cod: string | number;
    'Razon Social'?: string;
    Localidad?: string;
    Frecuencia?: string; // e.g. 'SEMANAL', 'QUINCENAL', 'MENSUAL'
    [key: string]: any;
}

export interface ClientSummary {
    clientId: string;
    clientName: string;
    vendorId: string;
    vendorName: string;
    totalBalance: number;
    totalInterest: number;
    totalWithInterest: number;
    maxDaysOverdue: number;
    localidad?: string;
    defaultThreshold?: number; // threshold derived from DB (7, 15, 30)
    invoices: Invoice[];
}

export interface VendorSummary {
    vendorId: string;
    vendorName: string;
    totalBalance: number;
    totalInterest: number;
    totalWithInterest: number;
    clients: ClientSummary[];
}
