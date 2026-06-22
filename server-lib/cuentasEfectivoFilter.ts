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
 * de efectivo que se ofrecen en la aprobación, ordenadas con el default primero.
 *
 * `allowed` es una lista blanca (nombres y/o cod_cuenta) de las cajas que
 * queremos mostrar — IM tiene decenas de cajas (diferencias, puente, reservas,
 * por vendedor/sucursal, etc.) y solo usamos un par. Si `allowed` viene con
 * elementos, SOLO se muestran esas (match por nombre normalizado exacto o por
 * cod_cuenta). Si `allowed` está vacío, cae a la heurística amplia (cualquier
 * "caja"/"efectivo" que no sea "caja de ahorro", que es banco).
 *
 * El default resuelto siempre queda disponible (se agrega si el filtro no lo
 * incluye) para que el pago nunca quede sin cuenta.
 */
export function filterCuentasEfectivo(cuentas: PlanCuentaLite[], defaultCod: string, allowed: string[] = []): CuentaEfectivo[] {
  const allowSet = allowed.map(a => normalizeCuentaNombre(a)).filter(Boolean);
  const useAllow = allowSet.length > 0;

  const cash = cuentas
    .filter(c => c.cod_cuenta)
    .filter(c => {
      const n = normalizeCuentaNombre(c.nombre);
      if (useAllow) {
        // Match exacto por nombre normalizado o por código de cuenta.
        return allowSet.includes(n) || allowSet.includes(normalizeCuentaNombre(c.cod_cuenta));
      }
      return (n.includes('caja') || n.includes('efectivo')) && !n.includes('ahorro');
    })
    .map(c => ({ cod_cuenta: c.cod_cuenta, nombre: c.nombre, es_default: c.cod_cuenta === defaultCod }));

  // Garantizar que el default resuelto esté en la lista aunque el filtro no lo agarre.
  if (defaultCod && !cash.some(c => c.cod_cuenta === defaultCod)) {
    cash.unshift({ cod_cuenta: defaultCod, nombre: '(cuenta efectivo por defecto)', es_default: true });
  }
  // Default primero; el resto por nombre.
  cash.sort((a, b) => (a.es_default === b.es_default ? a.nombre.localeCompare(b.nombre, 'es') : a.es_default ? -1 : 1));
  return cash;
}
