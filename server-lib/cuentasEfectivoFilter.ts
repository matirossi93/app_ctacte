// Filtro PURO de cuentas de EFECTIVO (cajas físicas) del plan de cuentas de IM.
// Vive en su propio archivo SIN imports con efectos secundarios para poder
// testearlo: cuentasResolver.ts importa infomanager.ts, que hace process.exit
// al cargar si falta INFOMANAGER_CLIENT_SECRET (no disponible en tests).

export interface PlanCuentaLite {
  cod_cuenta: string;
  nombre: string;
}

export interface CuentaEfectivo {
  cod_cuenta: string;
  nombre: string;
  es_default: boolean;
}

export function normalizeCuentaNombre(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // quita tildes
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Dado el plan de cuentas y el cod de la caja por defecto, devuelve las cuentas
 * de efectivo (cajas físicas) ordenadas con el default primero. Incluye nombres
 * con "caja" o "efectivo" y EXCLUYE "caja de ahorro" (que es una cuenta
 * bancaria, no efectivo físico). Garantiza que el default esté en la lista.
 */
export function filterCuentasEfectivo(cuentas: PlanCuentaLite[], defaultCod: string): CuentaEfectivo[] {
  const cash = cuentas
    .filter(c => {
      const n = normalizeCuentaNombre(c.nombre);
      return (n.includes('caja') || n.includes('efectivo')) && !n.includes('ahorro');
    })
    .filter(c => c.cod_cuenta)
    .map(c => ({ cod_cuenta: c.cod_cuenta, nombre: c.nombre, es_default: c.cod_cuenta === defaultCod }));

  // Garantizar que el default resuelto esté en la lista aunque el filtro no lo agarre.
  if (defaultCod && !cash.some(c => c.cod_cuenta === defaultCod)) {
    cash.unshift({ cod_cuenta: defaultCod, nombre: '(cuenta efectivo por defecto)', es_default: true });
  }
  // Default primero; el resto por nombre.
  cash.sort((a, b) => (a.es_default === b.es_default ? a.nombre.localeCompare(b.nombre, 'es') : a.es_default ? -1 : 1));
  return cash;
}
