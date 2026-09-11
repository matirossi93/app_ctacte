import {expect,it,vi} from 'vitest';
import {LecturaVigente,seleccionVisible,alternarVisibles,invalidarLecturasReparto} from './lecturaVigente';
it('el rango o petición anterior nunca confirma ni después de reactivar',()=>{
 const c=new LecturaVigente();let clave='A';const a=c.iniciar('A',()=>clave==='A')!;
 clave='B';const b=c.iniciar('B',()=>clave==='B')!;expect(a.vigente()).toBe(false);expect(a.signal.aborted).toBe(true);
 c.invalidar();clave='A';expect(a.vigente()).toBe(false);expect(b.vigente()).toBe(false);
});
it('lectura reciente se reutiliza; force y clave nueva releen',()=>{
 vi.useFakeTimers();const c=new LecturaVigente();c.iniciar('A',()=>true)!.confirmar();
 expect(c.iniciar('A',()=>true)).toBeNull();expect(c.iniciar('A',()=>true,true)).not.toBeNull();expect(c.iniciar('B',()=>true)).not.toBeNull();vi.useRealTimers();
});
it('todos visibles compara identidad, conserva elegidos ocultos y estado parcial',()=>{
 const s=new Set(['ALFA']);expect(seleccionVisible(['BETA'],s)).toEqual({todos:false,parcial:false,ocultos:1});
 const ambos=alternarVisibles(['BETA'],s);expect([...ambos]).toEqual(['ALFA','BETA']);
 expect([...alternarVisibles(['BETA'],ambos)]).toEqual(['ALFA']);expect(seleccionVisible(['ALFA','BETA'],s).parcial).toBe(true);
});
import { contextoReparto, rangoValido } from './contextoReparto';
it('una invalidación por escritura fuerza lectura aunque la vista vuelva pronto',()=>{
 const c=new LecturaVigente();c.iniciar('A',()=>true)!.confirmar();c.caducar();expect(c.iniciar('A',()=>true)).not.toBeNull();
});
it('URL conserva etapa y rango válido; no aplica fechas vacías, invertidas o imposibles',()=>{
 expect(contextoReparto('?etapa=hojas&desde=2026-09-01&hasta=2026-09-11&hoja=abc-123','2026-09-11')).toEqual({etapa:'hojas',rango:{desde:'2026-09-01',hasta:'2026-09-11'},hoja:'abc-123'});
 expect(rangoValido('2026-02-30','2026-03-02')).toBe(false);expect(rangoValido('','2026-09-11')).toBe(false);expect(rangoValido('2026-09-12','2026-09-11')).toBe(false);
 expect(contextoReparto('?etapa=otra&desde=&hasta=2026-09-11','2026-09-11').etapa).toBe('presupuestos');
});

it('una escritura invalida también el cache de otras etapas, sin iniciar consultas ocultas',()=>{
 const a = new LecturaVigente(), b = new LecturaVigente(); a.iniciar('A',()=>true)!.confirmar(); const vieja = b.iniciar('B',()=>true)!;
 invalidarLecturasReparto(); vieja.confirmar();
 expect(a.iniciar('A',()=>true)).not.toBeNull(); expect(b.iniciar('B',()=>true)).not.toBeNull();
});

it('A confirmado → B pendiente → A vuelve a leer: no reutiliza una marca cuyo contenido se vació',()=>{
 const c = new LecturaVigente(); c.iniciar('A',()=>true)!.confirmar();
 const b = c.iniciar('B',()=>true)!; const a = c.iniciar('A',()=>true);
 expect(a).not.toBeNull(); expect(b.signal.aborted).toBe(true); expect(b.vigente()).toBe(false);
});

import { FronteraSesion } from './fronteraSesion';
it('la pantalla no puede adoptar credenciales nuevas sobre el borrador del usuario anterior',()=>{
 const frontera = new FronteraSesion('token-A', 'a@example.invalid');
 expect(frontera.coincide('token-A', 'a@example.invalid')).toBe(true);
 expect(frontera.coincide('token-B', 'b@example.invalid')).toBe(false);
 expect(frontera.coincide('token-B', 'a@example.invalid')).toBe(false);
 expect(frontera.coincide(null, null)).toBe(false);
});
