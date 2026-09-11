import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LecturasCompartidas } from './lecturasCompartidas.js';
const diferido = <T>() => { let resolver!: (valor:T)=>void; const promesa=new Promise<T>(r=>{resolver=r;}); return {promesa,resolver}; };
afterEach(() => vi.useRealTimers());
describe('lecturas compartidas y generaciones', () => {
  it('ocho lectores comparten un GET y una actualización fuerza otra generación', async () => {
    const cache=new LecturasCompartidas<number>(); const viejo=diferido<number>(); const nuevo=diferido<number>();
    const leer=vi.fn(()=>viejo.promesa);
    const a=Array.from({length:8},()=>cache.obtener('k',leer)); await Promise.resolve(); expect(leer).toHaveBeenCalledTimes(1);
    const b=cache.obtener('k',()=>nuevo.promesa,{actualizar:true}); const c=cache.obtener('k',leer,{actualizar:true});
    nuevo.resolver(2); expect(await b).toBe(2); expect(await c).toBe(2); viejo.resolver(1); await Promise.all(a);
    expect(await cache.obtener('k',leer)).toBe(2);
  });
  it('invalidar durante el vuelo y verificar jamás reutilizan la lectura anterior', async () => {
    const cache=new LecturasCompartidas<number>(); const viejo=diferido<number>(); const a=cache.obtener('k',()=>viejo.promesa);
    cache.invalidar(); expect(await cache.obtener('k',async()=>2,{verificar:true})).toBe(2);
    viejo.resolver(1); await a; expect(await cache.obtener('k',async()=>3)).toBe(2);
  });
  it('un error no queda cacheado',async()=>{ const c=new LecturasCompartidas<number>(); await expect(c.obtener('k',async()=>{throw Error('x')})).rejects.toThrow('x'); expect(await c.obtener('k',async()=>2)).toBe(2); });
});
describe('pool global de GET',()=>{
  beforeEach(()=>{ vi.resetModules();vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-11')); });
  it('conserva una pausa de una hora y rechaza rápido sin enviar GET',async()=>{
    const {pausarLecturas,lecturaLimitada}=await import('./lecturasCompartidas.js'); const leer=vi.fn();
    pausarLecturas(3600_000); await expect(lecturaLimitada(leer)).rejects.toMatchObject({retryable:false});
    await vi.advanceTimersByTimeAsync(60_000); await expect(lecturaLimitada(leer)).rejects.toMatchObject({retryable:false}); expect(leer).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('cuatro slots y plazo de cola; un request vencido nunca se envía después',async()=>{
    const {lecturaLimitada}=await import('./lecturasCompartidas.js'); const pendientes=Array.from({length:4},()=>diferido<number>());
    const activas=pendientes.map(d=>lecturaLimitada(()=>d.promesa)); const leer=vi.fn(async()=>5);
    const espera=expect(lecturaLimitada(leer)).rejects.toMatchObject({retryable:false}); await vi.advanceTimersByTimeAsync(5001); await espera;
    pendientes.forEach(d=>d.resolver(1)); await Promise.all(activas); expect(leer).not.toHaveBeenCalled(); expect(await lecturaLimitada(async()=>9)).toBe(9);
  });
});
