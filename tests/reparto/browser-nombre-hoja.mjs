import fs from 'node:fs/promises';
import {browser,results,out,rows,reply,setup,assert,test} from './browser-fixtures.mjs';

/**
 * El rótulo de la hoja y el lugar para escribir en el papel.
 *
 * Mati (14/09/2026): *"necesitamos que se le pueda poner nombre a la hoja además del número...
 * para poder escribirle la zona"* y *"dejar un poco más de espacio en la parte de cobrado para
 * que puedan escribir más los repartidores"*.
 */
const hoja = (over = {}) => ({
  version: 2, id: 'h1', numero: 3405, fecha: '2026-09-10', turno: 'Mañana', camion: 'Camión 5000',
  camion_id: 'c1', capacidad_kg: 5000, chofer: 'Chofer auditoría', chofer_id: 'ch1', estado: 'abierta',
  facturada: true, nombre: null, totales: { pedidos: 2, bultos: 20, kg: 600 },
  carga: { porcentaje: 12, excedido: false, sobra_kg: 4400 },
  pedidos: rows.map(x => ({ ...x, saldo_anterior: 25000, im_remito_numero: 5000, im_factura_numero: 4000, facturado_at: '2026-09-10' })),
  ...over,
});

const pantalla = (width = 1440, { h = hoja(), capacidades = { nombre: true }, alEditar } = {}) => setup(width, {
  url: '/reparto?etapa=hojas&desde=2026-09-10&hasta=2026-09-10&hoja=h1', ready: '.hr-hoja',
  beforeGoto: async p => {
    await p.route('**/api/hojas-ruta?**', r => reply(r, { hojas: [h], capacidades }));
    if (alEditar) await p.route('**/api/hojas-ruta/h1', alEditar);
  },
});

try {
  await test('🔑 El rótulo se guarda al salir del campo, UNA vez', async () => {
    let envios = [];
    const { page, ctx } = await pantalla(1440, {
      alEditar: r => { envios.push(r.request().postDataJSON()); return reply(r, { ok: true, hoja: {} }); },
    });
    try {
      const campo = page.locator('.hr-hoja-nombre');
      await campo.waitFor();
      await campo.fill('Lules y Famaillá');
      // 🪤 Tipear no puede disparar un POST por tecla: cada uno lleva la versión de la hoja y se
      // pisarían entre sí.
      assert(envios.length === 0, `Guardó mientras se escribía: ${envios.length} envíos`);
      await campo.blur();
      await page.waitForFunction(() => true);
      assert(envios.length === 1, `Esperaba un envío y hubo ${envios.length}`);
      assert(envios[0].nombre === 'Lules y Famaillá', `Mandó otra cosa: ${JSON.stringify(envios[0])}`);
    } finally { await ctx.close(); }
  });

  await test('Si no cambió nada, no escribe', async () => {
    let envios = 0;
    const { page, ctx } = await pantalla(1440, {
      h: hoja({ nombre: 'Banda' }),
      alEditar: r => { envios++; return reply(r, { ok: true, hoja: {} }); },
    });
    try {
      const campo = page.locator('.hr-hoja-nombre');
      await campo.waitFor();
      assert(await campo.inputValue() === 'Banda', 'No muestra el rótulo guardado');
      await campo.click();
      await campo.blur();
      assert(envios === 0, `Escribió sin que cambiara nada: ${envios}`);
    } finally { await ctx.close(); }
  });

  /**
   * 🔴 Lo que se escribió a mano no se pierde por un rechazo. Si el campo volviera al valor
   * viejo, habría que tipearlo de nuevo para enterarse de qué pasó.
   */
  await test('🔴 Si el guardado falla, lo escrito queda en pantalla', async () => {
    const { page, ctx } = await pantalla(1440, {
      alEditar: r => reply(r, { error: 'La hoja cambió. Actualizá antes de continuar' }, 409),
    });
    try {
      const campo = page.locator('.hr-hoja-nombre');
      await campo.waitFor();
      await campo.fill('Lules y Famaillá');
      await campo.blur();
      await page.getByText(/La hoja cambió/).first().waitFor();
      assert(await campo.inputValue() === 'Lules y Famaillá',
        `Se perdió lo escrito: "${await campo.inputValue()}"`);
    } finally { await ctx.close(); }
  });

  await test('🔴 Sin la migración aplicada, el campo ni se ofrece', async () => {
    // Guardarlo daría un error de columna inexistente: mejor no mostrarlo.
    const { page, ctx } = await pantalla(1440, { capacidades: { nombre: false } });
    try {
      await page.locator('.hr-hoja').waitFor();
      assert(await page.locator('.hr-hoja-nombre').count() === 0, 'Ofrece un campo que la base no puede guardar');
    } finally { await ctx.close(); }
  });

  await test('Plegada, el rótulo es lo que identifica la hoja', async () => {
    const { page, ctx } = await pantalla(1440, { h: hoja({ nombre: 'Banda del Río Salí' }) });
    try {
      // 🔑 Desde el 22/09/2026 ya arranca plegada (Mati: "hojas plegadas por defecto"), así que
      // no hay que plegarla: se comprueba que efectivamente arrancó así.
      assert(await page.locator('.hr-plegar').first().getAttribute('title') === 'Desplegar',
        'La hoja no arrancó plegada');
      const resumen = page.locator('.hr-plegada-resumen').first();
      await resumen.waitFor();
      assert((await resumen.innerText()).includes('Banda del Río Salí'), `El resumen no lo muestra: "${await resumen.innerText()}"`);
    } finally { await ctx.close(); }
  });

  /**
   * 🔴 EL PAPEL. Se mide con los estilos de impresión aplicados y el viewport en el ancho útil de
   * una A4 (210mm − 15mm de márgenes): que el texto esté en el DOM no dice nada de cuánto espacio
   * queda para escribir a mano.
   */
  await test('🔴 La hoja impresa lleva el rótulo y deja lugar para escribir en Cobrado', async () => {
    const h = hoja({ nombre: 'Lules y Famaillá' });
    const { page, ctx } = await pantalla(1440, { h });
    try {
      // 🪤 Nombres CORTOS a propósito: uno largo se parte en dos líneas y agranda la fila solo,
      // así que el test pasaría aunque no hubiera ninguna regla de alto. Lo que se mide es el
      // mínimo garantizado, no el rebote de un nombre que no entra.
      const clientes = Array.from({ length: 6 }, (_, i) => ({
        cod_empresa: 1, cod_cliente: i + 1, cliente_nombre: ['LOPEZ', 'DIAZ', 'SOSA', 'RUIZ', 'MOYA', 'BAEZ'][i],
        saldo_anterior: 25000, total: 150000, bultos: 10, kg: 300,
        comprobantes: [{ im_numero: 5000 + i, bultos: 10, kg: 300, total: 150000, facturado: true }],
      }));
      await page.route('**/api/hojas-ruta/h1/impresion', r => reply(r, {
        hoja: h, clientes, totales: { clientes: 6, comprobantes: 6, bultos: 60, kg: 1800, total: 900000 },
        fraccionado: [], fraccionado_completo: true, dias_faltantes: [], fraccionado_totales: { productos: 0, paquetes: 0, kg: 0 }, sin_saldo: 0,
      }));
      await page.getByTitle('Imprimir la hoja y el listado de fraccionado', { exact: true }).click();
      await page.locator('.imp-grupo').nth(5).waitFor();

      const cabecera = await page.locator('.imp-doc').innerText();
      // El CSS lo pone en mayúsculas, así que se compara sin distinguir.
      assert(/lules y famaillá/i.test(cabecera), `La hoja impresa no lleva el rótulo: "${cabecera}"`);

      /**
       * 🪤 Se mide con los estilos de IMPRESIÓN, que es lo único que decide el papel. El
       * `min-width` de pantalla no se comprueba acá a propósito: con la tabla al 100% del ancho
       * esa columna ya lo supera sola, así que un assert sobre eso pasaría siempre — y un test
       * que no puede fallar es peor que no tenerlo.
       */
      await page.emulateMedia({ media: 'print' });
      await page.setViewportSize({ width: 737, height: 1000 });   // 195mm útiles de una A4
      const m = await page.evaluate(() => {
        const mm = 96 / 25.4;
        const celda = document.querySelector('.imp-tabla tbody .escribir').getBoundingClientRect();
        const tabla = document.querySelector('.imp-tabla').getBoundingClientRect();
        const cab = [...document.querySelectorAll('.imp-tabla thead th')].map(t => t.textContent.trim());
        const cliente = document.querySelector('.imp-tabla tbody td').getBoundingClientRect();
        return { anchoMm: celda.width / mm, altoMm: celda.height / mm, clienteMm: cliente.width / mm,
                 tabla: tabla.right, vw: innerWidth, cab };
      });
      assert(m.cab[5] === 'Cobrado', `La columna medida no es Cobrado: ${JSON.stringify(m.cab)}`);
      // Medido en esta misma fixture: antes 23,8mm × 8,2mm; ahora 30,4mm × 9,0mm.
      assert(m.anchoMm >= 30, `Cobrado quedó angosta: ${m.anchoMm.toFixed(1)}mm`);
      assert(m.altoMm >= 8.8, `La fila quedó baja para escribir a mano: ${m.altoMm.toFixed(1)}mm`);
      // 🪤 Y el nombre del cliente no puede quedar aplastado a cambio.
      assert(m.clienteMm >= 38, `El nombre del cliente quedó sin lugar: ${m.clienteMm.toFixed(1)}mm`);
      // 🪤 Ni la tabla puede terminar fuera del papel.
      assert(m.tabla <= m.vw + 1, `La tabla se sale de la página: ${m.tabla} > ${m.vw}`);
      await page.screenshot({ path: out + '/hoja-impresa-cobrado.png', fullPage: true });
    } finally { await ctx.close(); }
  });
  /**
   * 🔴 EN EL CELULAR. Un campo nuevo en una cabecera ya apretada es exactamente lo que empujó
   * "Guardar cambios" fuera de su modal el 09/09/2026. Se miden rectángulos, no presencia en el DOM.
   */
  for (const width of [390, 1440]) {
    await test(`El campo entra en la cabecera de la hoja (${width})`, async () => {
      const { page, ctx } = await pantalla(width, { h: hoja({ nombre: 'Banda del Río Salí y Cruz Alta' }) });
      try {
        const campo = page.locator('.hr-hoja-nombre');
        await campo.waitFor();
        const m = await page.evaluate(() => {
          const c = document.querySelector('.hr-hoja-nombre').getBoundingClientRect();
          const hoja = document.querySelector('.hr-hoja').getBoundingClientRect();
          return { c: { l: c.left, r: c.right, w: c.width, h: c.height }, hoja: { l: hoja.left, r: hoja.right }, vw: innerWidth };
        });
        assert(m.c.w > 60 && m.c.h > 18, `El campo quedó sin área usable: ${JSON.stringify(m.c)}`);
        assert(m.c.l >= m.hoja.l - 1 && m.c.r <= m.hoja.r + 1, `Se sale de la tarjeta (${width}): ${JSON.stringify(m)}`);
        assert(m.c.l >= 0 && m.c.r <= m.vw, `Se sale de la pantalla (${width}): ${JSON.stringify(m)}`);
        // 🪤 Y no puede empujar a los demás controles fuera de la tarjeta.
        const fuera = await page.evaluate(() => {
          const hoja = document.querySelector('.hr-hoja').getBoundingClientRect();
          return [...document.querySelectorAll('.hr-hoja-head > *')]
            .map(e => ({ t: (e.textContent || e.getAttribute('aria-label') || e.tagName).slice(0, 24), r: e.getBoundingClientRect().right }))
            .filter(x => x.r > hoja.right + 1);
        });
        assert(!fuera.length, `Quedaron controles fuera de la tarjeta (${width}): ${JSON.stringify(fuera)}`);
        await page.screenshot({ path: `${out}/nombre-hoja-${width}.png`, fullPage: true });
      } finally { await ctx.close(); }
    });
  }

  /**
   * 🔴 SALDO QUE NO SE PUDO TRAER. 24/09/2026, BUSTOS Sebastián en la hoja 3430: la celda salió
   * con "—" y el aviso sólo se veía en pantalla, así que en el papel parecía que no debía nada.
   * Tenía $1.368.965 de deuda. El repartidor tiene que leer en el papel que el dato falta.
   */
  await test('🔴 Un saldo que no se pudo traer se nota en el papel, no parece deuda cero', async () => {
    const h = hoja({});
    const { page, ctx } = await pantalla(1440, { h });
    try {
      const cli = (i, saldo) => ({ cod_empresa: 1, cod_cliente: i, cliente_nombre: ['BUSTOS', 'LOPEZ'][i - 1], saldo_anterior: saldo, total: 1000, bultos: 1, kg: 10,
        comprobantes: [{ im_numero: 5000 + i, bultos: 1, kg: 10, total: 1000, facturado: true }] });
      await page.route('**/api/hojas-ruta/h1/impresion', r => reply(r, {
        hoja: h, clientes: [cli(1, null), cli(2, 0)], totales: { clientes: 2, comprobantes: 2, bultos: 2, kg: 20, total: 2000 },
        fraccionado: [], fraccionado_completo: true, dias_faltantes: [], fraccionado_totales: { productos: 0, paquetes: 0, kg: 0 }, sin_saldo: 1,
      }));
      await page.getByTitle('Imprimir la hoja y el listado de fraccionado', { exact: true }).click();
      await page.locator('.imp-grupo').nth(1).waitFor();
      await page.emulateMedia({ media: 'print' });
      const saldos = await page.locator('.imp-tabla tbody .saldo').allInnerTexts();
      assert(/sin dato/i.test(saldos[0]), `El saldo que falta no lo dice: "${saldos[0]}"`);
      assert(!/sin dato/i.test(saldos[1]), `Un saldo en cero aparece como faltante: "${saldos[1]}"`);
      const aviso = page.getByText(/no se pudo traer el saldo/i);
      assert(await aviso.isVisible(), 'El aviso de saldo faltante no sale en el papel');
      assert(/no quiere decir que no deba/i.test(await aviso.innerText()), `El aviso no aclara que puede deber: "${await aviso.innerText()}"`);
    } finally { await ctx.close(); }
  });

  /** 🪤 60 caracteres es el tope: tiene que entrar en la cabecera impresa, no partirla. */
  await test('🔴 El rótulo más largo posible no rompe la cabecera impresa', async () => {
    const largo = 'BANDA DEL RIO SALI, CRUZ ALTA, LULES Y FAMAILLA — RECORRIDO';
    const h = hoja({ nombre: largo });
    const { page, ctx } = await pantalla(1440, { h });
    try {
      await page.route('**/api/hojas-ruta/h1/impresion', r => reply(r, {
        hoja: h, clientes: [{ cod_empresa: 1, cod_cliente: 1, cliente_nombre: 'LOPEZ', saldo_anterior: 0, total: 1000, bultos: 1, kg: 10,
          comprobantes: [{ im_numero: 5000, bultos: 1, kg: 10, total: 1000, facturado: true }] }],
        totales: { clientes: 1, comprobantes: 1, bultos: 1, kg: 10, total: 1000 },
        fraccionado: [], fraccionado_completo: true, dias_faltantes: [], fraccionado_totales: { productos: 0, paquetes: 0, kg: 0 }, sin_saldo: 0,
      }));
      await page.getByTitle('Imprimir la hoja y el listado de fraccionado', { exact: true }).click();
      await page.locator('.imp-doc').waitFor();
      await page.emulateMedia({ media: 'print' });
      await page.setViewportSize({ width: 737, height: 1000 });
      const m = await page.evaluate(() => {
        const cab = document.querySelector('.imp-head').getBoundingClientRect();
        const doc = document.querySelector('.imp-doc').getBoundingClientRect();
        const nro = document.querySelector('.imp-head-nro').getBoundingClientRect();
        return { doc: { l: doc.left, r: doc.right }, nro: { l: nro.left, r: nro.right }, cab: { r: cab.right }, vw: innerWidth };
      });
      assert(m.doc.r <= m.vw + 1, `El rótulo se sale de la página: ${JSON.stringify(m)}`);
      // El número de hoja no puede quedar tapado por el rótulo.
      assert(m.doc.r <= m.nro.l + 1, `El rótulo pisa el número de hoja: ${JSON.stringify(m)}`);
    } finally { await ctx.close(); }
  });
} finally {
  await browser.close();
  await fs.writeFile(out + '/browser-nombre-hoja.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  if (results.cases.some(c => !c.passed) || results.consoleErrors.length) process.exit(1);
}
