import fs from 'node:fs/promises';
import {browser,results,out,base,user,row,rows,presupuestos,item,reply,setup,assert,test} from './browser-fixtures.mjs';
try {
 await test('Facturas emitidas sin stock no vuelven a Sin revisar y permiten abrir la corrección', async()=>{
  const emitida={...row('103','CLIENTE YA FACTURADO'),controles_completos:false,revision:null,
    factura:{im_factura_id:'503',numero:50424,tipo:'FA B',origen:'nuestra'}};
  const {page,ctx}=await setup(1440,{beforeGoto:async page=>{
    await page.route('**/api/presupuestos?**',r=>reply(r,presupuestos([rows[0],emitida])));
  }});
  try {
   assert(!(await page.getByText('CLIENTE YA FACTURADO',{exact:true}).count()),'Emitida reapareció sin revisar');
   await page.locator('.pr-filtros button').filter({hasText:'Todos'}).click();
   await page.getByText('CLIENTE YA FACTURADO',{exact:true}).waitFor();
   await page.route('**/api/facturacion?**',r=>reply(r,{pendientes:[],facturados:[{...emitida,im_factura_id:'503',im_factura_numero:50424,
     im_remito_numero:77404,facturado_at:'2026-09-09',notas:[]}],totales:{pendientes:0,facturados:1}}));
   await page.route('**/api/facturacion/corregir/503',r=>reply(r,{factura:{id:'503',numero:50424,letra:'B',cliente_nombre:emitida.cliente_nombre,fecha:'2026-09-10'},
     version:0,operacion:null,renglones:[{cod_articulo:11,descripcion:'PRODUCTO A',cantidad:10,precio:100,descuento_porc:0}]}));
   await page.locator('.of-tabs button').filter({hasText:'Facturación'}).click();
   await page.locator('.fc-facturados summary').click();
   await page.getByRole('button',{name:'Corregir',exact:true}).click();
   await page.locator('.cf-tabla').waitFor();
   assert(await page.locator('.cf-modal').getByText(/50424/).count()>0,'No abre la factura correcta');
  } finally {await ctx.close();}
 });
 await test('Corrección detecta cambio de productos con el mismo importe total', async()=>{
  const {page,ctx}=await setup();
  try {
   await page.route('**/api/facturacion?**',r=>reply(r,{pendientes:[],facturados:[{...rows[0],im_factura_id:'501',im_factura_numero:501,im_factura_tipo:'FA B',notas:[]}],totales:{pendientes:0,facturados:1}}));
   const base={factura:{id:'501',numero:501,letra:'B',cliente_nombre:'CLIENTE ALFA',fecha:'2026-09-10'},version:0,operacion:null,bloqueo_productos:null,renglones:[{cod_articulo:11,descripcion:'PRODUCTO A',cantidad:10,precio:100,descuento_porc:0},{cod_articulo:22,descripcion:'PRODUCTO B',cantidad:10,precio:100,descuento_porc:0}]};
   await page.route('**/api/facturacion/corregir/501',r=>reply(r,base));
   let previews=0;
   await page.route('**/api/facturacion/corregir',r=>{previews++;return reply(r,{ok:true,version:0,nc:[{cod_articulo:11,cantidad:1,precio:100}],nd:[{cod_articulo:22,cantidad:1,precio:100}],total_nc:100,total_nd:100,diferencia:0});});
   await page.locator('.of-tabs button').filter({hasText:'Facturación'}).click();
   await page.locator('.fc-facturados summary').click();
   await page.getByRole('button',{name:'Corregir',exact:true}).click();
   await page.locator('.cf-tabla').waitFor();
   await page.locator('.cf-tabla tbody tr').nth(0).locator('input').nth(0).fill('9');
   await page.locator('.cf-tabla tbody tr').nth(1).locator('input').nth(0).fill('11');
   await page.waitForTimeout(800);
   assert(previews>0,'No pidió previa con cantidades distintas de igual total');
   assert(await page.locator('.cf-resumen').isVisible(),'No muestra NC/ND compensadas');
   assert(await page.locator('.cf-pie .primario').isEnabled(),'No permite corrección que conserva importe');
   await page.screenshot({path:`${out}/correccion-mismo-total.png`,fullPage:true});
  } finally {await ctx.close();}
 });
 await test('Emisión financiera conserva identificador y bloquea cierre mientras procesa', async()=>{
  const {page,ctx}=await setup();
  try {
   await page.route('**/api/facturacion?**',r=>reply(r,{pendientes:[],facturados:[{...rows[0],im_factura_id:'501',im_factura_numero:501,im_factura_tipo:'FA B',notas:[]}],totales:{pendientes:0,facturados:1}}));
   await page.route('**/api/facturacion/corregir/501',r=>reply(r,{factura:{id:'501',numero:501,letra:'B',cliente_nombre:'CLIENTE ALFA',fecha:'2026-09-10'},version:3,operacion:null,renglones:[{cod_articulo:11,descripcion:'PRODUCTO A',cantidad:10,precio:100,descuento_porc:0}]}));
   await page.locator('.of-tabs button').filter({hasText:'Facturación'}).click();
   await page.locator('.fc-facturados summary').click();
   await page.getByRole('button',{name:'Corregir',exact:true}).click();
   await page.locator('.cf-tabla').waitFor();
   await page.getByRole('button',{name:'Ajuste financiero',exact:true}).click();
   await page.getByPlaceholder('0,00',{exact:true}).fill('100');
   await page.getByPlaceholder('Diferencia por cambio de mercadería, interés factura 18/8…',{exact:true}).fill('Auditoría aislada');
   let release,sent;
   const gate=new Promise(r=>release=r);
   await page.route('**/api/facturacion/nota-financiera',async r=>{
     if(!r.request().postDataJSON().emitir)return reply(r,{ok:true,version:3,total_nc:100,total_nd:0,diferencia:-100});
     sent=r.request().postDataJSON();await gate;
     return reply(r,{ok:true,operacion:{id:sent.operacion_id,estado:'completo',clase:'financiera'},emitidos:[{id:'901',tipo:'NC B',numero:1,total:100}],fallados:[]});
   });
   page.on('dialog',d=>d.accept());
   await page.locator('.cf-pie .primario').click();
   await page.getByText('Emitiendo…',{exact:true}).waitFor();
   assert(!!sent?.operacion_id && sent.version===3,'No envía operación estable y versión');
   assert(await page.locator('.cf-header button').isDisabled(),'Se puede cerrar una emisión en curso');
   await page.keyboard.press('Escape');
   assert(await page.locator('.cf-modal').isVisible(),'Escape cierra emisión en curso');
   release(); await page.waitForTimeout(200);
  } finally {await ctx.close();}
 });
} finally {
 await fs.writeFile(`${out}/browser-finanzas.json`,JSON.stringify(results,null,2));
 await browser.close();
}
console.log(JSON.stringify(results,null,2));
if(results.cases.some(c=>!c.passed)||results.consoleErrors.length)process.exitCode=1;
