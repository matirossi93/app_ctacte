import fs from 'node:fs/promises';
import {browser,results,out,base,rows,row,presupuestos,item,reply,setup,assert,test} from './browser-fixtures.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await pause(25);}throw new Error('No llegó la solicitud esperada');}
const hoja={version:2,id:'h1',numero:3405,fecha:'2026-09-10',turno:'Mañana',camion:'Camión 5000',camion_id:'c1',capacidad_kg:5000,chofer:'Chofer auditoría',chofer_id:'ch1',estado:'abierta',facturada:true,pedidos:rows.map(x=>({...x,im_remito_numero:5000,im_factura_numero:4000,facturado_at:'2026-09-10'})),totales:{pedidos:2,bultos:20,kg:600},carga:{porcentaje:12,excedido:false,sobra_kg:4400}};
try{
 for(const etapa of ['Presupuestos','Facturación'])await test(etapa+': volver A tras iniciar B restaura datos y termina carga',async()=>{
  const {page,ctx}=await setup();let release=()=>{};
  try{
   if(etapa==='Facturación')await page.locator('.of-tabs').getByRole('button',{name:etapa,exact:true}).click();
   const endpoint=etapa==='Presupuestos'?'presupuestos':'facturacion';
   const selector=etapa==='Presupuestos'?'.pr-fila':'.fc-tabla tbody tr';
   await page.locator(selector).first().waitFor();
   const fechaA=await page.locator('.of-rango input').first().inputValue();
   let started=false;const gate=new Promise(r=>release=r);
   await page.route(`**/api/${endpoint}?**`,async r=>{
    const d=new URL(r.request().url()).searchParams.get('desde');
    if(d==='2026-09-08'){started=true;await gate;}
    const rs=[row('101',d===fechaA?'RANGO A RESTAURADO':'RANGO B TARDÍO')];
    await reply(r,endpoint==='presupuestos'?presupuestos(rs):{pendientes:rs,facturados:[],totales:{pendientes:1,importe_pendiente:150000}}).catch(()=>{});
   });
   await page.locator('.of-rango input').first().fill('2026-09-08');await until(()=>started);
   await page.locator('.of-rango input').first().fill(fechaA);
   await page.getByText('RANGO A RESTAURADO',{exact:true}).waitFor();
   release();await pause(100);assert(!await page.getByText('RANGO B TARDÍO',{exact:true}).isVisible(),'B tardío sustituyó A');
  }finally{release();await ctx.close();}
 });
 await test('Detalle pendiente reanuda al volver de una etapa oculta',async()=>{
  const {page,ctx}=await setup();let release=()=>{};
  try{
   let calls=0;const gate=new Promise(r=>release=r);
   await page.route('**/api/presupuestos/101',async r=>{calls++;if(calls===1)await gate;await reply(r,{comprobante:{im_comprobante_id:'101',numero:101,cliente_nombre:'CLIENTE ALFA',cod_cliente:101,fecha:'2026-09-10',huella:'v101',observaciones:''},items:[item(11,'DETALLE REANUDADO')]}).catch(()=>{});});
   await page.locator('.pr-abrir').first().click();await until(()=>calls===1);
   await page.locator('.of-tabs').getByRole('button',{name:'Facturación',exact:true}).click();
   await page.locator('.fc-tabla').waitFor();
   await page.locator('.of-tabs').getByRole('button',{name:'Presupuestos',exact:true}).click();
   await page.locator('.ed-tabla tr').filter({hasText:'DETALLE REANUDADO'}).waitFor();
   assert(calls===2,'No hubo una única reanudación del detalle abortado');release();
  }finally{release();await ctx.close();}
 });
 await test('Dos borradores conservan cliente, huella y cantidad fuera del filtro',async()=>{
  const {page,ctx}=await setup();
  try{
   await page.locator('.pr-abrir').first().click();await page.locator('.ed-cant').fill('7');
   await page.locator('.pr-abrir').nth(1).click();await page.locator('.ed-cant').fill('9');
   await page.locator('.pr-buscador input').fill('NINGUNO');
   await page.getByRole('button',{name:'Retomar PR 101',exact:true}).click();
   assert(await page.locator('.ed-cant').inputValue()==='7','ALFA perdió cantidad');
   assert((await page.locator('.pr-editor-identidad').innerText()).includes('CLIENTE ALFA'),'Identidad ALFA cruzada');
   await page.getByRole('button',{name:'Retomar PR 102',exact:true}).click();
   assert(await page.locator('.ed-cant').inputValue()==='9','BETA perdió cantidad');
   assert((await page.locator('.pr-editor-identidad').innerText()).includes('CLIENTE BETA'),'Identidad BETA cruzada');
  }finally{await ctx.close();}
 });
 await test('Buscar producto ignora A tardío y resultados posteriores a vaciar campo',async()=>{
  const {page,ctx}=await setup();let release=()=>{},releaseClear=()=>{};
  try{
   await page.locator('.pr-abrir').first().click();const input=page.locator('.ed-buscar input');await input.waitFor();
   let started=false,clearStarted=false;const gate=new Promise(r=>release=r),clearGate=new Promise(r=>releaseClear=r);
   await page.route('**/api/articulos/buscar?**',async r=>{const q=new URL(r.request().url()).searchParams.get('q');if(q==='ALFA'){started=true;await gate;}if(q==='VACIO'){clearStarted=true;await clearGate;}await reply(r,{articulos:[{cod_articulo:888,descripcion:'RESULTADO '+q,precio:100,stock:10}]}).catch(()=>{});});
   await input.fill('ALFA');await input.press('Enter');await until(()=>started);
   await input.fill('BETA');await input.press('Enter');await page.getByText('RESULTADO BETA',{exact:true}).waitFor();
   release();await pause(100);assert(!await page.getByText('RESULTADO ALFA',{exact:true}).isVisible(),'Se pintó búsqueda vieja');
   await input.fill('VACIO');await input.press('Enter');await until(()=>clearStarted);await input.fill('');releaseClear();await pause(100);
   assert(!await page.getByText('RESULTADO VACIO',{exact:true}).isVisible(),'Vaciar no invalida respuesta');
  }finally{release();releaseClear();await ctx.close();}
 });
 await test('Enlace a hoja abre sólo la etapa necesaria con el rango indicado',async()=>{
  const {page,ctx,seen}=await setup(390,{url:'/reparto?etapa=hojas&desde=2026-09-10&hasta=2026-09-10&hoja=h1',ready:'.hr-hoja',beforeGoto:p=>p.route('**/api/hojas-ruta?**',r=>reply(r,{hojas:[hoja]}))});
  try{
   assert(await page.locator('.of-rango input').first().inputValue()==='2026-09-10','Rango URL no aplicado');
   assert(await page.locator('.hr-hoja').isVisible(),'Hoja destino no visible en móvil');
   assert(!seen.some(s=>/^\/api\/(presupuestos|facturacion)(?:\?|\/|$)/.test(s)),'Enlace cargó etapas no visitadas');
   await page.screenshot({path:`out/enlace-hoja.png`.replace('out/',out+'/'),fullPage:true});
  }finally{await ctx.close();}
 });
 await test('Una factura sin importe verificado mantiene visibles ambas hojas y restringe sólo la afectada',async()=>{
  const mala={...hoja,id:'h2',numero:9992,pedidos:[{...hoja.pedidos[0],im_comprobante_id:'909',cliente_nombre:'CLIENTE POR VERIFICAR',total:null,importe_error:'Factura50422 requiere revisión'}]};
  const {page,ctx}=await setup(1440,{url:'/reparto?etapa=hojas&desde=2026-09-10&hasta=2026-09-10',ready:'.hr-hoja',beforeGoto:p=>p.route('**/api/hojas-ruta?**',r=>reply(r,{hojas:[hoja,mala]}))});
  try{
   assert(await page.locator('.hr-hoja').count()===2,'Ocultó todas las hojas');
   const afectada=page.locator('.hr-hoja').filter({hasText:'CLIENTE POR VERIFICAR'});
   await afectada.getByText('Importe por verificar: Factura50422 requiere revisión',{exact:true}).waitFor();
   assert(await afectada.getByRole('button',{name:'Cerrar hoja',exact:true}).isDisabled(),'Permite cerrar importe desconocido');
   assert(await afectada.getByTitle('Verificá los importes pendientes antes de imprimir').isDisabled(),'Permite imprimir importe desconocido');
   const sana=page.locator('.hr-hoja').filter({hasNotText:'CLIENTE POR VERIFICAR'});
   // 🔑 Las hojas arrancan PLEGADAS (22/09/2026) y los botones del cuerpo no se ven hasta
   // desplegarlas. La afectada NO se pliega —su aviso tiene que quedar a la vista—, así que
   // acá sólo hay que abrir la sana, que es lo que hace una persona para trabajarla.
   assert(await sana.locator('.hr-plegar').getAttribute('title')==='Desplegar','La hoja sana no arrancó plegada');
   await sana.locator('.hr-plegar').click();
   assert(await sana.getByRole('button',{name:'Cerrar hoja',exact:true}).isEnabled(),'Bloqueó una hoja sana');
  }finally{await ctx.close();}
 });
 await test('Vincular NC conserva contexto y resultado durante petición demorada',async()=>{
  const {page,ctx}=await setup(1440,{url:'/reparto?etapa=hojas&desde=2026-09-10&hasta=2026-09-10&hoja=h1',ready:'.hr-hoja',beforeGoto:async p=>{
   await p.route('**/api/hojas-ruta?**',r=>reply(r,{hojas:[hoja]}));
   await p.route('**/api/hojas-ruta/h1/ajustes',r=>reply(r,{hoja,ajustes:[],notas:[],despachado:300000,notas_credito:0,notas_debito:0,final:300000,pendientes_de_emitir:0,
    entregas:[{im_comprobante_id:'101',im_numero:101,cliente_nombre:'CLIENTE ALFA',cod_cliente:101,total:150000,im_factura_id:'58796590',im_factura_numero:50456}]}));
   await p.route('**/api/hojas-ruta/h1/ajustes/candidatas',r=>reply(r,{candidatas:[{im_ajuste_id:'901',numero:901,tipo:'NC B',signo:-1,fecha:'2026-09-10',cod_cliente:101,importe:100,observaciones:'NC SIMULADA',menciona_esta_hoja:true}]}));
  }});let release=()=>{};
  try{
   let calls=0,sent;const gate=new Promise(r=>release=r);
   await page.route('**/api/hojas-ruta/h1/ajustes/vincular',async r=>{calls++;sent=r.request().postDataJSON();await gate;await reply(r,{ok:true,advertencia:'VÍNCULO CONFIRMADO'}).catch(()=>{});});
   // Las hojas arrancan plegadas: se despliega la que se va a trabajar (22/09/2026).
   await page.locator('.hr-hoja .hr-plegar').first().click();
   await page.getByRole('button',{name:'Vincular NC/ND',exact:true}).click();
   await page.locator('.aj-modal').getByRole('button',{name:'Buscar',exact:true}).click();
   await page.locator('.aj-modal').getByRole('button',{name:'Vincular',exact:true}).click();await until(()=>calls===1);
   assert(await page.locator('.aj-cerrar').isDisabled(),'Puede cerrar vínculo en curso');
   assert(await page.locator('.of-tabs button').first().isDisabled(),'Puede navegar durante vínculo');
   await page.keyboard.press('Escape');assert(await page.locator('.aj-modal').isVisible(),'Escape desmonta vínculo');
   assert(sent.im_ajuste_id==='901'&&sent.im_comprobante_id==='101'&&sent.version_esperada===2,'Se perdió identidad/versión del vínculo');
   // La factura y el detalle vistos viajan como condición: el server corta si cambiaron.
   assert(sent.im_factura_id==='58796590'&&sent.esperado?.tipo==='NC B'&&sent.esperado?.numero===901,'Se perdió lo que se vio en pantalla');
   release();await page.getByText('VÍNCULO CONFIRMADO',{exact:true}).waitFor();assert(calls===1,'Duplicó vínculo');
  }finally{release();await ctx.close();}
 });
 for(const enCurso of [false,true])await test('Cambio de sesión en otra pestaña '+(enCurso?'espera el POST y bloquea nuevas acciones':'no envía el borrador del usuario anterior'),async()=>{
  const {page,ctx}=await setup();let release=()=>{};
  try{
   let sent,calls=0;const gate=new Promise(r=>release=r);
   await page.route('**/api/presupuestos/101/editar',async r=>{calls++;sent={body:r.request().postDataJSON(),auth:r.request().headers().authorization};await gate;await reply(r,{ok:true,modo:'cantidades',im_numero:101}).catch(()=>{});});
   await page.locator('.pr-abrir').first().click();await page.locator('.ed-cant').fill('7');
   if(enCurso){await page.locator('.pr-detalle').getByRole('button',{name:/Guardar/}).click();await until(()=>!!sent);}
   const otra=await ctx.newPage();await otra.goto(base+'/favicon.svg');
   await otra.evaluate(()=>{localStorage.setItem('auth_user',JSON.stringify({email:'otro@example.invalid',rol:'administrativo',nombre:'Otra sesión'}));localStorage.setItem('auth_token','audit-other-session');});
   await page.getByRole('dialog',{name:'Sesión cambiada',exact:true}).waitFor();
   assert(await page.locator('.of-tabs button').first().isDisabled(),'Sesión anterior permite navegar');
   if(enCurso){assert(await page.getByRole('button',{name:'Revalidar acceso',exact:true}).isDisabled(),'Recarga mientras el POST sigue pendiente');assert(sent.auth==='Bearer audit-local-only','POST salió con identidad equivocada');release();}
   await page.getByRole('button',{name:'Revalidar acceso',exact:true}).waitFor();
   for(let i=0;i<100&&await page.getByRole('button',{name:'Revalidar acceso',exact:true}).isDisabled();i++)await pause(25);
   assert(await page.getByRole('button',{name:'Revalidar acceso',exact:true}).isEnabled(),'No permite revalidar tras terminar');
   assert(calls===(enCurso?1:0),'Envió otro POST usando el borrador previo');
  }finally{release();await ctx.close();}
 });
 await test('Facturar mantiene lote y fecha durante emisión y bloquea doble envío',async()=>{
  const {page,ctx}=await setup();let release=()=>{};
  try{
   await page.route('**/api/facturacion/previa?**',r=>reply(r,{fecha_maxima_emision:'2026-09-30',max_adelanto_dias:7,punto_de_venta:777,no_se_puede:0,ya_facturados:0,pedidos:[{...rows[0],estado:'listo',letra:'B',renglones:1,sin_stock:[]}],a_emitir:{facturas:1,remitos:1,clientes:1,total:150000,letras:{A:0,B:1}}}));
   let sent,calls=0;const gate=new Promise(r=>release=r);
   await page.route('**/api/facturacion',async r=>{if(r.request().method()!=='POST')return r.fallback();calls++;sent=r.request().postDataJSON();await gate;await reply(r,{ok:true,facturados:1,hechos:[{cliente:'CLIENTE ALFA',factura:501,remito:601,tipo:'FA B'}],fallados:[],cortado:null,quedan_sin_facturar:0}).catch(()=>{});});
   await page.locator('.of-tabs').getByRole('button',{name:'Facturación',exact:true}).click();
   await page.locator('.fc-tabla tbody input[type=checkbox]').first().check();
   const desde=await page.locator('.of-rango input').first().inputValue();
   await page.getByRole('button',{name:'Facturar 1',exact:true}).click();await page.locator('.fac-modal input[type=date]').fill('2026-09-11');
   await page.locator('.fac-btn.emitir').click();await until(()=>!!sent);
   assert(await page.locator('.fac-cerrar').isDisabled(),'Cerrar habilitado en emisión');
   assert(await page.locator('.fac-modal input[type=date]').isDisabled(),'Fecha editable en emisión');
   await page.keyboard.press('Escape');assert(await page.locator('.fac-modal').isVisible(),'Escape desmontó emisión');
   await page.keyboard.press('Enter');assert(calls===1,'Enter duplicó POST');
   assert(sent.ids.length===1&&sent.ids[0]==='101'&&sent.desde===desde&&sent.fecha_emision==='2026-09-11','Se alteró lote/rango/fecha');
   release();await page.locator('.fac-modal').getByRole('button',{name:'Listo',exact:true}).waitFor();
  }finally{release();await ctx.close();}
 });

 /**
  * 🔑 24/09/2026 (RIVAS, BUSTOS, DECIMA): InfoManager pidió una pausa y el server cortó ANTES de
  * emitir. La pantalla decía a la vez "No se emitió nada" y "No se sabe qué llegó a emitirse", con
  * los asteriscos a la vista, y obligaba a cerrar y volver a elegir los pedidos.
  */
 const previaLista={fecha_maxima_emision:'2026-09-30',max_adelanto_dias:7,punto_de_venta:777,no_se_puede:0,ya_facturados:0,pedidos:[{...rows[0],estado:'listo',letra:'B',renglones:1,sin_stock:[]}],a_emitir:{facturas:1,remitos:1,clientes:1,total:150000,letras:{A:0,B:1}}};
 await test('Facturar: si no se emitió nada lo dice sin contradecirse y deja reintentar',async()=>{
  const {page,ctx}=await setup();
  try{
   await page.route('**/api/facturacion/previa?**',r=>reply(r,previaLista));
   let calls=0;
   await page.route('**/api/facturacion',r=>{if(r.request().method()!=='POST')return r.fallback();calls++;
    return calls===1
     ?reply(r,{error:'No pude revisar en InfoManager si ya estaban facturados: InfoManager pidió una pausa hasta las 11:36. No se consultó de nuevo. No se emitió nada: podés volver a intentar.',nada_emitido:true},500)
     :reply(r,{ok:true,facturados:1,hechos:[{cliente:'CLIENTE ALFA',factura:501,remito:601,tipo:'FA B'}],fallados:[],cortado:null,quedan_sin_facturar:0});});
   await page.locator('.of-tabs').getByRole('button',{name:'Facturación',exact:true}).click();
   await page.locator('.fc-tabla tbody input[type=checkbox]').first().check();
   await page.getByRole('button',{name:'Facturar 1',exact:true}).click();
   await page.locator('.fac-btn.emitir').click();
   const alerta=page.locator('.fac-alerta.error');await alerta.waitFor();
   const texto=await alerta.innerText();
   assert(/11:36/.test(texto)&&/No se emitió nada/.test(texto),`No muestra lo que pasó: "${texto}"`);
   assert(!/no se sabe/i.test(texto),`Se contradice: "${texto}"`);
   for(let i=0;i<100&&await page.locator('.fac-btn.emitir').isDisabled();i++)await pause(25);
   assert(await page.locator('.fac-btn.emitir').isEnabled(),'No deja reintentar algo que no se emitió');
   await page.locator('.fac-btn.emitir').click();
   await page.locator('.fac-modal').getByRole('button',{name:'Listo',exact:true}).waitFor();
   assert(calls===2,`Mandó ${calls} pedidos de facturación`);
  }finally{await ctx.close();}
 });
 await test('Facturar: si se corta la conexión avisa que no se sabe qué salió, sin asteriscos, y no deja reintentar',async()=>{
  const {page,ctx}=await setup();
  try{
   await page.route('**/api/facturacion/previa?**',r=>reply(r,previaLista));
   let calls=0;
   await page.route('**/api/facturacion',r=>{if(r.request().method()!=='POST')return r.fallback();calls++;return r.abort('connectionreset');});
   await page.locator('.of-tabs').getByRole('button',{name:'Facturación',exact:true}).click();
   await page.locator('.fc-tabla tbody input[type=checkbox]').first().check();
   await page.getByRole('button',{name:'Facturar 1',exact:true}).click();
   await page.locator('.fac-btn.emitir').click();
   const alerta=page.locator('.fac-alerta.error');await alerta.waitFor();
   const texto=await alerta.innerText();
   assert(/NO SE SABE QUÉ LLEGÓ A EMITIRSE/.test(texto),`No avisa que no se sabe qué salió: "${texto}"`);
   assert(!/\*\*/.test(texto),`Muestra los asteriscos: "${texto}"`);
   await pause(200);
   assert(await page.locator('.fac-btn.emitir').isDisabled(),'Deja reintentar sin saber qué salió');
   assert(calls===1,`Mandó ${calls} pedidos de facturación`);
  }finally{await ctx.close();}
 });

 /**
  * 🔑 Mati (23/09/2026), con OTTONELLI: la app decía "parece que ya está facturado en IM" y ahí se
  * terminaba — el pedido quedaba pendiente para siempre y sin botón Corregir para hacerle una NC.
  */
 await test('Un pedido ya facturado en IM se registra con un clic y deja de figurar pendiente',async()=>{
  const {page,ctx}=await setup();
  try{
   let vuelta=0,registro=null;
   const base={fecha_maxima_emision:'2026-09-30',max_adelanto_dias:7,punto_de_venta:777,a_emitir:{facturas:0,remitos:0,clientes:0,total:0,letras:{A:0,B:0}}};
   await page.route('**/api/facturacion/previa?**',r=>{
    vuelta++;
    const p=vuelta===1
     ?{...rows[0],estado:'no_se_puede',letra:'B',renglones:1,sin_stock:[],motivo:'CLIENTE ALFA (PR 101): parece que YA ESTÁ FACTURADO en InfoManager — hay una FA B 50319 del mismo cliente por el mismo importe.',
       ya_facturada:{im_factura_id:'58747098',numero:50319,tipo:'FA B',fecha:'2026-09-08'}}
     :{...rows[0],estado:'facturado',letra:'B',renglones:1,sin_stock:[],motivo:null,im_factura_numero:50319,im_remito_numero:77207,ya_facturada:null};
    return reply(r,{...base,no_se_puede:vuelta===1?1:0,ya_facturados:vuelta===1?0:1,pedidos:[p]});
   });
   await page.route('**/api/facturacion/factura-existente/**',r=>{registro={url:r.request().url(),body:r.request().postDataJSON()};return reply(r,{ok:true,factura:50319,remito:77207});});
   await page.locator('.of-tabs').getByRole('button',{name:'Facturación',exact:true}).click();
   await page.locator('.fc-tabla tbody input[type=checkbox]').first().check();
   await page.getByRole('button',{name:'Facturar 1',exact:true}).click();
   const boton=page.locator('.fac-registrar');
   await boton.waitFor();
   assert(/FA B 50319/.test(await boton.innerText()),`El botón no nombra la factura: "${await boton.innerText()}"`);
   await boton.click();
   await page.locator('.fac-hecho').waitFor();
   assert(registro&&/factura-existente\/101$/.test(registro.url),'No pidió registrar el pedido correcto');
   assert(registro.body.im_factura_id==='58747098','Mandó otra factura');
   assert((await page.locator('.fac-hecho').innerText()).includes('50319'),'No muestra la factura registrada');
   assert(await page.locator('.fac-registrar').count()===0,'Sigue ofreciendo registrar algo ya registrado');
  }finally{await ctx.close();}
 });

 for(const etapa of ['Presupuestos','Facturación','Hojas de ruta'])await test(etapa+': error de carga no se presenta como lista vacía',async()=>{
  const {page,ctx}=await setup();
  try{
   const endpoint=etapa==='Presupuestos'?'presupuestos':etapa==='Facturación'?'facturacion':'hojas-ruta';
   await page.route(`**/api/${endpoint}?**`,r=>reply(r,{error:'CONSULTA NO DISPONIBLE'},503));
   if(etapa==='Hojas de ruta')await page.route('**/api/hojas-ruta/pendientes?**',r=>reply(r,{error:'PEDIDOS NO DISPONIBLES'},503));
   if(etapa==='Presupuestos')await page.getByRole('button',{name:'Actualizar',exact:true}).click();
   else await page.locator('.of-tabs').getByRole('button',{name:etapa,exact:true}).click();
   await page.getByText('CONSULTA NO DISPONIBLE',{exact:true}).waitFor();
   assert(!await page.getByText(/No hay presupuestos en este filtro|No queda nada aprobado|Todavía no hay hojas|No quedan pedidos sin asignar/).isVisible(),'Confunde fallo con ausencia de pedidos');
  }finally{await ctx.close();}
 });
}finally{await fs.writeFile(`${out}/browser-contexto.json`,JSON.stringify(results,null,2));await browser.close();}
console.log(JSON.stringify(results,null,2));
if(results.cases.some(c=>!c.passed)||results.consoleErrors.length)process.exitCode=1;
