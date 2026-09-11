import fs from 'node:fs/promises';
import {browser,results,out,base,user,row,rows,presupuestos,item,reply,setup,assert,test} from './browser-fixtures.mjs';
try {
 for(const width of [1440,390]){
  const {page,ctx}=await setup(width);
  const h={version:1,id:'h1',numero:3400,fecha:'2026-09-10',turno:'Mañana',camion:'Camión 5000',camion_id:'c1',capacidad_kg:5000,chofer:'Chofer auditoría',chofer_id:'ch1',estado:'abierta',facturada:true,pedidos:rows.map(x=>({...x,saldo_anterior:25000,im_remito_numero:5000,im_factura_numero:4000,facturado_at:'2026-09-10'})),totales:{pedidos:2,bultos:20,kg:600},carga:{porcentaje:12,excedido:false,sobra_kg:4400}};
  await page.route('**/api/hojas-ruta?**',r=>reply(r,{hojas:[h]}));
  const clients=Array.from({length:80},(_,i)=>({cod_empresa:1,cod_cliente:i+1,cliente_nombre:'CLIENTE IMPRESO '+String(i+1).padStart(3,'0'),saldo_anterior:25000,total:150000,bultos:10,kg:300,comprobantes:[{im_numero:5000+i,bultos:10,kg:300,total:150000,facturado:true}]}));
  await page.route('**/api/hojas-ruta/h1/impresion',r=>reply(r,{hoja:h,clientes:clients,totales:{clientes:80,comprobantes:80,bultos:800,kg:24000,total:12000000},fraccionado:[],fraccionado_completo:true,dias_faltantes:[],fraccionado_totales:{productos:0,paquetes:0,kg:0},sin_saldo:0}));
  await page.locator('.of-tabs button').filter({hasText:'Hojas de ruta'}).click();
  if(width<640)await page.locator('.hr-panel-tabs button').nth(1).click();
  await page.locator('.hr-hoja').waitFor();
  await page.screenshot({path:`${out}/hoja-poblada-${width}.png`,fullPage:true});
  results.cases.push({passed:true,case:'hoja-poblada',width,overflow:await page.evaluate(()=>({viewport:innerWidth,main:document.querySelector('.of-body').scrollWidth})),navAccessibleNames:await page.locator('.of-tabs').ariaSnapshot()});
  if(width===1440){
   await page.getByTitle('Imprimir la hoja y el listado de fraccionado',{exact:true}).click();
   await page.getByText('CLIENTE IMPRESO 080',{exact:true}).waitFor();
   if(await page.locator('.imp-grupo').count()!==80)throw new Error('No están los 80 clientes');
   if(!(await page.locator('.imp-tabla tfoot').innerText()).includes('12.000.000,00'))throw new Error('Total de impresión incorrecto');
   await page.pdf({path:`${out}/hoja-80-clientes.pdf`,format:'A4',printBackground:true});
   await page.screenshot({path:`${out}/hoja-impresa-desktop.png`,fullPage:true});
  }
  await ctx.close();
 }
 const {page,ctx}=await setup();
 await page.route('**/api/presupuestos/fraccionado?**',r=>reply(r,{completo:true,dias_faltantes:[],comprobantes_sin_items:[],comprobantes:120,fraccionado:Array.from({length:120},(_,i)=>({descripcion:'PRODUCTO FRACCIONADO '+String(i+1).padStart(3,'0'),cantidades:[5,10,15],paquetes:3,kg:30,bolsas_enteras:0,formato_bolsa:30})),totales:{productos:120,paquetes:360,kg:3600}}));
 await page.locator('.of-tabs button').filter({hasText:'Fraccionado'}).click();
 await page.getByText('PRODUCTO FRACCIONADO 120',{exact:true}).waitFor();
 await page.pdf({path:`${out}/fraccionado-120-productos.pdf`,format:'A4',printBackground:true});
 await ctx.close();
} finally {await fs.writeFile(`${out}/browser-extra-resultados.json`,JSON.stringify(results,null,2));await browser.close();}
console.log(JSON.stringify(results,null,2));

if(results.consoleErrors.length)process.exitCode=1;
