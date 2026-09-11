import { useEffect, useRef, type CSSProperties } from 'react';
export const estiloDialogo:CSSProperties={width:'100vw',height:'100dvh',maxWidth:'none',maxHeight:'none',margin:0,padding:0,border:0,color:'inherit'};
/** Diálogo nativo: fondo inerte, foco contenido y Escape controlado. */
export function useDialogoReparto(cerrar:()=>void) {
  const ref=useRef<HTMLDialogElement>(null), solicitud=useRef(cerrar);solicitud.current=cerrar;
  useEffect(()=>{
    const dialogo=ref.current;if(!dialogo)return;
    const anterior=document.activeElement as HTMLElement|null;
    if(!dialogo.open)dialogo.showModal();
    const cancelar=(e:Event)=>{e.preventDefault();solicitud.current();};dialogo.addEventListener('cancel',cancelar);
    return()=>{dialogo.removeEventListener('cancel',cancelar);dialogo.close();if(anterior?.isConnected)anterior.focus();};
  },[]);
  return ref;
}
