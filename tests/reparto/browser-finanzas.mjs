import fs from 'node:fs/promises';
import {browser,results,out,base,user,row,rows,presupuestos,item,reply,setup,assert,test} from './browser-fixtures.mjs';
const until=async(fn)=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,25));}throw new Error('No llegó la solicitud esperada');};
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
   // 🔑 Mati (22/09/2026): "en la parte de emisión de la NC estaría bueno que aparezcan los
   // códigos de los productos". Es lo único que distingue MAIZ QUEBRADO FINO de MEDIANO.
   const fila = page.locator('.cf-tabla tbody tr').first();
   assert((await fila.innerText()).includes('PRODUCTO A'),'La fila no muestra la descripción');
   assert(/C[oó]d\.\s*11\b/.test(await fila.innerText()),
     `La fila no muestra el código del artículo: "${await fila.innerText()}"`);
  } finally {await ctx.close();}
 });
 /**
  * 🔑 Mati (23/09/2026): "en la parte de facturas emitidas, que aparezca la fecha de la factura
  * también como dato". Es la de InfoManager, no la del pedido: acá valen distinto a propósito.
  */
 /** 🔴 Mati (24/09/2026): anular facturas desde la app, con reingreso de la mercadería. */
 await test('Anular una factura pide el motivo, lo manda, y no se ofrece si tiene notas', async()=>{
  const {page,ctx}=await setup();
  try {
   let enviado=null;
   await page.route('**/api/facturacion?**',r=>reply(r,{pendientes:[],facturados:[
     {...rows[0],im_factura_id:'501',im_factura_numero:50845,im_factura_tipo:'FA B',im_remito_id:'601',im_remito_numero:78031,notas:[]},
     {...rows[1],im_factura_id:'502',im_factura_numero:50846,im_factura_tipo:'FA B',im_remito_id:'602',im_remito_numero:78032,notas:[{tipo:'NC B',numero:30124,total:100,im_comprobante_id:'9',motivo:null}]},
   ],totales:{pendientes:0,facturados:2}}));
   await page.route('**/api/facturacion/anular/**',r=>{enviado={url:r.request().url(),body:r.request().postDataJSON()};return reply(r,{ok:true,factura:50845,remito:78031});});
   await page.locator('.of-tabs button').filter({hasText:'Facturación'}).click();
   await page.locator('.fc-facturados summary').click();
   const filas=page.locator('.fc-facturados tbody tr');
   assert(await filas.nth(1).locator('.fc-anular').isDisabled(),'Deja anular una factura con notas');
   let texto='';
   page.once('dialog',async d=>{texto=d.message();await d.accept('el cliente rechazó el pedido');});
   await filas.nth(0).locator('.fc-anular').click();
   await until(()=>!!enviado);
   assert(/vuelve al stock/i.test(texto),`El aviso no dice que vuelve la mercadería: "${texto.slice(0,120)}"`);
   assert(/anular\/101$/.test(enviado.url),'Anuló otro pedido');
   assert(enviado.body.motivo==='el cliente rechazó el pedido','No mandó el motivo');
  } finally {await ctx.close();}
 });

 /** 🔑 Mati (24/09/2026): "seleccionar todos los productos de una sola vez" en la NC. */
 await test('Devolver todo pone las cantidades en cero y se puede deshacer', async()=>{
  const {page,ctx}=await setup();
  try {
   await page.route('**/api/facturacion?**',r=>reply(r,{pendientes:[],facturados:[{...rows[0],im_factura_id:'501',im_factura_numero:501,im_factura_tipo:'FA B',notas:[]}],totales:{pendientes:0,facturados:1}}));
   await page.route('**/api/facturacion/corregir/501',r=>reply(r,{factura:{id:'501',numero:501,letra:'B',cliente_nombre:'CLIENTE ALFA',fecha:'2026-09-10'},version:0,operacion:null,bloqueo_productos:null,
     renglones:[{cod_articulo:11,descripcion:'PRODUCTO A',cantidad:10,precio:100,descuento_porc:0},{cod_articulo:22,descripcion:'PRODUCTO B',cantidad:4,precio:50,descuento_porc:0}]}));
   await page.locator('.of-tabs button').filter({hasText:'Facturación'}).click();
   await page.locator('.fc-facturados summary').click();
   await page.getByRole('button',{name:'Corregir',exact:true}).click();
   await page.locator('.cf-tabla').waitFor();
   const cantidades=async()=>Promise.all([0,1].map(i=>page.locator('.cf-tabla tbody tr').nth(i).locator('input').nth(0).inputValue()));
   await page.getByRole('button',{name:'Devolver todo',exact:true}).click();
   const cero=await cantidades();
   assert(cero.every(v=>Number(v)===0),`No quedaron en cero: ${cero}`);
   await page.getByRole('button',{name:'Restaurar cantidades',exact:true}).click();
   const vuelta=await cantidades();
   assert(vuelta[0]==='10'&&vuelta[1]==='4',`No restauró: ${vuelta}`);
  } finally {await ctx.close();}
 });

 await test('Las facturas emitidas muestran la fecha de la factura, no la del pedido', async()=>{
  const {page,ctx}=await setup();
  try {
   await page.route('**/api/facturacion?**',r=>reply(r,{pendientes:[],facturados:[
     {...rows[0],fecha:'2026-09-10',im_factura_id:'501',im_factura_numero:50842,im_factura_tipo:'FA B',im_remito_numero:78028,fecha_factura:'2026-09-14',notas:[]},
     {...rows[1],fecha:'2026-09-10',im_factura_id:'502',im_factura_numero:50843,im_factura_tipo:'FA B',im_remito_numero:78029,fecha_factura:null,notas:[]},
   ],totales:{pendientes:0,facturados:2}}));
   await page.locator('.of-tabs button').filter({hasText:'Facturación'}).click();
   await page.locator('.fc-facturados summary').click();
   const encabezado = await page.locator('.fc-facturados thead').innerText();
   // En mayúsculas: el CSS de la tabla las transforma y `innerText` devuelve lo que se ve.
   assert(/fecha fa/i.test(encabezado),`No está la columna: "${encabezado}"`);
   const filas = page.locator('.fc-facturados tbody tr');
   const primera = await filas.nth(0).innerText();
   assert(primera.includes('14/09'),`No muestra la fecha de la factura: "${primera}"`);
   assert(!primera.includes('10/09'),`Muestra la del pedido en vez de la de la factura: "${primera}"`);
   // Sin fecha de IM no se completa con la del pedido: se ve "—".
   const segunda = await filas.nth(1).innerText();
   assert(!segunda.includes('10/09') && segunda.includes('—'),`Inventó una fecha: "${segunda}"`);
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
