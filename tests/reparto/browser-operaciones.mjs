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
