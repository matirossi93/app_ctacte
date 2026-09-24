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
  /**
   * 🔑 24/09/2026: la pantalla de facturar mostró "pausa hasta 2026-09-24T14:35:25.498Z". Es UTC,
   * tres horas corrida, en un formato que nadie en la oficina lee.
   */
  it('la pausa se informa en hora de Argentina, sin adelantarse',async()=>{
    vi.setSystemTime(new Date('2026-09-24T14:32:30.498Z'));
    const {pausarLecturas,lecturaLimitada}=await import('./lecturasCompartidas.js');
    pausarLecturas(175_000);   // hasta las 14:35:25 UTC: las 11:35:25 acá
    const error:any=await lecturaLimitada(vi.fn()).catch(e=>e);
    expect(error.message).toMatch(/hasta las 11:36\. /);
    // 🪤 En el contenedor es-AR salió "12:36 p. m.." (12 h y doble punto): tiene que ser 24 h.
    vi.setSystemTime(new Date('2026-09-24T15:34:00Z'));
    pausarLecturas(60_000);
    const tarde:any=await lecturaLimitada(vi.fn()).catch(e=>e);
    expect(tarde.message).toMatch(/hasta las 12:35\. No se/);
    expect(error.message).not.toMatch(/2026-09-24T|Z\b/);
  });
  it('cuatro slots y plazo de cola; un request vencido nunca se envía después',async()=>{
    const {lecturaLimitada}=await import('./lecturasCompartidas.js'); const pendientes=Array.from({length:4},()=>diferido<number>());
    const activas=pendientes.map(d=>lecturaLimitada(()=>d.promesa)); const leer=vi.fn(async()=>5);
    const espera=expect(lecturaLimitada(leer)).rejects.toMatchObject({retryable:false}); await vi.advanceTimersByTimeAsync(5001); await espera;
    pendientes.forEach(d=>d.resolver(1)); await Promise.all(activas); expect(leer).not.toHaveBeenCalled(); expect(await lecturaLimitada(async()=>9)).toBe(9);
  });
});

/**
 * 🔴 EL WARM DE FONDO NO PUEDE DEJAR SIN LECTURAS A QUIEN ESTÁ ESPERANDO EN PANTALLA.
 *
 * 16/09/2026: al reiniciar el contenedor arranca el prewarm de 6 meses (ventas + items de cada
 * uno, 35-105 s por mes). Mientras corría, Jorgelina facturó 4 pedidos: las facturas salieron,
 * los remitos quedaron colgados y la pantalla mostró "No se pudo facturar. No se sabe qué llegó a
 * emitirse" por $1.042.470. El pool tiene 4 lugares y el warm se los estaba comiendo.
 */
describe('el trabajo de fondo cede el paso',()=>{
  beforeEach(()=>{ vi.resetModules();vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-16')); });

  it('🔴 cuatro warms a la vez no tapan al usuario', async () => {
    const {lecturaLimitada,enSegundoPlano}=await import('./lecturasCompartidas.js');
    const warms=Array.from({length:4},()=>diferido<number>());
    const enVuelo=warms.map(d=>enSegundoPlano(()=>lecturaLimitada(()=>d.promesa)));
    await vi.advanceTimersByTimeAsync(0);
    const leer=vi.fn(async()=>9);
    const mia=lecturaLimitada(leer);
    await vi.advanceTimersByTimeAsync(0);
    expect(leer).toHaveBeenCalled();
    expect(await mia).toBe(9);
    warms.forEach(d=>d.resolver(1)); await Promise.all(enVuelo);
  });

  it('🔑 y el de fondo espera en vez de fallar: no tiene a nadie del otro lado', async () => {
    const {lecturaLimitada,enSegundoPlano}=await import('./lecturasCompartidas.js');
    const ocupados=Array.from({length:4},()=>diferido<number>());
    const enVuelo=ocupados.map(d=>lecturaLimitada(()=>d.promesa));
    await vi.advanceTimersByTimeAsync(0);
    const leer=vi.fn(async()=>7);
    const warm=enSegundoPlano(()=>lecturaLimitada(leer));
    // A los 10 s uno de primer plano ya habría sido rechazado (el plazo es 5 s).
    await vi.advanceTimersByTimeAsync(10_000);
    expect(leer).not.toHaveBeenCalled();
    ocupados.forEach(d=>d.resolver(1)); await Promise.all(enVuelo);
    await vi.advanceTimersByTimeAsync(0);
    expect(await warm).toBe(7);
  });

  it('🔴 un warm encolado no puede tapar al que entró después y sí tiene lugar', async () => {
    const {lecturaLimitada,enSegundoPlano}=await import('./lecturasCompartidas.js');
    // Un warm ocupa el único lugar de fondo; tres de primer plano ocupan el resto.
    const warm0=diferido<number>(); const v0=enSegundoPlano(()=>lecturaLimitada(()=>warm0.promesa));
    const ocupados=Array.from({length:3},()=>diferido<number>());
    const enVuelo=ocupados.map(d=>lecturaLimitada(()=>d.promesa));
    await vi.advanceTimersByTimeAsync(0);
    // Este warm queda en la cola sin lugar de fondo...
    const leerWarm=vi.fn(async()=>1); const encolado=enSegundoPlano(()=>lecturaLimitada(leerWarm));
    // ...y detrás llega el usuario.
    const leer=vi.fn(async()=>9); const mia=lecturaLimitada(leer);
    await vi.advanceTimersByTimeAsync(0);
    // Se libera UN lugar de primer plano: tiene que tomarlo el usuario, no el warm encolado.
    ocupados[0].resolver(1); await vi.advanceTimersByTimeAsync(0);
    expect(leer).toHaveBeenCalled();
    expect(leerWarm).not.toHaveBeenCalled();
    expect(await mia).toBe(9);
    ocupados.slice(1).forEach(d=>d.resolver(1)); warm0.resolver(1);
    await Promise.all(enVuelo); await v0; await vi.advanceTimersByTimeAsync(0);
    expect(await encolado).toBe(1);
  });
});

