import fs from 'node:fs/promises';
import {browser,results,out,row,rows,reply,presupuestos,setup,assert,test} from './browser-fixtures.mjs';

/**
 * Los avisos: que se lean, no que tapen la pantalla.
 *
 * 🔴 La regla es la misma en las dos pantallas: **agrupar, no borrar**. Un badge que resume
 * cuántos problemas hay y los muestra al abrir sirve; cinco chips pegados no se leen, y borrar
 * uno esconde plata.
 */
const conProblemas = { ...row('101', 'CLIENTE ALFA'),
  gravedad: { pierde_margen: 12000, cobra_de_mas: 0 },
  avisos: ['ALPISTE: lista 13 en vez de 12'],
  avisos_cantidad: ['MAÍZ: 30 bolsas de 30 kg son 900 kg'],
  faltantes: [{ cod_articulo: 5, descripcion: 'SORGO', pedido: 10, disponible: 2 }],
  hermanos: [{ im_numero: 99, total: 1000 }],
};
const unProblema = { ...row('102', 'CLIENTE BETA'), faltantes: [{ cod_articulo: 5, descripcion: 'SORGO', pedido: 10, disponible: 2 }] };

const hoja = {
  version: 2, id: 'h1', numero: 3405, fecha: '2026-09-10', turno: 'Mañana', camion: 'Camión 5000',
  camion_id: 'c1', capacidad_kg: 5000, chofer: 'Chofer', chofer_id: 'ch1', estado: 'abierta',
  facturada: true, pedidos: [], totales: { pedidos: 0, bultos: 0, kg: 0 },
  carga: { porcentaje: 0, excedido: false, sobra_kg: 5000 },
};

try {
  await test('🔴 Los problemas de un presupuesto entran en UN badge, y el detalle los muestra todos', async () => {
    const { page, ctx } = await setup(1440, { beforeGoto: p => {
      p.route('**/api/presupuestos?**', r => reply(r, presupuestos([conProblemas, unProblema])));
      p.route('**/api/presupuestos', r => reply(r, presupuestos([conProblemas, unProblema])));
    } });
    try {
      const fila = page.locator('.pr-fila').first();
      await fila.waitFor();
      const badges = fila.locator('.pr-cli .pr-badge');
      // Antes eran cinco chips pegados: la fila dejaba de leerse.
      assert(await badges.count() === 1, `Siguen apilados ${await badges.count()} badges`);
      const texto = await badges.first().innerText();
      assert(/4 para revisar/.test(texto), `No dice cuántos problemas hay: "${texto}"`);
      // 🪤 Y no se pierde nada: el detalle sigue teniendo el texto completo de cada uno.
      const titulo = await badges.first().getAttribute('title');
      for (const parte of ['por debajo de lista', 'otro pedido igual', 'cantidad', 'sin stock']) {
        assert(titulo.includes(parte), `Falta "${parte}" en el resumen: "${titulo}"`);
      }
      await page.locator('.pr-fila').first().locator('.pr-abrir').click();
      await page.locator('.pr-detalle').first().waitFor();
      const detalle = await page.locator('.pr-fila').first().locator('.pr-detalle').innerText();
      for (const parte of ['900 kg', 'SORGO', 'PR 99']) {
        assert(detalle.includes(parte), `El detalle perdió "${parte}": "${detalle}"`);
      }
    } finally { await ctx.close(); }
  });

  await test('Con un solo problema se sigue leyendo cuál es, sin contador', async () => {
    const { page, ctx } = await setup(1440, { beforeGoto: p => {
      p.route('**/api/presupuestos?**', r => reply(r, presupuestos([unProblema])));
      p.route('**/api/presupuestos', r => reply(r, presupuestos([unProblema])));
    } });
    try {
      const badge = page.locator('.pr-fila').first().locator('.pr-cli .pr-badge').first();
      await badge.waitFor();
      const texto = await badge.innerText();
      assert(/sin stock \(1\)/.test(texto), `Esconde cuál es el problema: "${texto}"`);
    } finally { await ctx.close(); }
  });

  await test('🔴 Los avisos del rango de hojas no empujan la pantalla, pero se pueden leer enteros', async () => {
    const { page, ctx } = await setup(1440, {
      url: '/reparto?etapa=hojas&desde=2026-09-08&hasta=2026-09-10', ready: '.hr-hoja',
      beforeGoto: async p => {
        await p.route('**/api/hojas-ruta?**', r => reply(r, { hojas: [hoja] }));
        await p.route('**/api/hojas-ruta/arrastre**', r => reply(r, { ok: true, cantidad: 7 }));
        await p.route('**/api/hojas-ruta/pendientes**', r => reply(r, {
          pendientes: rows.map(x => ({ ...x, factura_origen: 'unica', im_factura_numero: 4000 })),
          dias_sin_items: ['2026-09-08', '2026-09-09'],
        }));
      },
    });
    try {
      const banners = page.locator('.hr-aviso');
      await banners.first().waitFor();
      assert(await banners.count() === 1, `Quedaron ${await banners.count()} banners apilados`);
      const cerrado = await banners.first().innerText();
      assert(/2 avisos/.test(cerrado), `No dice cuántos son: "${cerrado}"`);
      // 🔴 Agrupar no puede significar esconder: el texto completo está a un clic.
      assert(!/0 kg/.test(cerrado), 'Muestra el detalle sin que se lo pidan');
      await banners.first().getByRole('button', { name: 'Ver' }).click();
      const abierto = await banners.first().innerText();
      assert(/7/.test(abierto) && /0 kg/.test(abierto), `No se leen los avisos completos: "${abierto}"`);
      await page.screenshot({ path: out + '/avisos-hojas.png', fullPage: true });
    } finally { await ctx.close(); }
  });
} finally {
  await browser.close();
  await fs.writeFile(out + '/browser-avisos.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  if (results.cases.some(c => !c.passed) || results.consoleErrors.length) process.exit(1);
}
