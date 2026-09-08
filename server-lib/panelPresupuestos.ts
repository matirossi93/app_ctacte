/**
 * ETAPA 1 DEL CIRCUITO: la revisión de los presupuestos.
 *
 * Mati (08/09/2026), corrigiendo el orden del panel: *"debería haber una sección de
 * presupuestos donde Jorgelina haría el primer filtrado, viendo todas las diferencias en las
 * listas, o stock y demás... y una vez que los presupuestos ya están ok, recién ahí entra la
 * parte de facturación y de ahí, con la factura y el remito hecho, se arma la hoja de ruta (es
 * el último paso)"*.
 *
 * Lo que se hace acá:
 *  · ver los presupuestos de un RANGO de días (Jorgelina trabaja franjas, no un día suelto),
 *  · con los avisos del control de listas ya calculados,
 *  · corregir cantidades sin salir del panel (*"así no tiene que ir y venir de InfoManager"*),
 *  · marcar cada uno como **aprobado** u **observado**,
 *  · y sacar el listado de FRACCIONADO de lo aprobado, que se prepara antes de armar la hoja.
 */
import type { Request, Response } from 'express';
import { sb, TENANT_ID } from './supabase.js';
import type { JwtPayload } from './auth.js';
import { puedeArmarHojasDeRuta } from './permisos.js';
import {
  fechaArgentina, fetchArticulosCatalogo, fetchVentasItems, getItemsComprobante,
  cabeceraComprobante, actualizarPresupuestoCantidades, fetchStockPorDeposito,
} from './infomanager.js';
import { vistaDeRango, invalidarVista } from './vistaPresupuestos.js';
import { armarFraccionado, totalesFraccionado } from './fraccionado.js';

/** Sólo la oficina (admin, gerente y administrativo). Devuelve true si ya contestó el 403. */
function frenaSiNoPuede(req: Request & { user?: JwtPayload }, res: Response): boolean {
  if (!puedeArmarHojasDeRuta(String(req.user?.rol ?? ''))) {
    res.status(403).json({ error: 'Los presupuestos los revisa administración.' });
    return true;
  }
  return false;
}

/**
 * Cuántos días para atrás se aceptan en el rango.
 *
 * 🪤 No es un capricho: `/ventas/items` de 15 días son 57.385 renglones y 23,7 s (medido el
 * 07/09/2026), y con eso la pantalla no abre. El rango largo se paga en segundos.
 */
const MAX_RANGO_DIAS = 31;

/** `?desde=&hasta=`, con hoy como default y el rango acotado. */
function rangoPedido(req: Request): { desde: string; hasta: string } {
  const hoy = fechaArgentina();
  const ok = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : null;
  const hasta = ok(req.query.hasta) ?? hoy;
  let desde = ok(req.query.desde) ?? hasta;
  if (desde > hasta) desde = hasta;                       // rango dado vuelta: se ignora
  const tope = fechaArgentina(new Date(hasta + 'T12:00:00Z').getTime() - MAX_RANGO_DIAS * 864e5);
  if (desde < tope) desde = tope;
  return { desde, hasta };
}

/**
 * GET /api/presupuestos?desde=&hasta=&refrescar=1 — lo que hay para revisar.
 *
 * Devuelve TODOS los presupuestos vigentes del rango (los de la app y los cargados directo en
 * IM), cada uno con su cliente, zona, kilos, importe, los avisos de lista y en qué quedó la
 * revisión.
 */
export async function listarPresupuestos(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  try {
    const { desde, hasta } = rangoPedido(req);
    const vista = await vistaDeRango(desde, hasta, req.query.refrescar === '1');
    // Para revisar hacen falta los dos: los que todavía están sueltos y los que ya están en
    // una hoja (esos también se revisaron alguna vez y pueden tener un aviso).
    const todos = [...vista.pendientes, ...vista.asignados];
    res.json({
      ok: true, desde, hasta,
      presupuestos: todos,
      totales: {
        comprobantes: todos.length,
        clientes: new Set(todos.map((p: any) => p.cod_cliente)).size,
        importe: Math.round(todos.reduce((s: number, p: any) => s + Number(p.total ?? 0), 0) * 100) / 100,
        kg: Math.round(todos.reduce((s: number, p: any) => s + Number(p.kg ?? 0), 0) * 100) / 100,
      },
      sin_revisar: vista.sin_revisar,
      aprobados: vista.aprobados,
      observados: vista.observados,
      pierde_margen: vista.pierde_margen,
      cobra_de_mas: vista.cobra_de_mas,
      sin_stock: vista.sin_stock,
      con_cantidad_rara: vista.con_cantidad_rara,
    });
  } catch (err: any) {
    console.error('[listarPresupuestos]', err?.message);
    res.status(502).json({ error: `No se pudieron traer los presupuestos: ${err?.message ?? 'sin respuesta de IM'}` });
  }
}

/**
 * POST /api/presupuestos/:comprobanteId/revision — aprobar u observar.
 *
 * `aprobado` es lo que habilita la etapa 2: sin esto, facturar sería facturar cualquier cosa.
 * `observado` deja el motivo escrito (falta stock, hay que llamar al cliente) para que no se
 * revise dos veces y para que se vea qué está frenado.
 */
export async function revisarPresupuesto(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  try {
    const estado = String(req.body?.estado ?? '').trim();
    if (!['aprobado', 'observado'].includes(estado)) {
      res.status(400).json({ error: 'El estado tiene que ser "aprobado" u "observado".' }); return;
    }
    const observacion = req.body?.observacion ? String(req.body.observacion).slice(0, 500) : null;
    if (estado === 'observado' && !observacion) {
      // Un "observado" sin motivo no le sirve a nadie: al día siguiente nadie se acuerda por qué.
      res.status(400).json({ error: 'Escribí por qué queda observado.' }); return;
    }
    const fila = {
      tenant_id: TENANT_ID,
      im_comprobante_id: String(req.params.comprobanteId),
      im_numero: req.body?.im_numero != null ? Number(req.body.im_numero) : null,
      cod_cliente: req.body?.cod_cliente != null ? Number(req.body.cod_cliente) : null,
      estado, observacion,
      revisado_por: req.user?.sub ?? null,
      revisado_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const { error } = await sb().from('presupuestos_revision')
      .upsert(fila, { onConflict: 'im_comprobante_id' });
    if (error) { res.status(500).json({ error: error.message }); return; }
    invalidarVista();
    res.json({ ok: true, revision: fila });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/** DELETE /api/presupuestos/:comprobanteId/revision — vuelve a "sin revisar". */
export async function borrarRevision(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  const { error } = await sb().from('presupuestos_revision')
    .delete().eq('im_comprobante_id', String(req.params.comprobanteId)).eq('tenant_id', TENANT_ID);
  if (error) { res.status(500).json({ error: error.message }); return; }
  invalidarVista();
  res.json({ ok: true });
}

/**
 * GET /api/presupuestos/:comprobanteId — el detalle, renglón por renglón.
 *
 * Es lo que Jorgelina mira para decidir: qué producto, cuánto, a qué precio y con qué lista.
 *
 * 🔑 El `id` de cada renglón viene de IM y es el que hace falta para corregir la cantidad
 * (`PUT /presupuestos/{id}` sólo acepta renglones que ya existen).
 */
export async function detallePresupuesto(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  try {
    const id = String(req.params.comprobanteId);
    const [cab, items, cat, stock] = await Promise.all([
      cabeceraComprobante(id),
      getItemsComprobante(id),
      fetchArticulosCatalogo(),
      // 🪤 `null` = no se pudo consultar, que no es "no hay stock". La pantalla no marca nada.
      fetchStockPorDeposito(Number(process.env.PEDIDO_DEPOSITO || 1)).catch(() => null),
    ]);
    if (cab.existe === false) { res.status(404).json({ error: 'El presupuesto ya no está en InfoManager.' }); return; }

    // El precio sale de `/ventas/items` del día del comprobante: es el mismo camino que usa la
    // facturación, así que muestra exactamente lo que se va a facturar.
    const precios = new Map<number, { precio: number; iva_por: number }>();
    if (cab.fecha) {
      for (const it of await fetchVentasItems(cab.fecha, cab.fecha).catch(() => [] as any[])) {
        if (String((it as any).id_comprobante) !== id) continue;
        precios.set(Number((it as any).cod_articulo), {
          precio: Number((it as any).precio ?? 0), iva_por: Number((it as any).iva_por ?? 0),
        });
      }
    }

    res.json({
      ok: true,
      comprobante: { im_comprobante_id: id, fecha: cab.fecha, anulada: cab.anulada },
      stock_consultado: !!stock,
      items: items.map(it => {
        const art = cat.get(Number(it.cod_articulo));
        const p = precios.get(Number(it.cod_articulo));
        return {
          id: it.id,
          cod_articulo: it.cod_articulo,
          descripcion: art?.descripcion ?? `Artículo ${it.cod_articulo}`,
          unidad_de_medida: art?.unidad_de_medida ?? null,
          // Kilos por bulto: es lo que dice si "30" son 30 kilos o 30 bolsas.
          equivalencia_um: art?.equivalencia_um ?? null,
          cantidad: it.cantidad,
          cod_lista_precios: it.cod_lista_precios,
          precio: p?.precio ?? null,
          importe: p ? Math.round(p.precio * it.cantidad * 100) / 100 : null,
          // Cuánto hay en el depósito, en la misma unidad que la cantidad. Puede ser negativo:
          // hay diferencias de inventario y el número sirve para avisar, no para bloquear.
          stock: stock ? (stock.get(Number(it.cod_articulo)) ?? null) : null,
        };
      }),
    });
  } catch (err: any) {
    console.error('[detallePresupuesto]', err?.message);
    res.status(502).json({ error: `No pude traer el detalle: ${err?.message ?? 'sin respuesta de IM'}` });
  }
}

/**
 * PUT /api/presupuestos/:comprobanteId/cantidades — corrige cantidades sin salir del panel.
 *
 * Mati: *"estaría bueno que pueda hacer las correcciones directamente del panel así no tiene
 * que ir y venir de InfoManager"*.
 *
 * ⚠️ LÍMITE DE LA API DE IM, no nuestro: `PUT /presupuestos/{id}` **sólo acepta cambiar la
 * cantidad de renglones que ya existen**. Para agregar o sacar un producto, o cambiar la lista
 * de precios, hay que anular y crear de nuevo el comprobante — que es lo que hace el editor de
 * pedidos de la app. Acá se avisa en vez de fingir que se puede.
 */
export async function corregirCantidades(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  try {
    const id = String(req.params.comprobanteId);
    const entrada: any[] = Array.isArray(req.body?.items) ? req.body.items : [];
    const items = entrada
      .map(i => ({ id: Number(i.id), cantidad: Number(i.cantidad) }))
      .filter(i => Number.isFinite(i.id) && Number.isFinite(i.cantidad) && i.cantidad > 0);
    if (!items.length) {
      res.status(400).json({ error: 'Mandá al menos un renglón con id y cantidad mayor a cero.' }); return;
    }

    // 🪤 Un presupuesto ya facturado no se toca: la factura quedaría diciendo otra cosa.
    const { data: enHoja } = await sb().from('hojas_ruta_pedidos')
      .select('im_factura_numero, facturado_at').eq('im_comprobante_id', id).maybeSingle();
    if (enHoja?.facturado_at || enHoja?.im_factura_numero) {
      res.status(409).json({
        error: `Este presupuesto ya se facturó (factura ${enHoja.im_factura_numero ?? '—'}). Para cambiarlo hay que hacer una nota de crédito en InfoManager.`,
      });
      return;
    }

    const r = await actualizarPresupuestoCantidades(id, items);
    if (!r.ok) { res.status(502).json({ error: `InfoManager rechazó el cambio: ${r.error}` }); return; }
    invalidarVista();
    res.json({ ok: true, actualizados: items.length });
  } catch (err: any) {
    console.error('[corregirCantidades]', err?.message);
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/**
 * GET /api/presupuestos/fraccionado?desde=&hasta=&todos=1 — qué hay que fraccionar.
 *
 * Sale de los presupuestos **aprobados** del rango: es lo que se prepara antes de armar la
 * hoja. Con `todos=1` se ve sobre todos los presupuestos, aprobados o no, para adelantar
 * trabajo cuando la revisión todavía no terminó.
 */
export async function fraccionadoDelRango(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  try {
    const { desde, hasta } = rangoPedido(req);
    const soloAprobados = req.query.todos !== '1';
    const vista = await vistaDeRango(desde, hasta);
    const elegidos = [...vista.pendientes, ...vista.asignados]
      .filter((p: any) => !soloAprobados || p.revision?.estado === 'aprobado');
    const ids = new Set(elegidos.map((p: any) => String(p.im_comprobante_id)));

    if (!ids.size) {
      res.json({ ok: true, desde, hasta, solo_aprobados: soloAprobados, comprobantes: 0, fraccionado: [], totales: { productos: 0, paquetes: 0, kg: 0 } });
      return;
    }

    // Los renglones, por los días que de verdad tienen pedidos elegidos.
    const cat = await fetchArticulosCatalogo();
    const dias = [...new Set(elegidos.map((p: any) => String(p.fecha ?? hasta).slice(0, 10)))].sort();
    const renglones: Array<{ cod_articulo: number; cantidad: number }> = [];
    for (let i = 0; i < dias.length; i += 4) {
      const tandas = await Promise.all(dias.slice(i, i + 4).map(f => fetchVentasItems(f, f).catch(() => [] as any[])));
      for (const items of tandas) {
        for (const it of items) {
          if (!ids.has(String((it as any).id_comprobante))) continue;
          renglones.push({ cod_articulo: Number((it as any).cod_articulo), cantidad: Number((it as any).cantidad) });
        }
      }
    }

    const fraccionado = armarFraccionado(renglones, cat);
    res.json({
      ok: true, desde, hasta,
      solo_aprobados: soloAprobados,
      comprobantes: ids.size,
      fraccionado,
      totales: totalesFraccionado(fraccionado),
    });
  } catch (err: any) {
    console.error('[fraccionadoDelRango]', err?.message);
    res.status(502).json({ error: `No pude armar el listado de fraccionado: ${err?.message ?? 'sin respuesta de IM'}` });
  }
}
