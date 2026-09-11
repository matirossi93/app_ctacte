import {beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({tablas:{} as Record<string,any[]>,fallarDesde:-1,consultas:[] as Array<{tabla:string,desde:number,hasta:number,orden:string[]}>}));
vi.mock('./infomanager.js',()=>({}));
vi.mock('./supabase.js',()=>({TENANT_ID:'t',sb:()=>({from:(tabla:string)=>{
 let desde=0,hasta=999;const orden:string[]=[];const filtros:Array<(f:any)=>boolean>=[];
 const q:any={select:()=>q,eq:(k:string,v:any)=>{filtros.push(f=>f[k]===v);return q;},in:(k:string,vs:any[])=>{filtros.push(f=>vs.includes(f[k]));return q;},not:(k:string)=>{filtros.push(f=>f[k]!=null);return q;},or:()=>q,order:(k:string)=>{orden.push(k);return q;},range:(a:number,b:number)=>{desde=a;hasta=b;return q;},then:(r:any)=>{
 m.consultas.push({tabla,desde,hasta,orden});return Promise.resolve(tabla==='facturas_correcciones'&&desde===m.fallarDesde?{data:null,error:{message:'página fallida'}}:{data:(m.tablas[tabla]??[]).filter(f=>filtros.every(fn=>fn(f))).slice(desde,hasta+1),error:null}).then(r);
 }};return q;}})}));
import {notasDeHoja} from './repartoDatos.js';
const entregas=Array.from({length:150},(_,i)=>({im_comprobante_id:String(1000+i),im_factura_id:String(2000+i)}));
const notas=entregas.flatMap((f,i)=>Array.from({length:10},(_,j)=>({id:String(i*10+j),tenant_id:'t',im_factura_id:f.im_factura_id,im_comprobante_id:String(10000+i*10+j),tipo:'NC',total:1,numero:j})));
beforeEach(()=>{m.tablas={facturas_correcciones:notas};m.fallarDesde=-1;m.consultas=[];});
it('150 facturas con10 notas conservan1500 sin depender del tope1000 de PostgREST',async()=>{
 const filas=await notasDeHoja('h',entregas);expect(filas.reduce((n,f)=>n+f.notas.length,0)).toBe(1500);
 const consultas=m.consultas.filter(q=>q.tabla==='facturas_correcciones');expect(consultas.map(q=>q.desde)).toEqual([0,500,1000,1500]);expect(consultas.every(q=>q.orden.includes('id'))).toBe(true);
});
it('también pagina ajustes de entrega y deduplica IDs presentes en ambas fuentes',async()=>{
 m.tablas.hojas_ruta_ajustes=notas.map((n,i)=>({id:n.id,tenant_id:'t',hoja_id:'h',im_comprobante_id:String(1000+Math.floor(i/10)),im_ajuste_id:n.im_comprobante_id,tipo:'nc',importe:1,emitido_at:'2026-09-11'}));
 const filas=await notasDeHoja('h',entregas);expect(filas.reduce((n,f)=>n+f.notas.length,0)).toBe(1500);expect(m.consultas.filter(q=>q.tabla==='hojas_ruta_ajustes').map(q=>q.desde)).toEqual([0,500,1000,1500]);
});
it('un fallo de página impide publicar el cobro parcial',async()=>{m.fallarDesde=500;await expect(notasDeHoja('h',entregas)).rejects.toThrow('página fallida');});
