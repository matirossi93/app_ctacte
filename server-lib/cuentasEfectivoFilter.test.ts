import { describe, it, expect } from 'vitest';
import { filterCuentasEfectivo, normalizeCuentaNombre } from './cuentasEfectivoFilter.js';

// Plan de cuentas de muestra (nombres al estilo IM Semillero). El objetivo es
// validar que el filtro agarre las cajas físicas y descarte lo que no lo es.
const PLAN = [
  { cod_cuenta: '1110005', nombre: 'Caja Casa Central' },
  { cod_cuenta: '1110010', nombre: 'Caja Chica 2' },
  { cod_cuenta: '1110011', nombre: 'CAJA SAN MARTÍN' },
  { cod_cuenta: '1120001', nombre: 'Banco Nación Cta Cte' },
  { cod_cuenta: '1120050', nombre: 'Caja de Ahorro Banco Nación' }, // NO es efectivo
  { cod_cuenta: '2124000', nombre: 'Anticipo de Clientes' },
  { cod_cuenta: '1110099', nombre: 'Efectivo en tránsito' },
  { cod_cuenta: '4100001', nombre: 'Ventas Mercadería' },
];

describe('filterCuentasEfectivo', () => {
  it('incluye las cajas físicas y "efectivo", excluye banco/caja de ahorro/otras', () => {
    const out = filterCuentasEfectivo(PLAN, '1110005');
    const cods = out.map(c => c.cod_cuenta);
    expect(cods).toContain('1110005'); // Caja Casa Central
    expect(cods).toContain('1110010'); // Caja Chica 2
    expect(cods).toContain('1110011'); // Caja San Martín (con tilde)
    expect(cods).toContain('1110099'); // Efectivo en tránsito
    // NO debe traer:
    expect(cods).not.toContain('1120001'); // Banco Nación
    expect(cods).not.toContain('1120050'); // Caja de Ahorro (es banco)
    expect(cods).not.toContain('2124000'); // Anticipo
    expect(cods).not.toContain('4100001'); // Ventas
  });

  it('marca como default la cuenta indicada y la pone primera', () => {
    const out = filterCuentasEfectivo(PLAN, '1110010'); // Caja Chica 2 default
    expect(out[0].cod_cuenta).toBe('1110010');
    expect(out[0].es_default).toBe(true);
    expect(out.filter(c => c.es_default)).toHaveLength(1);
  });

  it('si el default no está en el plan, lo agrega igual (no se pierde la opción)', () => {
    const out = filterCuentasEfectivo(PLAN, '9999999');
    const def = out.find(c => c.cod_cuenta === '9999999');
    expect(def).toBeTruthy();
    expect(def!.es_default).toBe(true);
    expect(out[0].cod_cuenta).toBe('9999999'); // default primero
  });

  it('ordena el resto por nombre (default aparte)', () => {
    const out = filterCuentasEfectivo(PLAN, '1110005');
    const resto = out.filter(c => !c.es_default).map(c => c.nombre);
    const ordenado = [...resto].sort((a, b) => a.localeCompare(b, 'es'));
    expect(resto).toEqual(ordenado);
  });

  it('no rompe con plan vacío y sin default', () => {
    expect(filterCuentasEfectivo([], '')).toEqual([]);
  });

  describe('allow-list', () => {
    it('con allow-list por nombre, muestra SOLO esas cajas', () => {
      const out = filterCuentasEfectivo(PLAN, '1110005', ['Caja Casa Central', 'Caja Chica 2']);
      const cods = out.map(c => c.cod_cuenta).sort();
      expect(cods).toEqual(['1110005', '1110010']);
      // NO trae San Martín, Efectivo en tránsito, etc.
      expect(out.find(c => c.cod_cuenta === '1110011')).toBeUndefined();
      expect(out.find(c => c.cod_cuenta === '1110099')).toBeUndefined();
    });

    it('el match de nombre ignora tildes y mayúsculas', () => {
      const out = filterCuentasEfectivo(PLAN, '1110005', ['caja san martin']);
      expect(out.find(c => c.cod_cuenta === '1110011')).toBeTruthy(); // "CAJA SAN MARTÍN"
    });

    it('también acepta cod_cuenta en la allow-list', () => {
      const out = filterCuentasEfectivo(PLAN, '1110005', ['1110010']);
      const cods = out.map(c => c.cod_cuenta).sort();
      // Caja Chica 2 por código + el default forzado a estar presente
      expect(cods).toContain('1110010');
      expect(cods).toContain('1110005');
    });

    it('match exacto: "Caja Chica 2" no arrastra "Caja Chica 1"', () => {
      const out = filterCuentasEfectivo(PLAN, '9999999', ['Caja Chica 2']);
      expect(out.find(c => c.cod_cuenta === '1110010')).toBeTruthy(); // Chica 2 sí
      const planConChica1 = [...PLAN, { cod_cuenta: '1110009', nombre: 'Caja Chica 1' }];
      const out2 = filterCuentasEfectivo(planConChica1, '9999999', ['Caja Chica 2']);
      expect(out2.find(c => c.cod_cuenta === '1110009')).toBeUndefined(); // Chica 1 no
    });

    it('allow-list vacía → cae a la heurística amplia', () => {
      const conAllow = filterCuentasEfectivo(PLAN, '1110005', []);
      const sinArg = filterCuentasEfectivo(PLAN, '1110005');
      expect(conAllow.map(c => c.cod_cuenta)).toEqual(sinArg.map(c => c.cod_cuenta));
      expect(conAllow.length).toBeGreaterThan(2); // trae varias cajas
    });
  });

  it('descarta cuentas sin cod_cuenta', () => {
    const out = filterCuentasEfectivo([{ cod_cuenta: '', nombre: 'Caja fantasma' }], '1110005');
    // solo queda el default inyectado, no la caja sin cod
    expect(out.every(c => c.cod_cuenta !== '')).toBe(true);
  });

  it('normalizeCuentaNombre saca tildes y mayúsculas', () => {
    expect(normalizeCuentaNombre('CAJA SAN MARTÍN')).toBe('caja san martin');
    expect(normalizeCuentaNombre('Caja de Ahorro')).toBe('caja de ahorro');
  });
});
