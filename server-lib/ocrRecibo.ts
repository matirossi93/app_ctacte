import Anthropic from '@anthropic-ai/sdk';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.OCR_MODEL || 'claude-haiku-4-5-20251001';

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) {
    if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY no configurado');
    _client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  }
  return _client;
}

export interface OcrRecibo {
  monto: number | null;
  fecha: string | null;             // YYYY-MM-DD
  medio_pago: 'transferencia' | 'efectivo' | 'cheque' | 'mercadopago' | 'otro' | null;
  banco_origen: string | null;
  banco_destino: string | null;
  titular_origen: string | null;
  cbu_destino_last4: string | null;
  referencia: string | null;
  confidence: number;                // 0..1
  notas: string | null;
  raw_text: string | null;
}

const PROMPT = `Sos un extractor de datos de comprobantes de pago argentinos (transferencias bancarias, Mercado Pago, depósitos, cheques).

Tu única salida es JSON válido con este shape exacto:
{
  "monto": number | null,              // en pesos, sin símbolo ni separadores de miles
  "fecha": "YYYY-MM-DD" | null,        // fecha del movimiento
  "medio_pago": "transferencia" | "efectivo" | "cheque" | "mercadopago" | "otro" | null,
  "banco_origen": string | null,       // banco/billetera del que SALE la plata
  "banco_destino": string | null,      // banco al que LLEGA
  "titular_origen": string | null,     // nombre/razón social del que paga
  "cbu_destino_last4": string | null,  // últimos 4 dígitos del CBU/CVU destino si visible
  "referencia": string | null,         // nro de operación / coelsa / referencia
  "confidence": number,                // 0..1 — qué tan seguro estás de la lectura completa
  "notas": string | null,              // cualquier observación útil (recorte, baja calidad, etc.)
  "raw_text": string | null            // texto completo que leíste, útil para debug
}

Reglas:
- Si un campo no está visible o no es legible, poné null (NO inventes).
- Monto: convertí "1.234,56" → 1234.56. Sin moneda ni símbolos.
- Fecha: normalizá a YYYY-MM-DD. Si solo hay DD/MM, asumí el año actual.
- confidence: bajá a < 0.6 si la imagen es borrosa, está recortada, o si un campo crítico (monto/fecha) no lo pudiste leer.
- NO devuelvas markdown, NO envuelvas en \`\`\`json, NO agregues texto fuera del JSON.
- Si la imagen NO es un comprobante de pago, devolvé todos los campos en null y confidence 0.`;

export async function ocrRecibo(imageBase64: string, mime: string): Promise<OcrRecibo> {
  const res = await client().messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mime as any, data: imageBase64 } },
        { type: 'text', text: PROMPT }
      ]
    }]
  });

  const text = res.content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('\n')
    .trim();

  // Limpiar por si el modelo envuelve en ``` igualmente
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    const parsed = JSON.parse(cleaned);
    return sanitize(parsed);
  } catch (err: any) {
    return {
      monto: null, fecha: null, medio_pago: null, banco_origen: null, banco_destino: null,
      titular_origen: null, cbu_destino_last4: null, referencia: null,
      confidence: 0, notas: `parse error: ${err?.message ?? 'invalid json'}`,
      raw_text: cleaned.slice(0, 500)
    };
  }
}

function sanitize(o: any): OcrRecibo {
  const num = (v: any): number | null => {
    if (v == null) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    const n = Number(String(v).replace(/\./g, '').replace(',', '.'));
    return isFinite(n) ? n : null;
  };
  const medios = new Set(['transferencia', 'efectivo', 'cheque', 'mercadopago', 'otro']);
  const mp = typeof o?.medio_pago === 'string' && medios.has(o.medio_pago) ? o.medio_pago : null;

  const conf = typeof o?.confidence === 'number' ? Math.max(0, Math.min(1, o.confidence)) : 0;

  return {
    monto: num(o?.monto),
    fecha: typeof o?.fecha === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.fecha) ? o.fecha : null,
    medio_pago: mp as OcrRecibo['medio_pago'],
    banco_origen: typeof o?.banco_origen === 'string' ? o.banco_origen : null,
    banco_destino: typeof o?.banco_destino === 'string' ? o.banco_destino : null,
    titular_origen: typeof o?.titular_origen === 'string' ? o.titular_origen : null,
    cbu_destino_last4: typeof o?.cbu_destino_last4 === 'string' ? o.cbu_destino_last4.replace(/\D/g, '').slice(-4) : null,
    referencia: typeof o?.referencia === 'string' ? o.referencia : null,
    confidence: conf,
    notas: typeof o?.notas === 'string' ? o.notas : null,
    raw_text: typeof o?.raw_text === 'string' ? o.raw_text.slice(0, 2000) : null
  };
}
