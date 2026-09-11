import fs from 'node:fs/promises';
import {browser,results,out,user,reply,setup,assert,test} from './browser-fixtures.mjs';

/**
 * 🔴 CUANDO EL ENVÍO ES RECHAZADO, EL VENDEDOR TIENE QUE PODER SALIR SIN PERDER EL PEDIDO.
 *
 * Mati (11/09/2026): al aprobar FORRAJERÍA SAN CAYETANO aparece *"Este presupuesto tiene una
 * operación en curso o por verificar"*. Es un 409 que NO se arregla reintentando —hay que salir
 * y avisar a la oficina—, y el modal no tenía salida a la vista: el click afuera no cierra
 * cuando hay carrito (a propósito, para no perder el pedido) y la ✕ queda lejos del error.
 *
 * Se prueba en 390 px porque los vendedores cargan desde el celular, y ahí es donde tres
 * elementos en la fila del pie se pelean por el ancho.
 */

const LOCK = 'Este presupuesto tiene una operación en curso o por verificar. No se modificó nada.';
const vendedor = {...user, rol:'vendedor', cod_vendedor:12};
const cart = [163,281].map((cod,n)=>({uid:'fila'+n,cod_articulo:cod,
  descripcion:cod===163?'FLECKY X 15 KG':'FULL CAT X 10 KG',
  cantidad:10,precio:1000,cod_lista:12,descuento:0}));

/** Vendedor editando un pedido ya cargado, con el borrador puesto. `puts` cuenta los intentos. */
async function editorConRechazo(width) {
  const puts = [];
  const {page,ctx} = await setup(width,{url:'/',ready:'.vs-fab-ped',beforeGoto:async(page,ctx)=>{
    await ctx.addInitScript(({user,cart})=>{
      localStorage.setItem('auth_user',JSON.stringify(user));
      localStorage.setItem('pedido_borrador:'+user.email,JSON.stringify({v:1,email:user.email,
        ts:Date.now(),cliente:{cod:'302',name:'FORRAJERIA SAN CAYETANO'},listaCliente:12,cart,
        obs:'',editando:'58810403',idempotencyKey:'prueba-local-unica'}));
    },{user,cart});
    await page.route('**/api/**',r=>{
      const u=new URL(r.request().url());
      if(r.request().method()==='PUT' && /^\/api\/pedidos\/\d+$/.test(u.pathname)) {
        puts.push(u.pathname);
        return reply(r,{error:LOCK},409);
      }
      if(u.pathname==='/api/me')return reply(r,{ok:true,user:vendedor});
      if(u.pathname==='/api/pedidos/validar')return reply(r,{ok:true,bultos:2,promo_general:false,avisos:[],lineas:[]});
      if(u.pathname==='/api/data')return reply(r,{rows:[]});
      if(u.pathname==='/api/clientes/lookup')return reply(r,{clientes:[]});
      return reply(r,{ok:true,rows:[],clientes:[],goals:[],items:[]});
    });
  }});
  await page.locator('.vs-fab-ped').click();
  await page.locator('.ped-confirm').waitFor();
  return {page,ctx,puts};
}

/**
 * ¿Este elemento se sale del modal?
 *
 * 🪤 Medir `scrollWidth > clientWidth` sobre el botón NO alcanza: en el bug real el botón no
 * estaba recortado sino DESPLAZADO —empezaba en x=412 sobre un modal de 390— y esa medición
 * daba que estaba bien. Se compara el rectángulo contra el del modal, que es lo que ve el
 * vendedor.
 */
const seSale = (page, sel) => page.evaluate((s) => {
  const m = document.querySelector('.ped-modal').getBoundingClientRect();
  const e = document.querySelector(s).getBoundingClientRect();
  return e.left < m.left - 1 || e.right > m.right + 1;
}, sel);
/** Y el pie tampoco puede tener scroll horizontal: es la otra cara del mismo desborde. */
const pieDesborda = (page) => page.evaluate(() => {
  const f = document.querySelector('.ped-footer');
  return f.scrollWidth > f.clientWidth + 1;
});

try {
  await test('El 409 deja una salida visible y el botón de enviar no se recorta (390 px)', async()=>{
    const {page,ctx,puts} = await editorConRechazo(390);
    try {
      const enviar = page.locator('.ped-confirm');
      assert(await enviar.innerText() === 'Guardar cambios', 'No está en modo edición');
      assert(!await seSale(page,'.ped-confirm'), 'El botón de enviar ya se salía ANTES del rechazo');
      assert(!await pieDesborda(page), 'El pie ya desbordaba ANTES del rechazo');

      await enviar.click();
      await page.locator('.ped-bloqueo').filter({hasText:'operación en curso'}).waitFor();
      assert(puts.length === 1, `Mandó ${puts.length} PUT en vez de uno`);

      const salida = page.getByRole('button',{name:'Cerrar sin perder los cambios'});
      await salida.waitFor();
      assert(await salida.isEnabled(), 'La salida aparece pero deshabilitada');
      /**
       * 🔴 EL BLOQUEANTE QUE ENCONTRÓ ASTRA. Con tres elementos en una fila sin `wrap`, la
       * salida empujaba "Guardar cambios" fuera del modal: medido 535 de scrollWidth contra
       * 390 visibles, con el botón principal arrancando en x=412. Invisible en celular.
       */
      assert(!await seSale(page,'.ped-confirm'), 'La salida empuja "Guardar cambios" fuera del modal');
      assert(!await seSale(page,'.ped-salida'), 'La propia salida queda fuera del modal');
      assert(!await pieDesborda(page), 'El pie desborda a lo ancho');
      await page.screenshot({path:`${out}/pedido-rechazado-390.png`,fullPage:true});

      await salida.click();
      await page.locator('.ped-modal').waitFor({state:'detached'});
      assert(puts.length === 1, 'Cerrar mandó otra escritura a InfoManager');

      // Reabrir: el pedido tiene que seguir entero, sin tocar nada del otro lado.
      await page.locator('.vs-fab-ped').click();
      await page.locator('.ped-confirm').waitFor();
      assert(await page.locator('.ped-cart-item').count() === 2, 'Se perdieron renglones al reabrir');
      assert(await page.locator('.ped-confirm').innerText() === 'Guardar cambios', 'Se perdió que estaba editando');
      assert(puts.length === 1, 'Reabrir disparó otra escritura');
    } finally { await ctx.close(); }
  });

  await test('Escape cierra y conserva el pedido; no cierra mientras está enviando', async()=>{
    const {page,ctx,puts} = await editorConRechazo(560);
    try {
      await page.keyboard.press('Escape');
      await page.locator('.ped-modal').waitFor({state:'detached'});
      await page.locator('.vs-fab-ped').click();
      await page.locator('.ped-confirm').waitFor();
      assert(await page.locator('.ped-cart-item').count() === 2, 'Escape perdió el pedido');
      assert(puts.length === 0, 'Escape mandó una escritura');
    } finally { await ctx.close(); }
  });

  await test('El botón de enviar entra completo también en 560 px', async()=>{
    const {page,ctx} = await editorConRechazo(560);
    try {
      await page.locator('.ped-confirm').click();
      await page.getByRole('button',{name:'Cerrar sin perder los cambios'}).waitFor();
      assert(!await seSale(page,'.ped-confirm'), 'Se sale "Guardar cambios" en 560');
      assert(!await seSale(page,'.ped-salida'), 'Se sale la salida en 560');
      assert(!await pieDesborda(page), 'El pie desborda en 560');
      await page.screenshot({path:`${out}/pedido-rechazado-560.png`,fullPage:true});
    } finally { await ctx.close(); }
  });
} finally {
  await browser.close();
  await fs.writeFile(`${out}/resultados-pedido-rechazado.json`,JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
}
if(results.cases.some(c=>!c.passed)||results.consoleErrors.length)process.exitCode=1;
