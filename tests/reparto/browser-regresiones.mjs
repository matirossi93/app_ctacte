import fs from 'node:fs/promises';
import {browser,results,out,base,user,row,rows,presupuestos,item,reply,setup,assert,test} from './browser-fixtures.mjs';
try {
  for(const width of [1440,768,390,360]) {
    await test('Navegación y ancho '+width, async()=>{
      const {page,ctx}=await setup(width);
      try {
        for(const tab of ['Presupuestos','Fraccionado','Facturación','Hojas de ruta']) {
          await page.locator('.of-tabs').getByRole('button',{name:tab,exact:true}).click();
          await page.waitForTimeout(120);
          const m=await page.evaluate(()=>({width:document.querySelector('.of-body').clientWidth,scroll:document.querySelector('.of-body').scrollWidth}));
          assert(m.scroll <= m.width+2,`${tab}: contenido ${m.scroll}px excede contenedor ${m.width}px`);
          await page.screenshot({path:`${out}/ui-${width}-${tab.replaceAll(' ','-')}.png`,fullPage:true});
        }
      } finally { await ctx.close(); }
    });
  }
  await test('Detalle conserva identidad y guarda productos del cliente correcto', async()=>{
    const {page,ctx}=await setup();
    try {
      let releaseA,releaseB;
      const gateA=new Promise(r=>releaseA=r),gateB=new Promise(r=>releaseB=r);
      await page.route('**/api/presupuestos/101',async r=>{await gateA;await reply(r,{items:[item(11,'PRODUCTO ALFA')],comprobante:{im_comprobante_id:'101',numero:101,cod_cliente:101,cliente_nombre:'CLIENTE ALFA',fecha:'2026-09-10',observaciones:'OBS ALFA',huella:'v101'}}).catch(()=>{});});
      await page.route('**/api/presupuestos/102',async r=>{await gateB;await reply(r,{items:[item(22,'PRODUCTO BETA')],comprobante:{im_comprobante_id:'102',numero:102,cod_cliente:102,cliente_nombre:'CLIENTE BETA',fecha:'2026-09-10',observaciones:'OBS BETA',huella:'v102'}}).catch(()=>{});});
      await page.locator('.pr-abrir').nth(0).click();
      await page.locator('.pr-abrir').nth(1).click();
      releaseA(); await page.waitForTimeout(150);
      assert(!await page.locator('.ed-tabla tbody tr').filter({hasText:'PRODUCTO ALFA'}).isVisible(),'Respuesta ALFA aparece bajo BETA');
      releaseB(); await page.locator('.ed-tabla tbody tr').filter({hasText:'PRODUCTO BETA'}).waitFor().catch(async e=>{await fs.writeFile(`${out}/detalle-fallo.html`,await page.content());await page.screenshot({path:`${out}/detalle-fallo.png`,fullPage:true});throw e;});
      let saved;
      await page.route('**/api/presupuestos/102/editar',async r=>{saved=r.request().postDataJSON();await reply(r,{ok:true,modo:'cantidades',im_numero:102});});
      page.on('dialog',d=>d.accept());
      await page.locator('.pr-detalle .ed-cant').fill('3');
      await page.locator('.pr-detalle').getByRole('button',{name:/Guardar/}).click();
      await page.waitForTimeout(150);
      assert(saved?.items?.[0]?.cod_articulo===22,'Guardado tiene artículos de otro cliente');
      assert(saved?.huella==='v102','Guardado no conserva versión origen');
      await page.screenshot({path:`${out}/detalle-correcto.png`,fullPage:true});
    } finally { await ctx.close(); }
  });
  await test('Aprobar usa la versión del detalle visible y bloquea borradores sin guardar',async()=>{
    const {page,ctx}=await setup();
    try {
      let enviado=null,calls=0;
      await page.route('**/api/presupuestos/101',r=>reply(r,{items:[item(11,'PRODUCTO REVISADO')],comprobante:{im_comprobante_id:'101',numero:101,cod_cliente:101,fecha:'2026-09-10',huella:'detalle-actual'}}));
      await page.route('**/api/presupuestos/101/revision',r=>{calls++;enviado=r.request().postDataJSON();return reply(r,{error:'Conflicto simulado'},409);});
      await page.locator('.pr-abrir').nth(0).click();
      await page.locator('.ed-tabla tbody tr').filter({hasText:'PRODUCTO REVISADO'}).waitFor();
      await page.getByRole('button',{name:'Aprobar',exact:true}).nth(0).click();
      await page.getByText('Conflicto simulado',{exact:true}).waitFor();
      assert(enviado?.huella==='detalle-actual','Se envió la versión vieja del listado');
      await page.locator('.pr-detalle .ed-cant').fill('3');
      await page.getByRole('button',{name:'Aprobar',exact:true}).nth(0).click();
      await page.getByText('Guardá o descartá los cambios de este presupuesto antes de aprobarlo.',{exact:true}).waitFor();
      assert(calls===1,'Se aprobó con cambios pendientes sin guardar');
    } finally {await ctx.close();}
  });
  /**
   * 🔴 Mati (11/09/2026), después de aprobar un presupuesto: *"¿qué es borrador?"*.
   *
   * El cartel de abajo salía por tener el detalle abierto y fuera del filtro, sin mirar si había
   * cambios. Como aprobar saca al presupuesto de "sin revisar", abrir uno para mirarlo y
   * aprobarlo ya lo disparaba. Y en ese camino nunca puede ser cierto: `revisar()` frena la
   * aprobación cuando hay un borrador vivo.
   */
  await test('Aprobar un PR abierto sin editar NO lo llama borrador', async()=>{
    const {page,ctx}=await setup();
    try {
      await page.route('**/api/presupuestos/101',r=>reply(r,{items:[item(11,'PRODUCTO LIMPIO')],comprobante:{im_comprobante_id:'101',numero:101,cod_cliente:101,fecha:'2026-09-10',huella:'v101'}}));
      await page.route('**/api/presupuestos/101/revision',r=>reply(r,{ok:true}));
      await page.locator('.pr-abrir').nth(0).click();
      await page.locator('.ed-tabla tbody tr').filter({hasText:'PRODUCTO LIMPIO'}).waitFor();
      // Aprobar lo saca de "sin revisar", que es el filtro por defecto: el panel de abajo aparece.
      await page.getByRole('button',{name:'Aprobar',exact:true}).nth(0).click();
      await page.locator('.pr-detalle').waitFor();
      const texto = await page.locator('.pr-detalle-motivo').innerText();
      assert(!/borrador/i.test(texto), `Sigue diciendo borrador sin cambios: "${texto}"`);
      assert(/fuera del filtro/i.test(texto), `Perdió la explicación de por qué está abajo: "${texto}"`);
      // Y el aviso de borradores REALES de arriba no se inventa ninguno.
      assert(await page.getByText('Borradores sin guardar:').count()===0,'Inventó un borrador sin guardar');
      // 🔑 Se aprobó de verdad: está en Aprobados, no sólo ausente de la palabra.
      await page.getByRole('button',{name:/^Aprobados/}).click();
      await page.locator('.pr-fila').filter({hasText:'CLIENTE ALFA'}).waitFor();
    } finally {await ctx.close();}
  });

  /**
   * 🪤 Astra (11/09/2026): `reparto.borradores` es un Map pelado y escribirlo no re-renderiza.
   * Si se edita DESPUÉS de que el detalle quedó fuera del filtro, el cartel seguía afirmando lo
   * que ya no era cierto. Se prueba el ciclo entero sin tocar el filtro en el medio.
   */
  await test('El cartel se actualiza al ensuciar y al revertir, sin tocar el filtro', async()=>{
    const {page,ctx}=await setup();
    try {
      await page.route('**/api/presupuestos/101',r=>reply(r,{items:[item(11,'PRODUCTO LIMPIO')],comprobante:{im_comprobante_id:'101',numero:101,cod_cliente:101,fecha:'2026-09-10',huella:'v101'}}));
      await page.route('**/api/presupuestos/101/revision',r=>reply(r,{ok:true}));
      await page.locator('.pr-abrir').nth(0).click();
      await page.locator('.pr-detalle .ed-cant').waitFor();
      const original = await page.locator('.pr-detalle .ed-cant').inputValue();
      await page.getByRole('button',{name:'Aprobar',exact:true}).nth(0).click();
      await page.locator('.pr-detalle-motivo').waitFor();
      assert(!/borrador/i.test(await page.locator('.pr-detalle-motivo').innerText()),'Arranca diciendo borrador');

      // Ensuciar ACÁ ABAJO, con el detalle ya fuera del filtro.
      await page.locator('.pr-detalle .ed-cant').fill('7');
      await page.locator('.pr-detalle-motivo').filter({hasText:/borrador/i}).waitFor();
      assert(await page.getByText('Borradores sin guardar:').isVisible(),'No apareció el aviso de borradores reales');

      // Y al volver al valor original tiene que dejar de decirlo.
      await page.locator('.pr-detalle .ed-cant').fill(original);
      await page.locator('.pr-detalle-motivo').filter({hasText:/^Detalle del PR/}).waitFor();
      assert(await page.getByText('Borradores sin guardar:').count()===0,'Quedó un borrador después de revertir');
    } finally {await ctx.close();}
  });

  /** La otra cara: con un cambio de verdad, el cartel SÍ tiene que avisar y proteger. */
  await test('Con cambios sin guardar sí dice borrador y no se pierden al filtrar', async()=>{
    const {page,ctx}=await setup();
    try {
      await page.route('**/api/presupuestos/101',r=>reply(r,{items:[item(11,'PRODUCTO EDITADO')],comprobante:{im_comprobante_id:'101',numero:101,cod_cliente:101,fecha:'2026-09-10',huella:'v101'}}));
      await page.locator('.pr-abrir').nth(0).click();
      await page.locator('.pr-detalle .ed-cant').waitFor();
      await page.locator('.pr-detalle .ed-cant').fill('7');
      // Se lo saca del filtro por búsqueda, sin aprobarlo: el borrador tiene que sobrevivir.
      await page.locator('.pr-buscador input').fill('CLIENTE BETA');
      await page.locator('.pr-detalle').waitFor();
      const texto = await page.locator('.pr-detalle-motivo').innerText();
      assert(/borrador/i.test(texto), `No avisa que hay cambios sin guardar: "${texto}"`);
      assert(/sin guardar/i.test(texto), `No dice que son cambios sin guardar: "${texto}"`);
      assert(await page.locator('.pr-detalle .ed-cant').inputValue()==='7','Se perdió el cambio al filtrar');
      assert(await page.getByText('Borradores sin guardar:').isVisible(),'Perdió el aviso de borradores reales');
    } finally {await ctx.close();}
  });

  await test('Respuesta de rango antiguo no reemplaza la actual', async()=>{
    const {page,ctx}=await setup();
    try {
      let release;
      const gate=new Promise(r=>release=r);
      await page.route('**/api/presupuestos?**',async route=>{
        const desde=new URL(route.request().url()).searchParams.get('desde');
        if(desde==='2026-09-08') await gate;
        await reply(route,presupuestos([row('201','DATOS DEL '+desde,desde)])).catch(()=>{});
      });
      await page.locator('.of-rango input').nth(0).fill('2026-09-08');
      await page.locator('.of-rango input').nth(0).fill('2026-09-09');
      await page.getByText('DATOS DEL 2026-09-09',{exact:true}).waitFor();
      release(); await page.waitForTimeout(150);
      assert(!await page.getByText('DATOS DEL 2026-09-08',{exact:true}).isVisible(),'Datos viejos reemplazan la fecha actual');
      assert(await page.getByText('DATOS DEL 2026-09-09',{exact:true}).isVisible(),'Se perdió la respuesta actual');
    } finally { await ctx.close(); }
  });
  await test('Fraccionado no imprime datos anteriores después de error', async()=>{
    const {page,ctx}=await setup();
    try {
      await page.locator('.of-tabs button').filter({hasText:'Fraccionado'}).click();
      await page.getByText('ALPISTE AUDITORÍA',{exact:true}).waitFor();
      await page.route('**/api/presupuestos/fraccionado?**',r=>reply(r,{error:'Corte simulado de InfoManager'},502));
      await page.locator('.of-rango input').nth(0).fill('2026-09-08');
      await page.getByText('Corte simulado de InfoManager',{exact:true}).waitFor();
      assert(!await page.getByRole('button',{name:'Imprimir',exact:true}).isEnabled(),'Imprimir está habilitado tras error');
      assert(!await page.getByText('ALPISTE AUDITORÍA',{exact:true}).isVisible(),'Quedaron filas anteriores bajo fecha nueva');
      await page.pdf({path:`${out}/fraccionado-error.pdf`,format:'A4'});
    } finally { await ctx.close(); }
  });
  await test('Elegir todos comprueba pertenencia, preserva selección visible', async()=>{
    const {page,ctx}=await setup();
    try {
      await page.locator('.of-tabs button').filter({hasText:'Facturación'}).click();
      await page.locator('.fc-tabla').waitFor();
      await page.locator('.fc-tabla tbody input[type=checkbox]').nth(0).check();
      await page.locator('.fc-buscador input').fill('BETA');
      assert(!await page.getByTitle('Elegir todos',{exact:true}).isChecked(),'Encabezado marcado por selección de otro cliente');
      assert(await page.getByRole('status').filter({hasText:/seleccionados.*fuera/}).isVisible(),'No advierte selección fuera del filtro');
      await page.getByTitle('Elegir todos',{exact:true}).check();
      await page.locator('.fc-buscador input').fill('');
      assert(await page.locator('.fc-tabla tbody input:checked').count()===2,'Elegir visibles borra la selección anterior');
    } finally { await ctx.close(); }
  });
  await test('Cambiar de etapa conserva borradores y evita consultas de vistas ocultas', async()=>{
    const {page,ctx,seen}=await setup();
    try {
      await page.locator('.pr-abrir').first().click();
      await page.locator('.pr-detalle .ed-cant').fill('7');
      await page.locator('.of-tabs').getByRole('button',{name:'Facturación',exact:true}).click();
      await page.locator('.fc-tabla').waitFor();
      await page.locator('.fc-tabla tbody input[type=checkbox]').first().check();
      const start=seen.length;
      await page.locator('.of-rango input').nth(0).fill('2026-09-08');
      await page.waitForTimeout(150);
      assert(!seen.slice(start).some(url=>/^\/api\/presupuestos(?:\?|\/consolidado|\/fraccionado)/.test(url)), 'Cambiar el rango consulta una etapa oculta');
      await page.locator('.of-tabs').getByRole('button',{name:'Presupuestos',exact:true}).click();
      await page.locator('.pr-detalle .ed-cant').waitFor();
      assert(await page.locator('.pr-detalle .ed-cant').inputValue()==='7','Se perdió el borrador al volver a la etapa');
      await page.locator('.ps-subtabs').getByRole('button',{name:'Por artículo',exact:true}).click();
      await page.waitForTimeout(150);
      const subStart=seen.length;
      await page.locator('.of-rango input').nth(0).fill('2026-09-07');
      await page.waitForTimeout(150);
      assert(!seen.slice(subStart).some(url=>/^\/api\/presupuestos\?/.test(url)), 'Por pedido oculta sigue consultando el rango');
      await page.locator('.ps-subtabs').getByRole('button',{name:'Por pedido',exact:true}).click();
      await page.locator('.pr-detalle .ed-cant').waitFor();
      assert(await page.locator('.pr-detalle .ed-cant').inputValue()==='7','Se perdió el borrador al cambiar de subsección');
    } finally { await ctx.close(); }
  });
} finally {
  await fs.writeFile(`${out}/browser-regresiones.json`,JSON.stringify(results,null,2));
  await browser.close();
}
console.log(JSON.stringify(results,null,2));
if(results.cases.some(c=>!c.passed)||results.consoleErrors.length)process.exitCode=1;
