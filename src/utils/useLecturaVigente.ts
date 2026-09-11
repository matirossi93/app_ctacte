import { useCallback, useEffect, useRef } from 'react';
import { LecturaVigente } from './lecturaVigente';
export function useLecturaVigente(clave: string) {
  const control = useRef(new LecturaVigente());
  const actual = useRef(clave); actual.current = clave;
  const viva = useRef(false);
  useEffect(() => { viva.current = true; return () => { viva.current = false; control.current.invalidar(); }; }, [clave]);
  const iniciar = useCallback((forzar = false) => {
    if (!viva.current) { if (forzar) control.current.caducar(); return null; }
    return control.current.iniciar(clave, () => viva.current && actual.current === clave, forzar);
  }, [clave]);
  const invalidar = useCallback(() => control.current.invalidar(), []);
  return { iniciar, invalidar };
}
