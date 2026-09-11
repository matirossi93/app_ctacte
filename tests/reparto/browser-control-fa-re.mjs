import fs from 'node:fs/promises';
import {browser,results,out,rows,reply,setup,assert,test} from './browser-fixtures.mjs';

/**
 * El control informativo que compara la factura con su remito.
 *
 * Se prueba que el resultado se LEE —códigos, las dos cantidades y la hora—, y no sólo que
 * aparezca un cartel: en el celular no hay hover y un `title` no existe.
 */
const FILA = (extra = {}) => ({
  ...rows[0], im_factura_id: '501', im_factura_numero: 501, im_factura_tipo: 'FA B',
  im_remito_id: '601', im_remito_numero: 601, facturado_at: '2026-09-11', notas: [], ...extra,
});
const CONTROL = (estado, extra = {}) => ({ estado, texto: estado === 'diferencias'
  ? 'La factura y el remito tienen cantidades distintas: 378 (factura 0, remito 1).'
  : estado === 'coinciden' ? 'Coinciden las cantidades registradas en la factura y el remito.'
  : 'Los comprobantes son de días que esta pantalla no trajo. Se puede comparar a pedido.',
  diferencias: estado === 'diferencias' ? [{ cod_articulo: 378, factura: 0, remito: 1 }] : [],
  checked_at: '2026-09-11T15:00:00.000Z', ...extra });

async function tablero(page, control, opciones = {}) {
  await page.route('**/api/facturacion?**', r => reply(r, {
    pendientes: [], facturados: [FILA({ control_fa_re: control })],
    totales: { pendientes: 0, facturados: 1, con_diferencias: control?.estado === 'diferencias' ? 1 : 0 },
  }));
  if (opciones.comparar) await page.route('**/api/facturacion/comparar/**', opciones.comparar);
  await page.locator('.of-tabs').getByRole('button', { name: 'Facturación', exact: true }).click();
  await page.locator('.fc-facturados summary').click();
}

try {
  for (const width of [390, 1440]) await test(`La diferencia se lee en pantalla, no en un tooltip (${width})`, async () => {
    const { page, ctx } = await setup(width);
    try {
      await tablero(page, CONTROL('diferencias'));
      // El aviso de la fila, sin hover.
      await page.locator('.fc-difieren').waitFor();
      // Y el detalle con los números, al tocar el botón.
      await page.getByRole('button', { name: /Difieren/ }).click();
      const panel = page.locator('.fc-control');
      await panel.waitFor();
      const texto = await panel.innerText();
      assert(/378/.test(texto), `No muestra el código: "${texto}"`);
      assert(/Factura/i.test(texto) && /Remito/i.test(texto), 'No muestra las dos cantidades');
      assert(/mirado a las/i.test(texto), 'No dice a qué hora se miró');
      await page.screenshot({ path: `${out}/control-fa-re-${width}.png`, fullPage: true });
    } finally { await ctx.close(); }
  });

  await test('Coincidencia y no verificado son discretos: nada en la fila', async () => {
    const { page, ctx } = await setup(1440);
    try {
      await tablero(page, CONTROL('coinciden'));
      assert(await page.locator('.fc-difieren').count() === 0, 'Pone un cartel por una coincidencia');
      await page.getByRole('button', { name: /Coinciden/ }).click();
      assert((await page.locator('.fc-control').innerText()).includes('cantidades registradas'), 'No se lee el resultado');
    } finally { await ctx.close(); }
  });

  /** 🔴 Al abortar una comparación para empezar otra, la primera quedaba en "Comparando…". */
  await test('Abortar una comparación no deja el botón bloqueado', async () => {
    const { page, ctx } = await setup(1440);
    let soltar = () => {};
    const puerta = new Promise(r => { soltar = r; });
    try {
      await page.route('**/api/facturacion?**', r => reply(r, {
        pendientes: [], totales: { pendientes: 0, facturados: 2 },
        facturados: [FILA({ control_fa_re: CONTROL('no_verificado') }),
                     FILA({ im_comprobante_id: '102', cod_cliente: 102, cliente_nombre: 'CLIENTE BETA', control_fa_re: CONTROL('no_verificado') })],
      }));
      await page.route('**/api/facturacion/comparar/101', async r => { await puerta; await reply(r, { ok: true, im_comprobante_id: '101', checked_at: '2026-09-11T15:00:00.000Z', control: CONTROL('coinciden') }).catch(() => {}); });
      await page.route('**/api/facturacion/comparar/102', r => reply(r, { ok: true, im_comprobante_id: '102', checked_at: '2026-09-11T15:00:00.000Z', control: CONTROL('coinciden') }));
      await page.locator('.of-tabs').getByRole('button', { name: 'Facturación', exact: true }).click();
      await page.locator('.fc-facturados summary').click();

      const botones = page.getByRole('button', { name: /Comparar|Comparando|Sin dato/ });
      await botones.nth(0).click();
      await page.getByRole('button', { name: /Comparando/ }).waitFor();
      await botones.nth(1).click();                       // aborta la primera
      await page.locator('.fc-control').waitFor();
      soltar();
      // El primero tiene que volver a estar disponible, no clavado en "Comparando…".
      await page.waitForTimeout(300);
      assert(await page.getByRole('button', { name: /Comparando/ }).count() === 0, 'Quedó un botón bloqueado en "Comparando…"');
    } finally { soltar(); await ctx.close(); }
  });

  /** 🔴 Una respuesta de otra fila dejaba el botón en "Comparando…" para siempre. */
  await test('Una respuesta de otro pedido no clava el botón', async () => {
    const { page, ctx } = await setup(1440);
    try {
      await tablero(page, CONTROL('no_verificado'), {
        comparar: r => reply(r, { ok: true, im_comprobante_id: '999', checked_at: '2026-09-11T15:00:00.000Z', control: CONTROL('coinciden') }),
      });
      await page.getByRole('button', { name: /Sin dato|Comparar/ }).click();
      await page.locator('.fc-control').waitFor();
      const texto = await page.locator('.fc-control').innerText();
      assert(/cambiaron|no se pudo/i.test(texto), `No avisa del descarte: "${texto}"`);
      assert(await page.getByRole('button', { name: /Comparando/ }).count() === 0, 'Quedó clavado en "Comparando…"');
    } finally { await ctx.close(); }
  });

  await test('Abrir una corrección descarta lo comparado', async () => {
    const { page, ctx } = await setup(1440);
    try {
      await page.route('**/api/facturacion/corregir/501', r => reply(r, { factura: { id: '501', numero: 501, letra: 'B', cliente_nombre: 'CLIENTE ALFA', fecha: '2026-09-10' }, version: 1, operacion: null, bloqueo_productos: null, renglones: [] }));
      await tablero(page, CONTROL('no_verificado'), {
        comparar: r => reply(r, { ok: true, im_comprobante_id: '101', checked_at: '2026-09-11T15:00:00.000Z', control: CONTROL('coinciden') }),
      });
      await page.getByRole('button', { name: /Sin dato|Comparar/ }).click();
      await page.locator('.fc-control').waitFor();
      await page.locator('.fc-corregir').first().click();
      assert(await page.locator('.fc-control').count() === 0, 'Conserva el resultado viejo al abrir la corrección');
    } finally { await ctx.close(); }
  });
} finally {
  await browser.close();
  await fs.writeFile(`${out}/resultados-control-fa-re.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
}
if (results.cases.some(c => !c.passed) || results.consoleErrors.length) process.exitCode = 1;
