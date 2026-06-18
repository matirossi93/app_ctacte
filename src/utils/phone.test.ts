import { describe, it, expect } from 'vitest';
import { normalizeArgPhone, telHref, waHref, phoneStatus, looksLikeLandline } from './phone';

describe('normalizeArgPhone', () => {
  // ── REGRESIÓN: el bug que dejó ~200 botones de contacto muertos ──────────
  // Los celulares de Tucumán arrancan en 381-5; la regex que limpia el "15"
  // viejo los confundía (38·15·XXXXXX → 8 dígitos → null). NO deben rechazarse.
  describe('regresión bug 381-5 (celulares de Tucumán)', () => {
    it('conserva un celular 3815XXXXXX de 10 dígitos', () => {
      expect(normalizeArgPhone('3815424600')).toBe('3815424600');
      expect(normalizeArgPhone('3815336894')).toBe('3815336894');
      expect(normalizeArgPhone('3815795968')).toBe('3815795968');
    });
    it('conserva otros códigos de área limítrofes (371...)', () => {
      expect(normalizeArgPhone('3715781627')).toBe('3715781627');
    });
  });

  // ── El "15" viejo intercalado SÍ se sigue limpiando cuando corresponde ───
  describe('limpieza legítima del "15" viejo', () => {
    it('saca el "15" intermedio cuando sobran dígitos (0381 15 ...)', () => {
      expect(normalizeArgPhone('0381 15 4857033')).toBe('3814857033');
      expect(normalizeArgPhone('381 15 485-7033')).toBe('3814857033');
    });
    it('asume Tucumán (381) ante "15" + 7 dígitos sin código de área', () => {
      expect(normalizeArgPhone('15 4161064')).toBe('3814161064');
    });
  });

  // ── Prefijos de país / 0 / móvil internacional ──────────────────────────
  describe('prefijos', () => {
    it('quita el 0 inicial del fijo (0381...)', () => {
      expect(normalizeArgPhone('03815424600')).toBe('3815424600');
    });
    it('quita +54 y el 9 móvil internacional', () => {
      expect(normalizeArgPhone('+5493815424600')).toBe('3815424600');
      expect(normalizeArgPhone('5493815424600')).toBe('3815424600');
    });
  });

  // ── Múltiples números: toma el primero válido ───────────────────────────
  it('toma el primer número de una lista separada por "/"', () => {
    expect(normalizeArgPhone('3814161064 / 3815424600')).toBe('3814161064');
  });

  // ── Rechazos legítimos (basura / incompletos) → null ────────────────────
  describe('rechaza datos inválidos', () => {
    it('rechaza basura y números incompletos', () => {
      expect(normalizeArgPhone('0')).toBeNull();
      expect(normalizeArgPhone('111111')).toBeNull();
      expect(normalizeArgPhone('4252461')).toBeNull();   // fijo 7 díg sin área
      expect(normalizeArgPhone('381511949')).toBeNull(); // 9 díg, truncado
    });
    it('rechaza vacío / null / undefined', () => {
      expect(normalizeArgPhone('')).toBeNull();
      expect(normalizeArgPhone(null)).toBeNull();
      expect(normalizeArgPhone(undefined)).toBeNull();
      expect(normalizeArgPhone('   ')).toBeNull();
    });
  });
});

describe('phoneStatus', () => {
  it('distingue ok / invalid / missing', () => {
    expect(phoneStatus('3815424600')).toBe('ok');
    expect(phoneStatus('4252461')).toBe('invalid');   // hay dato, pero no normaliza
    expect(phoneStatus('111111')).toBe('invalid');
    expect(phoneStatus('')).toBe('missing');
    expect(phoneStatus('   ')).toBe('missing');
    expect(phoneStatus(null)).toBe('missing');
    expect(phoneStatus(undefined)).toBe('missing');
  });
});

describe('looksLikeLandline', () => {
  it('marca el fijo capital 381-4XXXXXX', () => {
    expect(looksLikeLandline('3814254600')).toBe(true);
    expect(looksLikeLandline('0381 4254600')).toBe(true);
  });
  it('NO marca celulares (381-5/6) ni interior ni vacío', () => {
    expect(looksLikeLandline('3815424600')).toBe(false); // celular capital
    expect(looksLikeLandline('3816696066')).toBe(false); // celular capital
    expect(looksLikeLandline('3865123456')).toBe(false); // interior
    expect(looksLikeLandline('')).toBe(false);
    expect(looksLikeLandline(null)).toBe(false);
  });
});

describe('telHref / waHref', () => {
  it('arman los links cuando el número es válido', () => {
    expect(telHref('3815424600')).toBe('tel:+543815424600');
    expect(waHref('3815424600')).toBe('https://wa.me/5493815424600');
  });
  it('devuelven null cuando el número no normaliza', () => {
    expect(telHref('4252461')).toBeNull();
    expect(waHref(null)).toBeNull();
    expect(waHref('')).toBeNull();
  });
});
