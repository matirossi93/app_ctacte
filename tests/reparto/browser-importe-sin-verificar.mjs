import fs from 'node:fs/promises';
import {browser,results,out,rows,reply,setup,assert,test} from './browser-fixtures.mjs';

/**
 * Un pedido cuya factura no se pudo verificar: se ve, se explica y NO se puede elegir.
 *
 * 🪤 Lo que no puede pasar es que muestre `$ 0,00`: un cero se lee como un importe real y decide
 * un reparto.
 */
const MOTIVO = 'No pude verificar el importe actual de la factura 58812033 en InfoManager. Actualizá antes de continuar.';
const ped = (id, extra = {}) => ({
  ...rows[0], im_comprobante_id: id, cod_cliente: Number(id), cliente_nombre: 'CLIENTE ' + id,
  im_numero: 77000 + Number(id), factura_origen: 'unica', im_factura_numero: 4000, cod_zona: 9,
  zona: 'Lules · Manantial', total: 1000, ...extra,
});

async function pantalla(page, pedidos, totales = {}) {
  await page.route('**/api/hojas-ruta/pendientes**', r => reply(r, {
    pendientes: pedidos, dias_sin_items: [],
    totales: { remitos: pedidos.length, importe: null, importe_parcial: 1000, kg: 10, ...totales },
    sin_verificar: pedidos.filter(p => p.importe_error).length,
  }));
  await page.locator('.of-tabs').getByRole('button', { name: 'Hojas de ruta', exact: true }).click();
  await page.locator('.hr-zona-head').first().click();
}

try {
  for (const width of [390, 1440]) await test(`El pedido sin importe se lee y no se puede elegir (${width})`, async () => {
    const { page, ctx } = await setup(width);
    try {
      await pantalla(page, [ped('101'), ped('102', { total: null, importe_error: MOTIVO })]);
      // Las dos filas llegan: una rota no deja sin pantalla a la otra.
      await page.locator('.hr-ped').first().waitFor();
      assert(await page.locator('.hr-ped').count() === 2, 'No llegaron las dos filas');

      const rota = page.locator('.hr-ped.sin-verificar');
      await rota.waitFor();
      const texto = await rota.innerText();
      assert(/importe sin verificar/i.test(texto), `No avisa del importe: "${texto}"`);
      // 🪤 `money()` acá es `'$' + Math.round(n).toLocaleString('es-AR')`: un cero sale como `$0`,
      // sin centavos. Buscar `$ 0,00` no habría detectado el bug.
      assert(!/\$\s*0(?:[,.]0+)?(?![\d.,])/.test(texto), `Muestra un importe cero: "${texto}"`);
      assert(texto.includes('58812033'), 'No se lee el motivo en la fila');

      // Y no se puede elegir, ni tocando el checkbox ni la etiqueta entera.
      assert(await rota.locator('input[type=checkbox]').isDisabled(), 'Se puede elegir sin importe');
      // 🪤 Ni forzando el click sobre la etiqueta entera, que es toda clickeable.
      await rota.click({ position: { x: 40, y: 10 }, force: true });
      assert(!await rota.locator('input[type=checkbox]').isChecked(), 'Quedó elegida igual');

      // 🔴 Y se LEE: el aviso y el motivo dentro de la pantalla, no sólo presentes en el DOM.
      for (const sel of ['.hr-sin-importe', '.hr-ped.sin-verificar .hr-sinpeso']) {
        const m = await page.evaluate(({ s, w }) => {
          const e = document.querySelector(s);
          if (!e) return { falta: true };
          const r = e.getBoundingClientRect();
          return { falta: false, izq: r.left, der: r.right, alto: r.height, w };
        }, { s: sel, w: width });
        assert(!m.falta, `Falta ${sel} en ${width}`);
        assert(m.alto > 0, `${sel} no ocupa lugar en ${width}`);
        assert(m.izq >= -1 && m.der <= width + 1, `${sel} queda fuera de la pantalla en ${width}`);
      }

      await page.screenshot({ path: `${out}/importe-sin-verificar-${width}.png`, fullPage: true });
    } finally { await ctx.close(); }
  });

  await test('Elegir la zona entera no arrastra la que no se puede verificar', async () => {
    const { page, ctx } = await setup(1440);
    try {
      await pantalla(page, [ped('101'), ped('102', { total: null, importe_error: MOTIVO }), ped('103')]);
      await page.locator('.hr-zona-head input[type=checkbox]').first().check();
      const marcadas = await page.locator('.hr-ped input[type=checkbox]:checked').count();
      assert(marcadas === 2, `Eligió ${marcadas} en vez de las 2 verificables`);
      assert(!await page.locator('.hr-ped.sin-verificar input[type=checkbox]').isChecked(), 'Arrastró la no verificable');
    } finally { await ctx.close(); }
  });

  await test('La zona dice cuántas quedaron sin verificar', async () => {
    const { page, ctx } = await setup(1440);
    try {
      await pantalla(page, [ped('101'), ped('102', { total: null, importe_error: MOTIVO })]);
      assert(await page.locator('.hr-zona-pendiente').count() === 1, 'No avisa en la zona');
      assert((await page.locator('.hr-zona-pendiente').innerText()).includes('1 sin verificar'), 'No dice cuántas');
    } finally { await ctx.close(); }
  });

  /** 🪤 Si TODA la zona quedó sin verificar, su casilla no puede quedar usable. */
  await test('Una zona entera sin verificar no se puede elegir', async () => {
    const { page, ctx } = await setup(1440);
    try {
      await pantalla(page, [ped('101', { total: null, importe_error: MOTIVO })]);
      assert(await page.locator('.hr-zona-head input[type=checkbox]').first().isDisabled(), 'La zona quedó elegible');
    } finally { await ctx.close(); }
  });
} finally {
  await browser.close();
  await fs.writeFile(`${out}/resultados-importe-sin-verificar.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
}
if (results.cases.some(c => !c.passed) || results.consoleErrors.length) process.exitCode = 1;
