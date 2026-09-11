import fs from 'node:fs/promises';
import {browser,results,out,rows,item,reply,setup,assert,test} from './browser-fixtures.mjs';

async function until(condition) {
  for(let i=0;i<200;i++) { if(condition()) return; await new Promise(r=>setTimeout(r,25)); }
  throw new Error('No ocurrió la condición esperada');
}
async function invoice(page) {
  await page.route('**/api/facturacion?**',r=>reply(r,{pendientes:[],facturados:[{...rows[0],im_factura_id:'501',im_factura_numero:501,im_factura_tipo:'FA B',notas:[]}],totales:{pendientes:0,facturados:1}}));
  await page.route('**/api/facturacion/corregir/501',r=>reply(r,{factura:{id:'501',numero:501,letra:'B',cliente_nombre:'CLIENTE ALFA',fecha:'2026-09-10'},version:3,operacion:null,bloqueo_productos:null,renglones:[{cod_articulo:11,descripcion:'PRODUCTO A',cantidad:10,precio:100,descuento_porc:0,iva_por:21}]}));
  await page.locator('.of-tabs').getByRole('button',{name:'Facturación',exact:true}).click();
  await page.locator('.fc-facturados summary').click();
}
try {
  await test('ND permite cuatro listas; respuestas tardías y listas sin precio no conservan otro importe',async()=>{
    const {page,ctx}=await setup(900); let release=()=>{};
    try {
      await invoice(page);
      const gate=new Promise(r=>release=r);let leyendo14=false,sent,precio15=false;
      await page.route('**/api/articulos/buscar?**',r=>reply(r,{articulos:[{cod_articulo:22,descripcion:'PRODUCTO NUEVO',precio_venta:99999}]}));
      await page.route('**/api/pedidos/precio?**',async r=>{
        const lista=Number(new URL(r.request().url()).searchParams.get('cod_lista'));
        if(lista===14){leyendo14=true;await gate;}
        return reply(r,{ok:true,cod_lista:lista,precio:lista===15&&!precio15?null:{precio_vta:lista===12?1000:lista===13?700:lista===14?800:650}}).catch(()=>{});
      });
      await page.route('**/api/facturacion/corregir',r=>{
        const b=r.request().postDataJSON();const nuevo=b.renglones.find(x=>x.cod_articulo===22);
        if(b.emitir){sent=b;return reply(r,{ok:true,emitidos:[{tipo:'ND B',numero:1,total:nuevo.precio}],fallados:[]});}
        return reply(r,{ok:true,nc:[],nd:nuevo?[nuevo]:[],total_nc:0,total_nd:nuevo?.precio??0,diferencia:nuevo?.precio??0});
      });
      await page.getByRole('button',{name:'Corregir',exact:true}).click();
      await page.locator('.cf-agregar input').fill('NUEVO');
      await page.locator('.cf-candidatos button').click();
      const lista=page.getByRole('combobox',{name:'Lista de PRODUCTO NUEVO'});
      const precio=page.getByRole('textbox',{name:'Precio de PRODUCTO NUEVO',exact:true});
      await page.waitForFunction(()=>document.querySelector('[aria-label="Precio de PRODUCTO NUEVO"]')?.value==='1000');
      assert(await lista.locator('option').count()===4,'No ofrece las cuatro listas');
      await lista.selectOption('14');await until(()=>leyendo14);
      assert(await precio.inputValue()===''&&await page.locator('.cf-pie .primario').isDisabled(),'Muestra precio anterior o permite emitir durante cotización');
      await lista.selectOption('13');
      await page.waitForFunction(()=>document.querySelector('[aria-label="Precio de PRODUCTO NUEVO"]')?.value==='700');
      release();await page.waitForTimeout(100);
      assert(await precio.inputValue()==='700'&&await lista.inputValue()==='13','Respuesta vieja pisó la lista actual');
      await lista.selectOption('15');await page.locator('.cf-precio-pendiente').filter({hasText:'Sin precio en esta lista. Elegí otra.'}).waitFor();
      assert(await precio.inputValue()===''&&await page.locator('.cf-pie .primario').isDisabled(),'Lista sin precio conservó un importe de otra lista');
      precio15=true;await page.getByRole('button',{name:'Reintentar precio'}).click();
      await page.waitForFunction(()=>document.querySelector('[aria-label="Precio de PRODUCTO NUEVO"]')?.value==='650');
      await page.locator('.cf-resumen').waitFor();
      page.on('dialog',d=>d.accept());await page.locator('.cf-pie .primario').click();await until(()=>!!sent);
      const nuevo=sent.renglones.find(x=>x.cod_articulo===22);
      assert(nuevo.cod_lista_precios===15&&nuevo.precio===650&&nuevo.iva_por==null,'El envío perdió lista/precio o inventó IVA0');
    } finally {release();await ctx.close();}
  });
  await test('NC rechazada por numeración muestra una explicación y no permite retomar',async()=>{
    const {page,ctx}=await setup();
    try {
      await invoice(page);
      let envios=0;
      const operacion={id:'00000000-0000-4000-8000-000000000001',clase:'productos',estado:'listo',
        entrada:{renglones:[{cod_articulo:11,cantidad:8,precio:100,iva_por:21}]},motivo:'Devolución',
        emitidos:[],puede_retomar:false,puede_cancelar:true,requiere_revision_numeracion:true,
        error:"HTTP 400: Ya existe una factura con: tag = 'S', cod_empresa = 1, id_destino = 1, punto_de_venta = 777, tipo_factura = 'B' y numero = 30079.",
        instruccion:'InfoManager rechazó la nota por un conflicto de numeración en el punto 777. Verificá la nota en InfoManager y conciliá su comprobante con esta operación.'};
      await page.route('**/api/facturacion/corregir/501',r=>reply(r,{factura:{id:'501',numero:501,letra:'B',cliente_nombre:'CLIENTE ALFA',fecha:'2026-09-10'},version:3,operacion,renglones:[{cod_articulo:11,descripcion:'PRODUCTO A',cantidad:10,precio:100,iva_por:21}]}));
      await page.route('**/api/facturacion/corregir',r=>{if(r.request().postDataJSON()?.emitir)envios++;return reply(r,{ok:false});});
      await page.getByRole('button',{name:'Corregir',exact:true}).click();
      await page.locator('.cf-error').filter({hasText:operacion.instruccion}).waitFor();
      assert(await page.locator('.cf-error').count()===1,'Duplica carteles para el mismo rechazo');
      assert(await page.getByRole('button',{name:/Retomar/}).count()===0,'Ofrece repetir una colisión conocida');
      assert(await page.getByRole('button',{name:'Cancelar el intento rechazado'}).isEnabled(),'Impide cancelar un rechazo sin emisión');
      const detalle=page.locator('.cf-error details');
      assert(!await detalle.evaluate(e=>e.open),'Expone el error técnico como cartel principal');
      await detalle.locator('summary').click();
      assert((await detalle.innerText()).includes('30079'),'Perdió evidencia técnica del proveedor');
      assert(envios===0,'La apertura intentó volver a emitir');
    } finally {await ctx.close();}
  });
  await test('Guardar editor bloquea campos y navegación; una sola petición conserva el contexto',async()=>{
    const {page,ctx}=await setup();let release=()=>{};
    try {
      let sent, calls=0;
      const gate=new Promise(r=>release=r);
      await page.route('**/api/presupuestos/101/editar',async r=>{calls++;sent=r.request().postDataJSON();await gate;await reply(r,{ok:true,modo:'cantidades',im_comprobante_id:'101',im_numero:101}).catch(()=>{});});
      page.on('dialog',d=>d.accept());
      await page.locator('.pr-abrir').first().click();
      await page.locator('.pr-detalle .ed-cant').fill('7');
      await page.locator('.pr-detalle').getByRole('button',{name:/Guardar/}).click();
      await until(()=>!!sent);
      assert(await page.locator('.pr-detalle .ed-cant').isDisabled(),'Permite cambiar el body visual durante PUT');
      assert(await page.locator('.of-tabs').getByRole('button',{name:'Facturación',exact:true}).isDisabled(),'Permite cambiar de etapa durante PUT');
      assert(await page.locator('.of-rango input').first().isDisabled(),'Permite cambiar rango durante PUT');
      await page.keyboard.press('Enter');
      assert(calls===1&&sent.items[0].cantidad===7&&sent.huella==='v101','Se duplicó la escritura o cambió su versión/contenido');
      release();await page.waitForTimeout(150);
    } finally {release();await ctx.close();}
  });
  await test('Un conflicto de versión conserva el borrador y no vuelve a guardar automáticamente',async()=>{
    const {page,ctx}=await setup();
    try {
      let calls=0;
      await page.route('**/api/presupuestos/101/editar',r=>{calls++;return reply(r,{error:'La factura cambió. Conservá el borrador y revisá la versión.'},409);});
      page.on('dialog',d=>d.accept());
      await page.locator('.pr-abrir').first().click();
      await page.locator('.pr-detalle .ed-cant').fill('7');
      await page.locator('.pr-detalle').getByRole('button',{name:/Guardar/}).click();
      await page.locator('.ed-aviso.error').filter({hasText:'La factura cambió. Conservá el borrador y revisá la versión.'}).waitFor();
      assert(await page.locator('.pr-detalle .ed-cant').inputValue()==='7','409 perdió cambios del usuario');
      await page.waitForTimeout(500);assert(calls===1,'409 disparó reintento automático');
    } finally {await ctx.close();}
  });
  await test('Borrador de corrección previo a emitir y foco se conservan al cerrar y reabrir',async()=>{
    const {page,ctx}=await setup();
    try {
      await invoice(page);
      await page.route('**/api/facturacion/corregir',r=>reply(r,{ok:true,version:3,nc:[{cod_articulo:11,cantidad:1,precio:100}],nd:[],total_nc:100,total_nd:0,diferencia:-100}));
      const trigger=page.getByRole('button',{name:'Corregir',exact:true});
      await trigger.click();
      await page.locator('.cf-tabla tbody tr').first().locator('input').first().fill('9');
      for(let i=0;i<18;i++) {
        await page.keyboard.press('Tab');
        const foco=await page.evaluate(()=>({enDialogo:!!document.activeElement?.closest('dialog'),hasFocus:document.hasFocus(),active:document.activeElement?.outerHTML.slice(0,400),modal:!!document.querySelector('dialog:modal')}));assert(foco.enDialogo || (!foco.hasFocus && foco.modal),'Tab escapa al fondo del modal: '+JSON.stringify(foco));
      }
      await page.locator('.cf-header button').focus();
      await page.evaluate(()=>document.querySelector('.of-tabs button').focus());
      assert(await page.evaluate(()=>!!document.activeElement?.closest('dialog')), 'El fondo inerte recibió foco programático');
      await page.keyboard.press('Escape');
      assert(!await page.locator('.cf-modal').isVisible(),'Escape no cerró el diálogo libre');
      assert(await trigger.evaluate(el=>el===document.activeElement),'No devolvió foco al botón que abrió');
      await trigger.click();
      assert(await page.locator('.cf-tabla tbody tr').first().locator('input').first().inputValue()==='9','Se perdió el borrador anterior al POST');
    } finally {await ctx.close();}
  });
  await test('Mover fecha impide Escape, cierre y edición hasta confirmar respuesta',async()=>{
    const {page,ctx}=await setup();let release=()=>{};
    try {
      await invoice(page);let sent,calls=0;
      const gate=new Promise(r=>release=r);
      await page.route('**/api/facturacion/501/fecha',async r=>{calls++;sent=r.request().postDataJSON();await gate;await reply(r,{ok:true,fecha:sent.fecha,remito:{numero:900},avisos:[]}).catch(()=>{});});
      await page.getByRole('button',{name:'Fecha',exact:true}).click();
      await page.locator('.mf-campo input').fill('2026-09-11');
      await page.getByRole('button',{name:'Cambiar la fecha',exact:true}).click();
      await until(()=>!!sent);
      assert(await page.locator('.mf-campo input').isDisabled(),'Fecha editable durante envío');
      assert(await page.locator('.mf-header button').isDisabled(),'Cierre habilitado durante envío');
      await page.keyboard.press('Escape');assert(await page.locator('.mf-modal').isVisible(),'Escape perdió resultado pendiente');
      for(let i=0;i<5;i++)await page.keyboard.press('Tab');
      const foco=await page.evaluate(()=>({enDialogo:!!document.activeElement?.closest('dialog'),hasFocus:document.hasFocus(),active:document.activeElement?.outerHTML.slice(0,400),modal:!!document.querySelector('dialog:modal')}));assert(foco.enDialogo || (!foco.hasFocus && foco.modal),'Foco llegó al fondo durante envío: '+JSON.stringify(foco));
      assert(calls===1&&sent.fecha==='2026-09-11','Más de un PUT o body cambiado');
      release();await page.getByText('La factura quedó fechada el',{exact:false}).waitFor();
    } finally {release();await ctx.close();}
  });
} finally {await fs.writeFile(`${out}/browser-operaciones.json`,JSON.stringify(results,null,2));await browser.close();}
console.log(JSON.stringify(results,null,2));
if(results.cases.some(c=>!c.passed)||results.consoleErrors.length)process.exitCode=1;
