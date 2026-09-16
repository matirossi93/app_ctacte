import fs from 'node:fs/promises';
import {browser,results,out,reply,setup,assert,test} from './browser-fixtures.mjs';

/**
 * El buscador de la sección "por artículo". Mati (16/09/2026): *"deberíamos incluir también un
 * buscador para que podamos filtrar por productos cuando necesitemos buscar algo"*.
 */
const art = (cod, descripcion, falta = 0) => ({
  cod_articulo: cod, descripcion, unidad_de_medida: 'Kilos', equivalencia_um: 1,
  pedido: 100, stock: falta ? 50 : 500, falta, pedidos: 2, quienes: [],
});
const ARTICULOS = [
  art(1, 'ALPISTE', 20), art(2, 'MAIZ QUEBRADO FINO X 30 KG'), art(3, 'GIRASOL PELADO'),
  art(4, 'AVENA INSTANTANEA', 5), art(5, 'MEZCLA GALLO PREMIUM'),
];

const pantalla = () => setup(1440, {
  beforeGoto: p => p.route('**/api/presupuestos/consolidado**', r => reply(r, {
    articulos: ARTICULOS,
    totales: { articulos: ARTICULOS.length, faltantes: 2, sin_stock_consultado: false, sin_renglones: 0, con_cantidad_dudosa: 0 },
  })),
});

async function abrirConsolidado(page) {
  // El consolidado se monta recién cuando se lo visita: cuesta segundos contra IM.
  await page.locator('.ps-subtabs').getByRole('button', { name: 'Por artículo' }).click();
  await page.locator('.co-buscar').waitFor();
  // Sin el filtro por defecto, para contar sobre la lista completa.
  const check = page.locator('.co-check input');
  if (await check.isChecked()) await check.uncheck();
}

try {
  await test('🔑 filtra por nombre de producto', async () => {
    const { page, ctx } = await pantalla();
    try {
      await abrirConsolidado(page);
      const filas = page.locator('.co-art');
      assert(await filas.count() === 5, `Arrancó con ${await filas.count()} filas`);
      await page.locator('.co-buscar input').fill('girasol');
      await page.waitForFunction(() => document.querySelectorAll('.co-art').length === 1);
      assert((await filas.first().innerText()).includes('GIRASOL PELADO'), 'Filtró mal');
    } finally { await ctx.close(); }
  });

  await test('🔑 y por código, que es como lo busca la oficina', async () => {
    const { page, ctx } = await pantalla();
    try {
      await abrirConsolidado(page);
      await page.locator('.co-buscar input').fill('4');
      await page.waitForFunction(() => document.querySelectorAll('.co-art').length === 1);
      assert((await page.locator('.co-art').first().innerText()).includes('AVENA'), 'No encontró por código');
    } finally { await ctx.close(); }
  });

  /** 🪤 "maiz quebrado" y "quebrado maiz" tienen que encontrar lo mismo. */
  await test('varias palabras, en cualquier orden', async () => {
    const { page, ctx } = await pantalla();
    try {
      await abrirConsolidado(page);
      for (const q of ['maiz quebrado', 'quebrado maiz', 'QUEBRADO FINO']) {
        await page.locator('.co-buscar input').fill(q);
        await page.waitForFunction(() => document.querySelectorAll('.co-art').length === 1);
        assert((await page.locator('.co-art').first().innerText()).includes('QUEBRADO'), `Falló con "${q}"`);
      }
    } finally { await ctx.close(); }
  });

  await test('se puede limpiar y vuelve la lista entera', async () => {
    const { page, ctx } = await pantalla();
    try {
      await abrirConsolidado(page);
      await page.locator('.co-buscar input').fill('girasol');
      await page.waitForFunction(() => document.querySelectorAll('.co-art').length === 1);
      await page.locator('.co-buscar button').click();
      await page.waitForFunction(() => document.querySelectorAll('.co-art').length === 5);
    } finally { await ctx.close(); }
  });

  /** 🪤 El buscador filtra lo que ya está: no puede disparar una consulta por tecla. */
  await test('🔴 escribir no vuelve a consultar el servidor', async () => {
    const { page, ctx } = await pantalla();
    let consultas = 0;
    try {
      await page.route('**/api/presupuestos/consolidado**', r => { consultas++; return reply(r, {
        articulos: ARTICULOS, totales: { articulos: 5, faltantes: 2, sin_stock_consultado: false, sin_renglones: 0, con_cantidad_dudosa: 0 } }); });
      await abrirConsolidado(page);
      const antes = consultas;
      await page.locator('.co-buscar input').fill('mezcla gallo premium');
      await page.waitForFunction(() => document.querySelectorAll('.co-art').length === 1);
      assert(consultas === antes, `Consultó ${consultas - antes} veces al escribir`);
    } finally { await ctx.close(); }
  });
} finally {
  await browser.close();
  await fs.writeFile(out + '/browser-consolidado-buscar.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  if (results.cases.some(c => !c.passed) || results.consoleErrors.length) process.exit(1);
}
