export type EstadoObjetivo = 'completado' | 'parcial' | 'sin_compras' | 'sin_objetivo';

/**
 * En qué estado está un cliente respecto de su objetivo del mes.
 *
 * 🪤 `avance >= objetivo` con los dos en CERO da `true`, así que un cliente al que nadie le
 * cargó objetivo aparecía como **COMPLETADO** en verde, llenaba la pantalla de Objetivos e
 * inflaba el contador de completados (Mati, 16/09/2026: *"aparece toda esta lista de clientes
 * al pedo"*). Un objetivo de cero no es un objetivo cumplido: es un objetivo que no existe.
 */
export function estadoObjetivoCliente(objetivo: number | null | undefined, avance: number): EstadoObjetivo {
  if (objetivo == null || !(objetivo > 0)) return 'sin_objetivo';
  if (avance >= objetivo) return 'completado';
  return avance > 0 ? 'parcial' : 'sin_compras';
}
