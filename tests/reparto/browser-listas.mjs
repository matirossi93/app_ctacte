import fs from 'node:fs/promises';
import {browser,results,out,base,user,item,reply,setup,assert,test} from './browser-fixtures.mjs';
import { evaluarPedido, clasificarArticulo } from '../../dist-server/server-lib/listas.js';
const reglas = [
  { cod_lista:12, condicion:'libre' }, { cod_lista:13, condicion:'promo_general', umbral:10 },
  { cod_lista:14, condicion:'min', umbral:20 }, { cod_lista:15, condicion:'min', umbral:30 },
].map(r=>({nombre:'FLECKY + FULLCAT',match_tipo:'subrubro',match_valor:'Flecky',unidad:'unidad',ambito:'linea',...r}));
const cat = new Map([163,281].map(c=>[c,clasificarArticulo({cod_articulo:c,descripcion:c===163?'FLECKY X 15 KG':'FULL CAT X 10 KG',subrubro:'Flecky',unidad_de_medida:'Bolsa'})]));
const evaluar = rs=>({ok:true,...evaluarPedido(rs.map(i=>({...i,descuento:i.descuento_porc})),cat,reglas)});
try {
  await test('Oficina cambia lista y precio juntos e ignora una cotización anterior',async()=>{
    const {page,ctx}=await setup();
    try {
      await page.locator('.pr-abrir').first().click();
      const lista=page.getByLabel('Lista de PRODUCTO DE PRUEBA');
      let release; const gate=new Promise(r=>release=r);
      await page.route('**/api/pedidos/precio?**',async r=>{
        const n=Number(new URL(r.request().url()).searchParams.get('cod_lista'));
        if(n===15)await gate;
        await reply(r,{ok:true,cod_lista:n,precio:{precio_vta:n===15?700:800}}).catch(()=>{});
      });
      await lista.selectOption('15');
      await page.getByText('Pendiente de precio',{exact:true}).waitFor();
      assert(!await page.getByRole('button',{name:/Guardar \(/}).isEnabled(),'Permite guardar antes de cotizar');
      await lista.selectOption('14');
      await page.getByText('Pendiente de precio',{exact:true}).waitFor({state:'hidden'});
      release(); await page.waitForTimeout(100);
      assert((await page.locator('.ed-total').innerText()).includes('1.600'),'No conserva cotización L3');
      let payload;
      await page.route('**/api/presupuestos/101/editar',r=>{payload=r.request().postDataJSON();return reply(r,{ok:true,modo:'recreado',im_numero:999});});
      page.on('dialog',d=>d.accept());
      await page.getByRole('button',{name:/Guardar \(/}).click();
      await page.waitForTimeout(100);
      assert(payload?.items?.[0]?.precio===800 && payload.items[0].cod_lista_precios===14,'Envió precio o lista anteriores');
    } finally {await ctx.close();}
  });
  await test('Oficina agrega un artículo con catálogo precio cero y consulta su lista',async()=>{
    const {page,ctx}=await setup();
    try {
      await page.route('**/api/articulos/buscar?**',r=>reply(r,{articulos:[{cod_articulo:3,descripcion:'PRODUCTO NUEVO',precio_venta:0}]}));
      await page.route('**/api/pedidos/precio?**',r=>reply(r,{ok:true,cod_lista:12,precio:{precio_vta:900}}));
      await page.locator('.pr-abrir').first().click();
      await page.locator('.ed-buscar input').fill('NUEVO');
      await page.locator('.ed-buscar').getByRole('button',{name:'Buscar',exact:true}).click();
      await page.locator('.ed-res').click();
      await page.getByText('Pendiente de precio',{exact:true}).waitFor({state:'hidden'});
      await page.waitForTimeout(100);
      assert((await page.locator('.ed-total').innerText()).includes('2.900'),'Artículo nuevo conserva precio cero');
      await page.route('**/api/pedidos/precio?**',r=>reply(r,{ok:true,cod_lista:15,precio:null}));
      await page.getByLabel('Lista de PRODUCTO NUEVO').selectOption('15');
      await page.locator('.ed-precio-pendiente').filter({hasText:'Sin precio en esta lista.'}).waitFor();
      assert(!await page.getByRole('button',{name:/Guardar \(/}).isEnabled(),'Permite guardar producto sin precio');
    } finally {await ctx.close();}
  });
  for(const width of [390,1440]) await test('Surtido y control vigente en oficina '+width,async()=>{
    const {page,ctx}=await setup(width);
    try {
      await page.route('**/api/presupuestos/101',r=>reply(r,{items:[{...item(163,'FLECKY X 15 KG'),cantidad:10,cod_lista_precios:14},{...item(281,'FULL CAT X 10 KG'),cantidad:10,cod_lista_precios:14}],comprobante:{im_comprobante_id:'101',numero:101,cod_cliente:101,cliente_nombre:'CLIENTE ALFA',fecha:'2026-09-10',huella:'v101'}}));
      let liberar; const gate=new Promise(r=>liberar=r);
      await page.route('**/api/pedidos/validar',async r=>{const rows=r.request().postDataJSON().items;if(rows[0].cantidad===5)await gate;await reply(r,evaluar(rows)).catch(()=>{});});
      await page.locator('.pr-abrir').first().click();
      await page.locator('.listas-calculo summary').waitFor();
      await page.locator('.listas-calculo summary').click();
      await page.getByText('FLECKY + FULLCAT: 20 unidades',{exact:true}).waitFor();
      assert(await page.locator('.ed-aviso.error').count()===0,'Marca el surtido válido');
      await page.getByLabel('Cantidad de FLECKY X 15 KG').fill('5');
      await page.waitForTimeout(450);
      await page.getByLabel('Cantidad de FLECKY X 15 KG').fill('10');
      await page.waitForTimeout(500); liberar(); await page.waitForTimeout(120);
      assert(await page.locator('.ed-aviso.error').count()===0,'Respuesta antigua vuelve a mostrar margen');
      await page.getByLabel('Cantidad de FLECKY X 15 KG').fill('9');
      await page.locator('.ed-aviso.error').waitFor();
      assert((await page.locator('.ed-aviso.error').innerText()).includes('hasta L2'),'No recalcula el umbral de 20 al quitar una bolsa');
      await page.screenshot({path:`${out}/listas-oficina-${width}.png`,fullPage:true});
    } finally {await ctx.close();}
  });
  await test('Vendedor agrupa sugerencias y no conserva avisos al cambiar cantidades',async()=>{
    const vendedor={...user,rol:'vendedor',cod_vendedor:12};
    const cart=[163,281].map((cod,n)=>({uid:'fila'+n,cod_articulo:cod,descripcion:cod===163?'FLECKY X 15 KG':'FULL CAT X 10 KG',cantidad:10,precio:1000,cod_lista:12,descuento:0}));
    const {page,ctx}=await setup(390,{url:'/',ready:'.vs-fab-ped',beforeGoto:async(page,ctx)=>{
      await ctx.addInitScript(({user,cart})=>{localStorage.setItem('auth_user',JSON.stringify(user));localStorage.setItem('pedido_borrador:'+user.email,JSON.stringify({v:1,email:user.email,ts:Date.now(),cliente:{cod:'101',name:'CLIENTE FICTICIO'},listaCliente:12,cart,obs:'',editando:null,idempotencyKey:'prueba-local-unica'}));},{user:vendedor,cart});
      await page.route('**/api/**',r=>{
        const u=new URL(r.request().url());
        if(u.pathname==='/api/me')return reply(r,{ok:true,user:vendedor});
        if(u.pathname==='/api/pedidos/validar')return reply(r,evaluar(r.request().postDataJSON().items));
        if(u.pathname==='/api/data')return reply(r,{rows:[]});
        if(u.pathname==='/api/clientes/lookup')return reply(r,{clientes:[]});
        return reply(r,{ok:true,rows:[],clientes:[],goals:[],items:[]});
      });
    }});
    try {
      await page.locator('.vs-fab-ped').click();
      await page.locator('.ped-sugerencias summary').waitFor();
      assert(await page.locator('.ped-aviso.cliente').count()===0,'Repite el comentario en cada producto');
      assert(await page.locator('.ped-sugerencias[open]').count()===0,'Las sugerencias invaden el carrito');
      await page.locator('.ped-sugerencias summary').click();
      assert(await page.locator('.ped-sugerencias button').count()===2,'Se perdieron acciones de mejor precio');
      await page.screenshot({path:`${out}/listas-vendedor-390.png`,fullPage:true});
      await page.getByLabel('Cantidad de FLECKY X 15 KG').fill('1');
      assert(await page.locator('.ped-sugerencias').count()===0,'Conserva sugerencias del total anterior mientras valida');
      await page.waitForTimeout(500);
      assert(await page.locator('.ped-sugerencias').count()===0,'Sigue ofreciendo L3 sin llegar a 20');
    } finally {await ctx.close();}
  });
} finally {
  await browser.close();await fs.writeFile(`${out}/resultados-listas.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
}
if(results.cases.some(c=>!c.passed)||results.consoleErrors.length)process.exitCode=1;
