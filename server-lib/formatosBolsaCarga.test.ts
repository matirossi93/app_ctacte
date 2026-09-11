import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({leer:vi.fn()}));
vi.mock('./infomanager.js',()=>({fechaArgentina:()=> '2026-09-11',fetchVentas:async()=>Array.from({length:4},(_,i)=>({id:String(i),tipo_comprobante:'PR',fecha:`2026-09-${String(i+1).padStart(2,'0')}`,anulada:'N'})),fetchArticulosCatalogo:async()=>new Map([[1,{unidad_de_medida:'Kilos'}]]),fetchVentasItems:(...args:any[])=>m.leer(...args)}));
import {formatosDeBolsa,_resetFormatos} from './formatosBolsa.js';
import {lecturaLimitada} from './lecturasCompartidas.js';
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-11'));_resetFormatos();m.leer.mockReset();});
afterEach(()=>vi.useRealTimers());
it('un refresco lento de formatos ocupa un slot y deja entrar una lectura interactiva',async()=>{
 let activas=0,maximas=0;
 m.leer.mockImplementation(()=>lecturaLimitada(async()=>{activas++;maximas=Math.max(maximas,activas);await new Promise(r=>setTimeout(r,6000));activas--;return [];}));
 formatosDeBolsa();await vi.advanceTimersByTimeAsync(0);
 const interactiva=lecturaLimitada(async()=> 'dato de la oficina').catch(e=>e);
 await vi.advanceTimersByTimeAsync(5001);
 const resultado=await interactiva;
 await vi.runAllTimersAsync();
 expect(resultado).toBe('dato de la oficina');expect(m.leer).toHaveBeenCalledTimes(4);expect(maximas).toBe(1);
});
