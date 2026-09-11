import { getToken, getUser, instalarGuardiaAuth } from '../utils/auth';
import { FronteraSesion } from '../utils/fronteraSesion';
import { invalidarLecturasReparto } from '../utils/lecturaVigente';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

type Trabajo = { motivo: string };
type Contexto = {
  ocupado: boolean; puedeNavegar: () => boolean;
  comenzar: (id: symbol, motivo: string) => void; terminar: (id: symbol) => void;
  borradores: Map<string, any>;
};
const Context = createContext<Contexto | null>(null);
export function RepartoProvider({children}:{children:ReactNode}) {
  const trabajos = useRef(new Map<symbol, Trabajo>());
  const borradores = useRef(new Map<string, any>());
  const [ocupado, setOcupado] = useState(false);
  const frontera = useRef(new FronteraSesion(getToken(), getUser()?.email ?? null));
  const [sesionCambiada, setSesionCambiada] = useState(false);
  const sesionBloqueada = useRef(false);
  const avisoSesion = useRef<HTMLDialogElement>(null);
  const validarSesion = useCallback(() => {
    if (sesionBloqueada.current) return false;
    if (frontera.current.coincide(getToken(), getUser()?.email ?? null)) return true;
    sesionBloqueada.current = true; borradores.current.clear(); invalidarLecturasReparto(); setSesionCambiada(true);
    return false;
  }, []);
  useLayoutEffect(() => instalarGuardiaAuth(() => {
    if (!validarSesion()) throw new Error('La sesión cambió. Revalidá el acceso antes de continuar.');
  }), [validarSesion]);
  useEffect(() => {
    const cambio = (e: StorageEvent) => { if (e.key === 'auth_token' || e.key === 'auth_user' || e.key === null) validarSesion(); };
    const foco = () => { validarSesion(); };
    window.addEventListener('storage', cambio); window.addEventListener('focus', foco);
    return () => { window.removeEventListener('storage', cambio); window.removeEventListener('focus', foco); };
  }, [validarSesion]);
  useEffect(() => {
    if (sesionCambiada && !avisoSesion.current?.open) avisoSesion.current?.showModal();
  }, [sesionCambiada]);
  const comenzar = useCallback((id:symbol,motivo:string)=>{invalidarLecturasReparto();trabajos.current.set(id,{motivo});setOcupado(true);},[]);
  const terminar = useCallback((id:symbol)=>{trabajos.current.delete(id);setOcupado(trabajos.current.size>0);},[]);
  const puedeNavegar = useCallback(()=>validarSesion() && trabajos.current.size===0,[validarSesion]);
  useEffect(()=>{
    const salir=(e:BeforeUnloadEvent)=>{if(trabajos.current.size || borradores.current.size){e.preventDefault();e.returnValue='';}};
    window.addEventListener('beforeunload',salir);return()=>window.removeEventListener('beforeunload',salir);
  },[]);
  return <Context.Provider value={{ocupado: ocupado || sesionCambiada,puedeNavegar,comenzar,terminar,borradores:borradores.current}}>{children}
    {sesionCambiada && <dialog ref={avisoSesion} aria-label="Sesión cambiada" onCancel={e => e.preventDefault()} style={{ maxWidth: 'min(480px, 90vw)', border: 0, borderRadius: 8, padding: '1.5rem' }}>
      <h2>La sesión cambió en otra pestaña</h2>
      <p>Esta pantalla pertenece a la sesión anterior. Se bloquearon las nuevas acciones para no mezclar pedidos ni borradores entre usuarios.</p>
      {ocupado ? <p role="status">Hay una operación en curso. Conservamos su respuesta; esperá a que termine antes de revalidar el acceso.</p> : <p>La operación anterior ya no está en curso en esta pantalla. Si su resultado fue incierto, verificá su estado al volver a ingresar.</p>}
      <button disabled={ocupado} onClick={() => { if (trabajos.current.size) return; borradores.current.clear(); location.reload(); }}>Revalidar acceso</button>
    </dialog>}
  </Context.Provider>;
}
export function useReparto() { const c=useContext(Context); if(!c)throw Error('Falta el contexto de reparto'); return c; }
export function useOperacionReparto(motivo:string) {
  const ctx=useContext(Context); const id=useRef(Symbol(motivo)); const enCurso=useRef(false);
  const comenzar=()=>{if(enCurso.current || (ctx && !ctx.puedeNavegar()))return false;enCurso.current=true;ctx?.comenzar(id.current,motivo);return true;};
  const terminar=()=>{enCurso.current=false;ctx?.terminar(id.current);};
  return {enCurso,comenzar,terminar}; // No liberar una operación por cleanup de Activity.
}
