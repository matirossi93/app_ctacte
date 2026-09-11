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
  /**
   * 🔴 No alcanza con que el texto esté en el DOM. La primera versión ponía el panel dentro de
   * un `<tr>` de la tabla, que tiene scroll horizontal: en 390 px arrancaba cortado —«ntas:
   * 378…»— y la tabla de cantidades ni se veía. Se miden RECTÁNGULOS contra el viewport.
   */
  for (const width of [390, 1440]) await test(`La diferencia se LEE completa en ${width} px`, async () => {
    const { page, ctx } = await setup(width);
    try {
      await tablero(page, CONTROL('diferencias'));
      await page.locator('.fc-difieren').waitFor();          // el aviso de la fila, sin hover
      await page.getByRole('button', { name: /Difieren/ }).click();
      await page.locator('.fc-control').waitFor();

      /** ¿Entra entero en la pantalla, sin quedar cortado a izquierda ni a derecha? */
      const entra = (sel) => page.evaluate(({ s, w }) => {
        const e = document.querySelector(s);
        if (!e) return { falta: true };
        const r = e.getBoundingClientRect();
        return { falta: false, izq: r.left, der: r.right, ancho: r.width, alto: r.height, w };
      }, { s: sel, w: width });

      for (const sel of ['.fc-control', '.fc-control-quien', '.fc-control-texto', '.fc-control-tabla', '.fc-control-hora', '.fc-control-cerrar']) {
        const m = await entra(sel);
        assert(!m.falta, `Falta ${sel} en ${width}`);
        assert(m.ancho > 0 && m.alto > 0, `${sel} no ocupa lugar en ${width}`);
        assert(m.izq >= -1, `${sel} arranca fuera de la pantalla (x=${m.izq}) en ${width}`);
        assert(m.der <= width + 1, `${sel} se sale por la derecha (${m.der} > ${width})`);
      }

      // Y los números de la tabla, uno por uno, dentro de la pantalla.
      const celdas = await page.evaluate((w) => [...document.querySelectorAll('.fc-control-tabla td')]
        .map(td => { const r = td.getBoundingClientRect(); return { t: td.textContent, izq: r.left, der: r.right, w }; }), width);
      assert(celdas.length === 3, `La tabla no tiene las tres celdas: ${JSON.stringify(celdas)}`);
      for (const c of celdas) {
        assert(c.izq >= -1 && c.der <= width + 1, `La celda "${c.t}" queda fuera en ${width}`);
      }
      assert(celdas.map(c => c.t.trim()).join('|') === '378|0|1', `Cantidades mal: ${JSON.stringify(celdas.map(c => c.t))}`);

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
  /**
   * 🔴 Los caminos que las pruebas anteriores NO cubrían: una respuesta que llega DESPUÉS de que
   * cambió el contexto. Que el resultado viejo aparezca sobre otro conjunto de datos es peor que
   * no tener ninguno.
   */
  async function conRespuestaLenta(width = 1440) {
    const { page, ctx } = await setup(width);
    let soltar = () => {};
    const puerta = new Promise(r => { soltar = r; });
    await page.route('**/api/facturacion?**', r => reply(r, {
      pendientes: [], facturados: [FILA({ control_fa_re: CONTROL('no_verificado') })],
      totales: { pendientes: 0, facturados: 1 },
    }));
    await page.route('**/api/facturacion/comparar/**', async r => {
      await puerta;
      await reply(r, { ok: true, im_comprobante_id: '101', checked_at: '2026-09-11T15:00:00.000Z', control: CONTROL('coinciden') }).catch(() => {});
    });
    await page.locator('.of-tabs').getByRole('button', { name: 'Facturación', exact: true }).click();
    await page.locator('.fc-facturados summary').click();
    await page.getByRole('button', { name: /Sin dato|Comparar/ }).first().click();
    await page.getByRole('button', { name: /Comparando/ }).waitFor();
    return { page, ctx, soltar };
  }

  await test('Una respuesta que llega tras RECARGAR no se muestra', async () => {
    const { page, ctx, soltar } = await conRespuestaLenta();
    try {
      await page.getByRole('button', { name: 'Actualizar' }).click();
      soltar();
      await page.waitForTimeout(400);
      assert(await page.locator('.fc-control').count() === 0, 'Mostró un resultado de antes de recargar');
      assert(await page.getByRole('button', { name: /Comparando/ }).count() === 0, 'Quedó clavado en "Comparando…"');
    } finally { soltar(); await ctx.close(); }
  });

  await test('Ni una que llega tras CAMBIAR EL RANGO', async () => {
    const { page, ctx, soltar } = await conRespuestaLenta();
    try {
      await page.locator('.of-rango input').nth(0).fill('2026-09-01');
      soltar();
      await page.waitForTimeout(400);
      assert(await page.locator('.fc-control').count() === 0, 'Mostró un resultado del rango anterior');
    } finally { soltar(); await ctx.close(); }
  });

  /** 🔴 El estado es local y no se entera de que cambió la sesión: se compara al recibir. */
  for (const [caso, cambiar] of [
    ['con otro token', () => localStorage.setItem('auth_token', 'otra-sesion-distinta')],
    // 🪤 Sólo el email: un token del mismo largo y final no alcanza para distinguir sesiones.
    ['sólo con otro usuario', () => {
      const u = JSON.parse(localStorage.getItem('auth_user') || '{}');
      localStorage.setItem('auth_user', JSON.stringify({ ...u, email: 'otro@example.invalid' }));
    }],
  ]) await test(`Ni una que llega tras entrar ${caso}`, async () => {
    const { page, ctx, soltar } = await conRespuestaLenta();
    try {
      await page.evaluate(cambiar);
      soltar();
      await page.waitForTimeout(400);
      const panel = await page.locator('.fc-control').count();
      assert(panel === 0 || !(await page.locator('.fc-control').innerText()).includes('Coinciden'),
        'Mostró el resultado de la sesión anterior');
    } finally { soltar(); await ctx.close(); }
  });

  /**
   * 🔴 El panel va después de la tabla: con muchas filas, tocar el botón de la primera dejaba el
   * resultado fuera de la pantalla.
   */
  await test('Con muchas facturas, el detalle pedido queda a la vista', async () => {
    const { page, ctx } = await setup(390);
    try {
      const muchas = Array.from({ length: 40 }, (_, i) => FILA({
        im_comprobante_id: String(200 + i), cod_cliente: 200 + i,
        cliente_nombre: `CLIENTE ${i}`, im_numero: 5000 + i,
        control_fa_re: i === 0 ? CONTROL('diferencias') : CONTROL('coinciden'),
      }));
      await page.route('**/api/facturacion?**', r => reply(r, { pendientes: [], facturados: muchas, totales: { pendientes: 0, facturados: 40, con_diferencias: 1 } }));
      await page.locator('.of-tabs').getByRole('button', { name: 'Facturación', exact: true }).click();
      await page.locator('.fc-facturados summary').click();
      await page.getByRole('button', { name: /Difieren/ }).first().click();
      await page.locator('.fc-control').waitFor();
      await page.waitForTimeout(600);   // el scroll es suave
      const v = await page.evaluate(() => {
        const r = document.querySelector('.fc-control').getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, alto: window.innerHeight };
      });
      assert(v.bottom > 0 && v.top < v.alto, `El detalle quedó fuera de la pantalla (top ${v.top}, alto ${v.alto})`);
      await page.screenshot({ path: `${out}/control-fa-re-muchas-390.png` });
    } finally { await ctx.close(); }
  });

  await test('Salir de Facturación con una consulta en vuelo no rompe nada', async () => {
    const { page, ctx, soltar } = await conRespuestaLenta();
    try {
      await page.locator('.of-tabs').getByRole('button', { name: 'Presupuestos', exact: true }).click();
      soltar();
      await page.waitForTimeout(400);
      assert(await page.locator('.fc-control').count() === 0, 'Dejó el panel de otra pantalla');
    } finally { soltar(); await ctx.close(); }
  });

} finally {
  await browser.close();
  await fs.writeFile(`${out}/resultados-control-fa-re.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
}
if (results.cases.some(c => !c.passed) || results.consoleErrors.length) process.exitCode = 1;
