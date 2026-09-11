import { useCallback, useEffect, useRef } from 'react';

/**
 * Recarga la pantalla cuando el usuario VUELVE a la pestaña.
 *
 * 🔴 Mati (09/09/2026): *"cuando Jorgelina modifica un presupuesto desde la aplicación de
 * InfoManager, esa modificación no se está actualizando en la aplicación"*.
 *
 * No era un cache del server —`fetchVentas` va a InfoManager cada vez y la vista sólo se guarda
 * 90 segundos—: era que **la pantalla no se refrescaba nunca sola**. Se carga al abrirla y
 * listo. El trabajo real es ir a IM, editar, y volver a la pestaña del panel, que sigue
 * mostrando lo que trajo hace veinte minutos.
 *
 * 🪤 Con un mínimo de tiempo entre recargas: sin eso, cada vez que alguien pasa por la pestaña
 * —aunque sea un segundo— se dispara una consulta a IM que tarda varios segundos. La pantalla
 * de presupuestos es de las caras.
 */
export function useRecargarAlVolver(recargar: () => void, esperaMs = 30_000) {
  const ultima = useRef(Date.now());
  const fn = useRef(recargar);
  fn.current = recargar;

  useEffect(() => {
    const alVolver = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - ultima.current < esperaMs) return;
      ultima.current = Date.now();
      fn.current();
    };
    document.addEventListener('visibilitychange', alVolver);
    // `focus` cubre el caso de dos ventanas lado a lado, donde la pestaña nunca se oculta.
    window.addEventListener('focus', alVolver);
    return () => {
      document.removeEventListener('visibilitychange', alVolver);
      window.removeEventListener('focus', alVolver);
    };
  }, [esperaMs]);

  /** Para avisar que ya se recargó por otro motivo y no repetir el viaje a IM. */
  return useCallback(() => { ultima.current = Date.now(); }, []);
}
