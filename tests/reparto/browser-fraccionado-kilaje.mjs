import fs from 'node:fs/promises';
import { browser, results, out, reply, setup, assert, test } from './browser-fixtures.mjs';

/**
 * EL KILAJE DE LA BOLSA SE CARGA DESDE LA PANTALLA DE FRACCIONADO.
 *
 * Mati (17/09/2026): *"van cambiando los kilajes de las bolsas, no son siempre iguales... cómo
 * hacemos ahí? instantánea ahora tiene 20, arrollada por 30 y el sorgo por 40"*. Hasta el 18/09
 * el número vivía en una constante del código: cambiarlo pedía un despliegue y, mientras tanto,
 * el sector fraccionaba mal — 40 kg de sorgo salían como cuatro paquetes de 10 en vez de una
 * bolsa cerrada.
 */
const linea = (o) => ({
  cod_articulo: 0, descripcion: '', cantidades: [], paquetes: 0, kg: 0,
  bolsas_enteras: 0, formato_bolsa: null, sin_formato: true, pedidos: [], ...o,
});
const SIN_KILAJE = [
  linea({ cod_articulo: 403, descripcion: 'SORGO', cantidades: [40], paquetes: 1, kg: 40, pedidos: [40] }),
  linea({ cod_articulo: 704, descripcion: 'AVENA INSTANTANEA', cantidades: [10, 5], paquetes: 2, kg: 15,
          bolsas_enteras: 3, formato_bolsa: 20, sin_formato: false, pedidos: [60, 15] }),
];
/** Lo mismo después de cargarle 40 al sorgo: una bolsa cerrada y nada que pesar. */
const CON_KILAJE = [
  linea({ cod_articulo: 403, descripcion: 'SORGO', cantidades: [], paquetes: 0, kg: 0,
          bolsas_enteras: 1, formato_bolsa: 40, sin_formato: false, pedidos: [40] }),
  SIN_KILAJE[1],
];

const cuerpo = (fraccionado) => ({
  completo: true, dias_faltantes: [], comprobantes_sin_items: [], comprobantes: 1,
  cuenta: { pendientes: 1, facturados: 0 }, fraccionado, produccion: [],
  totales: { productos: fraccionado.length, paquetes: 1, kg: 55 },
  totales_produccion: { productos: 0, bolsas: 0, kg: 0 },
});

/** Abre Fraccionado con el listado dado; `guardados` recoge los PUT de kilaje. */
async function pantalla(guardados, pasos = [SIN_KILAJE]) {
  let vuelta = 0;
  const ctx = await setup(1440, {
    beforeGoto: async p => {
      await p.route('**/api/presupuestos/fraccionado/kilaje/**', async r => {
        const url = new URL(r.request().url());
        guardados.push({ cod: Number(url.pathname.split('/').pop()), body: r.request().postDataJSON() });
        await reply(r, { ok: true });
      });
      await p.route('**/api/presupuestos/fraccionado?**', r =>
        reply(r, cuerpo(pasos[Math.min(vuelta++, pasos.length - 1)])));
    },
  });
  await ctx.page.getByRole('button', { name: 'Fraccionado' }).click();
  await ctx.page.locator('.fr-tabla').waitFor();
  return ctx;
}

try {
  await test('🔴 sin kilaje: la cantidad va entera, la fila se marca y se pide el dato', async () => {
    const { page, ctx } = await pantalla([]);
    try {
      const sorgo = page.locator('tr.fr-sin-formato');
      assert(await sorgo.count() === 1, `${await sorgo.count()} filas marcadas`);
      const texto = await sorgo.innerText();
      assert(texto.includes('SORGO'), 'La fila marcada no es la del sorgo');
      // 40 entero, NO cuatro paquetes de 10: eso era inventar trabajo sobre una bolsa cerrada.
      const cajas = await sorgo.locator('.fr-cajita').allInnerTexts();
      assert(cajas.join(',') === '40', `Se partió en ${cajas.join('·')}`);
      assert((await page.locator('.fr-nota-kilaje').innerText()).includes('sin kilaje'), 'Falta el aviso');
      // Y el pedido crudo, que es con lo que el sector arma el paquete a mano mientras tanto.
      assert((await sorgo.locator('.fr-crudo').allInnerTexts()).join(',') === '40', 'No se ve el pedido');
    } finally { await ctx.close(); }
  });

  await test('🔑 escribir el kilaje lo guarda y rehace el listado con la bolsa cerrada', async () => {
    const guardados = [];
    const { page, ctx } = await pantalla(guardados, [SIN_KILAJE, CON_KILAJE]);
    try {
      const campo = page.locator('tr.fr-sin-formato .fr-kilaje input');
      await campo.fill('40');
      await campo.blur();
      await page.locator('tr.fr-sin-formato').waitFor({ state: 'detached' });
      assert(guardados.length === 1, `Se guardó ${guardados.length} veces`);
      assert(guardados[0].cod === 403 && guardados[0].body?.kg === 40, `Mandó ${JSON.stringify(guardados[0])}`);
      // Ya no hay nada que fraccionar del sorgo: es una bolsa cerrada.
      assert((await page.locator('.fr-bolsas').first().innerText()).includes('40 kg'), 'No quedó como bolsa cerrada');
      assert(await page.locator('.fr-nota-kilaje').count() === 0, 'El aviso quedó pegado');
    } finally { await ctx.close(); }
  });

  await test('🪤 salir del campo sin cambiar nada NO escribe en la base', async () => {
    const guardados = [];
    const { page, ctx } = await pantalla(guardados);
    try {
      // La avena ya tiene 20 cargado: tocarla y salir no es una corrección.
      const campo = page.locator('.fr-kilaje input').nth(1);
      await campo.focus();
      await campo.blur();
      await page.waitForTimeout(300);
      assert(guardados.length === 0, `Guardó sin cambios: ${JSON.stringify(guardados)}`);
    } finally { await ctx.close(); }
  });

  await test('🔴 un kilaje imposible avisa y no se manda', async () => {
    const guardados = [];
    const { page, ctx } = await pantalla(guardados);
    try {
      const campo = page.locator('tr.fr-sin-formato .fr-kilaje input');
      await campo.fill('0');
      await campo.blur();
      await page.locator('.fr-aviso').waitFor();
      assert(guardados.length === 0, 'Mandó un kilaje en cero');
    } finally { await ctx.close(); }
  });
} finally {
  await fs.writeFile(`${out}/fraccionado-kilaje.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
  if (results.cases.some(c => !c.passed) || results.consoleErrors.length) process.exit(1);
}
