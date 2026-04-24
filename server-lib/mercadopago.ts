import axios from 'axios';

// Wrapper para MercadoPago API: busca pagos acreditados en las 3 cuentas
// (Principal + Recaudadora 1 + Recaudadora 2) matcheando por monto + fecha.
// Los tokens se leen al invocar (permite hot-reload tras restart).

const MP_API = 'https://api.mercadopago.com';
const E = process['env'];

export type MPCuenta = 'principal' | 'recaudadora_1' | 'recaudadora_2';

export interface MPMatch {
  cuenta: MPCuenta;
  payment_id: string;
  date_approved: string;    // ISO
  amount: number;
  status: string;           // 'approved'
  payer_email?: string;
  description?: string;
}

function getToken(cuenta: MPCuenta): string | null {
  switch (cuenta) {
    case 'principal': return E.MP_TOKEN_PRINCIPAL || null;
    case 'recaudadora_1': return E.MP_TOKEN_RECAUDADORA_1 || null;
    case 'recaudadora_2': return E.MP_TOKEN_RECAUDADORA_2 || null;
  }
}

async function buscarEnCuenta(cuenta: MPCuenta, monto: number, desdeISO: string, hastaISO: string): Promise<MPMatch[]> {
  const token = getToken(cuenta);
  if (!token) return [];

  try {
    // MP exige rango ISO con hora/TZ. Expandimos desde 00:00:00 del dia 'desde' hasta 23:59:59 del dia 'hasta'
    const beginDate = `${desdeISO}T00:00:00.000-03:00`;
    const endDate = `${hastaISO}T23:59:59.999-03:00`;

    const { data } = await axios.get(`${MP_API}/v1/payments/search`, {
      params: {
        range: 'date_created',
        begin_date: beginDate,
        end_date: endDate,
        status: 'approved',
        limit: 50,
      },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    });

    const results: any[] = data?.results ?? [];
    // MP no soporta filtro por monto exacto en la query, filtramos aca
    return results
      .filter(r => Number(r.transaction_amount) === Number(monto))
      .map(r => ({
        cuenta,
        payment_id: String(r.id ?? ''),
        date_approved: String(r.date_approved ?? r.date_created ?? ''),
        amount: Number(r.transaction_amount ?? 0),
        status: String(r.status ?? ''),
        payer_email: r.payer?.email ?? undefined,
        description: r.description ?? undefined,
      }))
      .filter(m => m.payment_id);
  } catch (err: any) {
    const status = err?.response?.status;
    console.warn(`[MP] cuenta=${cuenta} lookup failed status=${status} msg=${err?.message}`);
    return [];
  }
}

export async function buscarPagoEnMP(params: {
  monto: number;
  desdeISO: string;
  hastaISO: string;
}): Promise<MPMatch[]> {
  const { monto, desdeISO, hastaISO } = params;
  const results = await Promise.allSettled([
    buscarEnCuenta('principal', monto, desdeISO, hastaISO),
    buscarEnCuenta('recaudadora_1', monto, desdeISO, hastaISO),
    buscarEnCuenta('recaudadora_2', monto, desdeISO, hastaISO),
  ]);
  const flat: MPMatch[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') flat.push(...r.value);
  }
  return flat;
}

// Util: ISO yyyy-mm-dd de hoy en TZ AR
export function todayISO_AR(): string {
  const ar = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Tucuman' }));
  const y = ar.getFullYear();
  const m = String(ar.getMonth() + 1).padStart(2, '0');
  const d = String(ar.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function hasAnyMPToken(): boolean {
  return !!(E.MP_TOKEN_PRINCIPAL || E.MP_TOKEN_RECAUDADORA_1 || E.MP_TOKEN_RECAUDADORA_2);
}
