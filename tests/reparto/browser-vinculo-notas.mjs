import fs from 'node:fs/promises';
import {browser,results,out,rows,reply,setup,assert,test} from './browser-fixtures.mjs';

/**
 * Registrar en la hoja una nota NC/ND que ya existe en InfoManager.
 *
 * 🔴 De este número sale un PAGO. Lo que se prueba es que la pantalla no prometa lo que no hace,
 * que muestre TODAS las notas que mueven el total —no sólo las que ató esta pantalla— y que al
 * confirmar mande lo que el operador tenía a la vista, para que el server pueda cortar si cambió.
 */
const hoja = {
  version: 2, id: 'h1', numero: 3405, fecha: '2026-09-10', turno: 'Mañana', camion: 'Camión 5000',
  camion_id: 'c1', capacidad_kg: 5000, chofer: 'Chofer auditoría', chofer_id: 'ch1', estado: 'abierta',
  facturada: true, totales: { pedidos: 2, bultos: 20, kg: 600 },
  carga: { porcentaje: 12, excedido: false, sobra_kg: 4400 },
  pedidos: rows.map(x => ({ ...x, im_remito_numero: 5000, im_factura_numero: 4000, facturado_at: '2026-09-10' })),
};
const entregas = rows.map(r => ({
  im_comprobante_id: r.im_comprobante_id, im_numero: Number(r.im_comprobante_id), cliente_nombre: r.cliente_nombre,
  cod_cliente: r.cod_cliente, total: r.total, im_factura_id: '5879659' + r.im_comprobante_id, im_factura_numero: 50456,
}));
const AJUSTES = {
  despachado: 300000, notas_credito: 30000, notas_debito: 0, final: 270000, pendientes_de_emitir: 0,
  hoja: { version: 2, id: 'h1', numero: 3405, fecha: '2026-09-10', estado: 'abierta' },
  ajustes: [],
  entregas,
  notas: [{
    im_ajuste_id: '58802044', tipo: 'NC B', numero: 30079, importe: 30000, signo: -1,
    origen: 'correccion', ajuste_id: null, motivo: null, im_comprobante_id: null,
  }],
};
const CANDIDATA = {
  im_ajuste_id: '58824236', numero: 30081, tipo: 'ND B', signo: 1, fecha: '2026-09-11',
  // 🔴 Con centavos a propósito: redondeando se confirma un importe que no se vio.
  cod_cliente: 101, importe: 12500.51, observaciones: 'DIF LISTAS SEGUN HR 3405', menciona_esta_hoja: true,
};

async function abrirModal(page, { ajustes = AJUSTES, candidatas = [CANDIDATA], alVincular } = {}) {
  await page.route('**/api/hojas-ruta/h1/ajustes', r => reply(r, { ok: true, ...ajustes }));
  await page.route('**/api/hojas-ruta/h1/ajustes/candidatas**', r => reply(r, { ok: true, candidatas }));
  if (alVincular) await page.route('**/api/hojas-ruta/h1/ajustes/vincular', alVincular);
  await page.locator('.hr-hoja-pie .hr-btn.ghost').first().click();
  await page.locator('.aj-modal').waitFor();
}
// 🪤 `hoja=h1` en la URL: en 390 las columnas quedan una abajo de la otra y la hoja arranca
// oculta hasta que se la abre. Sin esto el test de móvil no llega ni a ver el botón.
const pantalla = (width = 1440) => setup(width, {
  url: '/reparto?etapa=hojas&desde=2026-09-10&hasta=2026-09-10&hoja=h1', ready: '.hr-hoja',
  beforeGoto: p => p.route('**/api/hojas-ruta?**', r => reply(r, { hojas: [hoja] })),
});

try {
  await test('El botón dice qué hace y el total no afirma una entrega física', async () => {
    const { page, ctx } = await pantalla();
    try {
      const boton = page.locator('.hr-hoja-pie .hr-btn.ghost').first();
      assert(/vincular nc\/nd/i.test(await boton.innerText()), `El botón no nombra las notas: "${await boton.innerText()}"`);
      await abrirModal(page);
      const totales = await page.locator('.aj-totales').innerText();
      // 🪤 "Entregado" afirma que la mercadería llegó; una nota es un ajuste de la CUENTA.
      assert(!/entregado/i.test(totales), `El total sigue afirmando una entrega: "${totales}"`);
      assert(/base de liquidación/i.test(totales), `No dice para qué sirve el número: "${totales}"`);
    } finally { await ctx.close(); }
  });

  await test('🔴 Una nota emitida por corrección de factura se ve, y no se ofrece soltarla', async () => {
    const { page, ctx } = await pantalla();
    try {
      await abrirModal(page);
      const fila = page.locator('.aj-seccion').first().locator('.aj-fila').first();
      await fila.waitFor();
      const texto = await fila.innerText();
      assert(texto.includes('30079'), `No se lee la nota del journal: "${texto}"`);
      assert(/desde corrección de factura/i.test(texto), `No dice de dónde vino: "${texto}"`);
      // Borrar acá no la sacaría de ningún lado: no hay vínculo propio que soltar.
      assert(await fila.locator('button').count() === 0, 'Ofrece soltar una nota que no ató esta pantalla');
    } finally { await ctx.close(); }
  });

  await test('🔴 Al confirmar manda la factura y el detalle que estaban a la vista', async () => {
    const { page, ctx } = await pantalla();
    let enviado = null;
    try {
      await abrirModal(page, {
        alVincular: r => { enviado = JSON.parse(r.request().postData() ?? '{}'); return reply(r, { ok: true, ajuste: { importe: 12500, numero: 30081, tipo: 'ND B', signo: 1 } }); },
      });
      await page.locator('.aj-seccion').last().getByRole('button', { name: 'Buscar' }).click();
      const candidata = page.locator('.aj-fila.candidata').first();
      await candidata.waitFor();
      const texto = await candidata.innerText();
      // Una ND SUMA: si se mostrara restando, el operador confirmaría lo contrario de lo que pasa.
      assert(/\+\s*\$/.test(texto), `Una ND no se muestra sumando: "${texto}"`);
      assert(/factura 50456/i.test(texto), `No dice sobre qué factura se registra: "${texto}"`);

      await candidata.getByRole('button', { name: 'Vincular' }).click();
      await page.waitForFunction(() => !document.querySelector('.aj-fila.candidata'));
      assert(enviado?.im_factura_id === '5879659101', `No mandó la factura vista: ${JSON.stringify(enviado)}`);
      assert(enviado?.esperado?.tipo === 'ND B', `El tipo esperado va sin letra: ${JSON.stringify(enviado?.esperado)}`);
      assert(enviado?.esperado?.numero === 30081 && enviado?.esperado?.importe === 12500.51,
        `No mandó el detalle que se vio: ${JSON.stringify(enviado?.esperado)}`);
    } finally { await ctx.close(); }
  });

  await test('🔴 Si la nota cambió desde que se mostró, la lista vieja se descarta', async () => {
    const { page, ctx } = await pantalla();
    try {
      await abrirModal(page, {
        alVincular: r => reply(r, { error: 'Esa nota cambió desde que la viste: ahora dice 99999. Recargá la lista y confirmá de nuevo.', recargar: true }, 409),
      });
      await page.locator('.aj-seccion').last().getByRole('button', { name: 'Buscar' }).click();
      await page.locator('.aj-fila.candidata').first().click({ position: { x: 5, y: 5 } });
      await page.locator('.aj-fila.candidata').first().getByRole('button', { name: 'Vincular' }).click();
      const error = await page.getByText(/cambió desde que la viste/i).first().innerText();
      assert(/ahora dice 99999/.test(error), `No explica qué cambió: "${error}"`);
      // 🔴 La lista mostraba el dato viejo: dejarla invita a confirmar lo mismo otra vez.
      assert(await page.locator('.aj-fila.candidata').count() === 0, 'Dejó la lista vieja después del rechazo');
    } finally { await ctx.close(); }
  });

  await test('La pantalla no promete devolución ni reingreso de stock', async () => {
    const { page, ctx } = await pantalla();
    try {
      await abrirModal(page);
      const texto = await page.locator('.aj-modal').innerText();
      for (const palabra of [/reingres/i, /devolución de mercader/i, /vuelve el stock/i, /relaciona.*informanager/i]) {
        assert(!palabra.test(texto), `Promete algo que no hace (${palabra}): "${texto}"`);
      }
      assert(/registra la nota en esta hoja/i.test(texto), `No dice qué hace realmente: "${texto}"`);
      await page.screenshot({ path: out + '/vinculo-notas.png', fullPage: true });
    } finally { await ctx.close(); }
  });
  /**
   * 🔴 EN EL CELULAR, que es donde se usa.
   *
   * 🪤 Que el texto esté en el DOM no prueba nada: el 09/09/2026 un `margin-left:auto` con
   * `nowrap` empujó "Guardar cambios" fuera del modal y los tests daban verde porque medían
   * `scrollWidth > clientWidth` con el botón DESPLAZADO, no recortado. Acá se miden rectángulos
   * contra el modal y contra el viewport.
   */
  for (const width of [390, 1440]) {
    await test(`La candidata se lee y se puede tocar entera (${width})`, async () => {
      const { page, ctx } = await pantalla(width);
      try {
        await abrirModal(page);
        await page.locator('.aj-seccion').last().getByRole('button', { name: 'Buscar' }).click();
        const candidata = page.locator('.aj-fila.candidata').first();
        await candidata.waitFor();

        const texto = await candidata.innerText();
        // Los centavos: es el importe que se confirma, no una lista que se mira de reojo.
        assert(/12\.500,51/.test(texto), `Redondea el importe que se va a confirmar: "${texto}"`);
        assert(/50456/.test(texto), `No dice sobre qué factura se registra (${width}): "${texto}"`);
        assert(/CLIENTE ALFA/.test(texto), `No dice de qué cliente es esa factura (${width}): "${texto}"`);

        const medidas = await page.evaluate(() => {
          const modal = document.querySelector('.aj-modal').getBoundingClientRect();
          const btn = [...document.querySelectorAll('.aj-fila.candidata button')].find(b => /vincular/i.test(b.textContent)).getBoundingClientRect();
          const total = document.querySelector('.aj-totales .final b').getBoundingClientRect();
          return { modal: { l: modal.left, r: modal.right }, btn: { l: btn.left, r: btn.right, w: btn.width, h: btn.height },
                   total: { l: total.left, r: total.right }, vw: innerWidth };
        });
        assert(medidas.btn.w > 40 && medidas.btn.h > 20, `El botón quedó sin área tocable: ${JSON.stringify(medidas.btn)}`);
        assert(medidas.btn.l >= medidas.modal.l - 1 && medidas.btn.r <= medidas.modal.r + 1,
          `El botón se sale del modal (${width}): ${JSON.stringify(medidas)}`);
        assert(medidas.btn.l >= 0 && medidas.btn.r <= medidas.vw,
          `El botón se sale de la pantalla (${width}): ${JSON.stringify(medidas)}`);
        assert(medidas.total.l >= 0 && medidas.total.r <= medidas.vw,
          `El total ajustado se sale de la pantalla (${width}): ${JSON.stringify(medidas)}`);
        await page.screenshot({ path: `${out}/vinculo-notas-${width}.png`, fullPage: true });
      } finally { await ctx.close(); }
    });

    await test(`El rechazo por cambio se lee dentro de la pantalla (${width})`, async () => {
      const { page, ctx } = await pantalla(width);
      try {
        await abrirModal(page, {
          alVincular: r => reply(r, { error: 'Esa nota cambió desde que la viste: ahora dice 99999,00. Recargá la lista y confirmá de nuevo.', recargar: true }, 409),
        });
        await page.locator('.aj-seccion').last().getByRole('button', { name: 'Buscar' }).click();
        await page.locator('.aj-fila.candidata').first().getByRole('button', { name: 'Vincular' }).click();
        const error = page.getByText(/cambió desde que la viste/i).first();
        await error.waitFor();
        const m = await error.evaluate(e => {
          const r = e.getBoundingClientRect();
          return { l: r.left, r: r.right, w: r.width, h: r.height, vw: innerWidth };
        });
        assert(m.w > 0 && m.h > 0, `El aviso no ocupa lugar (${width}): ${JSON.stringify(m)}`);
        assert(m.l >= 0 && m.r <= m.vw, `El aviso se sale de la pantalla (${width}): ${JSON.stringify(m)}`);
        assert(await page.locator('.aj-fila.candidata').count() === 0, `Dejó la lista vieja (${width})`);
      } finally { await ctx.close(); }
    });
  }
} finally {
  await browser.close();
  await fs.writeFile(out + '/browser-vinculo-notas.json', JSON.stringify(results, null, 2));
  const fallaron = results.cases.filter(c => !c.passed);
  console.log(JSON.stringify(results, null, 2));
  if (fallaron.length || results.consoleErrors.length) process.exit(1);
}
