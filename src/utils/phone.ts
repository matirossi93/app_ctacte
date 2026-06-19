// Utilidades de normalización de teléfonos argentinos.
// Extraídas de VendorShell para poder testearlas en aislamiento (antes vivían
// inline en el componente, sin cobertura — y un bug acá dejó ~200 botones de
// contacto muertos antes de que se detectara).

// Normaliza un número argentino a 10 u 11 dígitos locales (área + número), manejando:
// - Múltiples números separados por / , ; | " y " " ó " → toma el primero.
// - 0 inicial (ej. "0381"), prefijo país "+54", prefijo móvil internacional "9".
// - "15" prefix viejo sin código área → asume Tucumán (381). Con código área → lo quita.
// - "15" intermedio (ej. "381 15 4161064") → lo saca SOLO si sobran dígitos (>=12).
// Retorna null si no llega a 10-11 dígitos válidos.
export function normalizeArgPhone(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const parts = String(raw).split(/[/;|,]|\sy\s|\só\s/i).map(s => s.trim()).filter(Boolean);
    if (parts.length === 0) return null;
    let digits = parts[0].replace(/\D/g, '');
    if (!digits) return null;
    if (digits.startsWith('0') && digits.length >= 11) digits = digits.slice(1);
    if (digits.startsWith('54') && digits.length >= 12) digits = digits.slice(2);
    if (digits.startsWith('9') && digits.length === 11) digits = digits.slice(1);
    if (digits.startsWith('15') && digits.length === 9) digits = '381' + digits.slice(2);
    else if (digits.startsWith('15') && digits.length >= 10) digits = digits.slice(2);
    // El "15" intermedio solo se saca si SOBRAN dígitos (>=12). Sin este guard, un
    // celular de Tucumán "3815XXXXXX" (área 381 + número que arranca en 5) se leería
    // como 38·15·XXXXXX y quedaría en 8 dígitos → rechazado. Pasaba con ~200 clientes.
    if (digits.length >= 12) digits = digits.replace(/^(\d{2,4})15(\d{6,8})$/, '$1$2');
    if (digits.length < 10 || digits.length > 11) return null;
    return digits;
}

export function telHref(raw: string | null | undefined): string | null {
    const n = normalizeArgPhone(raw);
    return n ? `tel:+54${n}` : null;
}

export function waHref(raw: string | null | undefined): string | null {
    const n = normalizeArgPhone(raw);
    return n ? `https://wa.me/549${n}` : null;
}

// Estado de un teléfono crudo de IM, para que la UI distinga "no hay dato" de
// "hay dato pero está mal cargado". Son acciones distintas para el vendedor:
// 'missing' → cargarlo de cero; 'invalid' → corregir el que ya está en IM.
export function phoneStatus(raw: string | null | undefined): 'ok' | 'invalid' | 'missing' {
    if (!raw || !String(raw).trim()) return 'missing';
    return normalizeArgPhone(raw) ? 'ok' : 'invalid';
}
