import path from 'node:path';
import { pathToFileURL } from 'node:url';
const repo = path.resolve(process.env.REPARTO_TEST_REPO || '.');
const { chromium } = await import(pathToFileURL(path.join(repo, 'node_modules/playwright-core/index.mjs')).href);
import fs from 'node:fs/promises';
const out = path.resolve(process.env.REPARTO_TEST_OUTPUT || path.join(repo,'tests/artifacts-reparto'));
await fs.mkdir(out, { recursive: true });
const base = process.env.REPARTO_TEST_URL || 'http://127.0.0.1:4177';
if(new URL(base).hostname !== '127.0.0.1')throw new Error('Sólo se permite preview local');
const browser = await chromium.launch({headless:true});
const results = {scope:'Frontend real compilado, API simulada; cero llamadas a servicios reales', cases:[], consoleErrors:[]};
const user = {id:'10000000-0000-0000-0000-000000000099',rol:'administrativo',nombre:'Oficina · auditoría',email:'audit@example.invalid',cod_vendedor:null};
const row = (id,name,date='2026-09-10') => ({im_comprobante_id:id,im_numero:Number(id),fecha:date,cliente_nombre:name,cod_cliente:Number(id),total:150000,bultos:10,kg:300,cod_zona:9,zona:'Lules · Manantial',zona_origen:'im',gravedad:{pierde_margen:0,cobra_de_mas:0},avisos:[],faltantes:[],avisos_cantidad:[],hermanos:[],revision:null,factura:null,stock_consultado:true,control_disponible:true,controles_completos:true,peso_completo:true,controles:{items:true,listas:true,stock:true},huella:'v'+id});
const rows=[row('101','CLIENTE ALFA'),row('102','CLIENTE BETA')];
const presupuestos=(rs=rows)=>({presupuestos:rs,totales:{importe:rs.length*150000,kg:rs.length*300},sin_revisar:rs.length});
const item=(id,desc)=>({id,cod_articulo:id,descripcion:desc,cantidad:2,cod_lista_precios:12,precio:1000,precio_neto:1000,descuento_porc:0,importe:2000,stock:200,equivalencia_um:30,unidad_de_medida:'BOLSA'});
const reply=(route,data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
async function setup(width=1440, options={}) {
  const ctx=await browser.newContext({serviceWorkers:'block',viewport:{width,height:900}});
  await ctx.addInitScript(()=>localStorage.setItem('auth_token','audit-local-only'));
  const page=await ctx.newPage();
  page.setDefaultTimeout(8000);
  await page.clock.setFixedTime(new Date('2026-09-11T15:00:00Z'));
  page.on('pageerror',e=>results.consoleErrors.push(e.message));
  const seen=[];
  await ctx.route('**/*',async route=>{
    const u=new URL(route.request().url());
    if(u.hostname!=='127.0.0.1') return route.abort();
    if(!u.pathname.startsWith('/api/')) return route.continue();
    seen.push(u.pathname+u.search);
    if(u.pathname==='/api/me') return reply(route,{ok:true,user});
    if(u.pathname==='/api/presupuestos') return reply(route,presupuestos());
    if(u.pathname==='/api/presupuestos/consolidado') return reply(route,{articulos:[],totales:{articulos:0,faltantes:0,sin_renglones:0}});
    if(u.pathname==='/api/presupuestos/fraccionado') return reply(route,{completo:true,dias_faltantes:[],comprobantes_sin_items:[],comprobantes:2,fraccionado:[{descripcion:'ALPISTE AUDITORÍA',cantidades:[5,10,15],paquetes:3,kg:30,bolsas_enteras:0,formato_bolsa:30}],totales:{productos:1,paquetes:3,kg:30}});
    if(u.pathname==='/api/facturacion') return reply(route,{pendientes:rows,facturados:[],sin_aprobar:0,totales:{pendientes:2,importe_pendiente:300000}});
    if(u.pathname==='/api/hojas-ruta/camiones') return reply(route,{camiones:[{id:'c1',nombre:'Camión 5000',capacidad_kg:5000}]});
    if(u.pathname==='/api/choferes') return reply(route,{choferes:[{id:'ch1',nombre:'Chofer auditoría'}]});
    if(u.pathname==='/api/hojas-ruta/pendientes') return reply(route,{pendientes:rows.map(r=>({...r,factura_origen:'unica',im_factura_numero:4000,im_numero:5000})),dias_sin_items:[]});
    if(u.pathname==='/api/hojas-ruta/arrastre') return reply(route,{ok:true,cantidad:0});
    if(u.pathname==='/api/hojas-ruta') return reply(route,{hojas:[]});
    if(u.pathname==='/api/liquidacion') return reply(route,{mes:u.searchParams.get('mes'),choferes:[],totales:{hojas:0,pedidos:0,kg:0,importe:0},sin_cerrar:{hojas:0,importe:0}});
    if(u.pathname==='/api/retiros') return reply(route,{retiros:[]});
    if(u.pathname==='/api/retiros/resumen') return reply(route,{clientes:[],totales:{pedidos:0,clientes:0,kg:0,bultos:0,importe:0,sin_retirar:0}});
    if(/^\/api\/presupuestos\/\d+$/.test(u.pathname)) return reply(route,{items:[item(10,'PRODUCTO DE PRUEBA')],comprobante:{im_comprobante_id:u.pathname.split('/').pop(),numero:Number(u.pathname.split('/').pop()),cod_cliente:Number(u.pathname.split('/').pop()),cliente_nombre:Number(u.pathname.split('/').pop())===101?'CLIENTE ALFA':'CLIENTE BETA',fecha:'2026-09-10',observaciones:'',huella:'v'+u.pathname.split('/').pop()}});
    return reply(route,{error:'Ruta sin fixture: '+u.pathname},501);
  });
  if(options.beforeGoto)await options.beforeGoto(page,ctx);
  await page.goto(base + (options.url || '/reparto'));
  await page.locator(options.ready || '.pr-fila').first().waitFor();
  return {page,ctx,seen};
}
const assert = (value, message) => { if (!value) throw new Error(message); };
async function test(name, run) {
  try { await run(); results.cases.push({name,passed:true}); }
  catch(e) { results.cases.push({name,passed:false,error:e.message}); }
}
export {browser,results,out,base,user,row,rows,presupuestos,item,reply,setup,assert,test};
