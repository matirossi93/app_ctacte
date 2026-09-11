import { cabeceraComprobante, type CabeceraComprobante } from './infomanager.js';

/**
 * Una sola lectura de cada cabecera por petición HTTP.
 *
 * Una FA que cae fuera del rango que se está mirando no aparece en el listado de `/ventas`, así
 * que el control de vigencia y la actualización de importes la piden cada uno por su cuenta: dos
 * GET de la misma cabecera en la misma carga.
 *
 * 🪤 Es request-local a propósito, no un cache global: vive lo que dura la petición y se
 * descarta con ella. No cambia ningún TTL ni reutiliza una lectura anterior a una escritura.
 *
 * El rechazo se comparte igual que el éxito: si el GET falla, falla para los dos, y cada uno
 * decide qué hacer (`existe: null` sigue siendo "no sé", no "no existe").
 */
export type LeerCabecera = (id: string) => Promise<CabeceraComprobante>;

export function cabecerasCompartidas(leer: LeerCabecera = cabeceraComprobante): LeerCabecera {
  const enVuelo = new Map<string, Promise<CabeceraComprobante>>();
  return (id: string) => {
    const k = String(id);
    let p = enVuelo.get(k);
    if (!p) {
      p = leer(k);
      // Sin esto, un rechazo que todavía nadie esperó queda como unhandled rejection.
      p.catch(() => {});
      enVuelo.set(k, p);
    }
    return p;
  };
}
