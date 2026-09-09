/**
 * EDITAR UN PRESUPUESTO SIN SALIR DEL PANEL.
 *
 * Mati (09/09/2026): *"Jorgelina muchas veces tiene que editar los presupuestos... si no ella
 * tiene que estar cambiando de ventana a InfoManager y volver, es un chino. Incorporá la parte
 * de edición: el cambio de lista, la manera de agregar productos, de sacar"*. Y lo que destraba
 * el problema: *"por más que se anule y se haga un nuevo presupuesto, no importa"*.
 *
 * 🔴 POR QUÉ HAY QUE RECREAR. `PUT /presupuestos/{id}` **sólo aplica `cantidad`** (probado contra
 * IM el 04/09/2026 sobre presupuestos reales). Agregar un renglón devuelve 200 y no hace nada;
 * cambiar `precio`, `cod_lista_precios` o `descuento_porc` se ignora en silencio. No hay endpoint
 * de alta ni de baja de renglones: se probaron 13 rutas. Se le pidió a Sistec el 07/09/2026 y no
 * hubo respuesta.
 *
 * 🪤 Y `cantidad: 0` **no es salida**: Mati lo rechazó el 07/09/2026 —*"no es viable que se vea
 * cantidad 0, horrible"*— porque el renglón queda a la vista en el comprobante impreso.
 *
 * Entonces hay dos caminos, y se elige solo:
 *  · **Barato** — cambian sólo cantidades: `PUT` y el número de presupuesto se conserva.
 *  · **Recrear** — cambia el surtido, una lista o un descuento: se CREA el nuevo y recién
 *    después se anula el viejo. En ese orden, nunca al revés: si se anula primero y la creación
 *    falla, el pedido queda sin ningún presupuesto vivo y no hay qué facturar.
 *
 * Es el mismo circuito que ya usa `editarPedido` para los pedidos de la app; la diferencia es que
 * acá funciona sobre CUALQUIER presupuesto de InfoManager, que es el 76% de los que llegan.
 */
import type { Request, Response } from 'express';
import { sb, TENANT_ID } from './supabase.js';
import type { JwtPayload } from './auth.js';
import { puedeArmarHojasDeRuta } from './permisos.js';
import {
  cabeceraComprobante, getItemsComprobante, actualizarPresupuestoCantidades,
  crearPresupuesto, anularComprobante, fetchArticulosCatalogo, fechaArgentina,
} from './infomanager.js';
import { invalidarVista } from './vistaPresupuestos.js';
import { invalidarRemitos } from './vistaRemitos.js';

function frenaSiNoPuede(req: Request & { user?: JwtPayload }, res: Response): boolean {
  if (!puedeArmarHojasDeRuta(String(req.user?.rol ?? ''))) {
    res.status(403).json({ error: 'Los presupuestos los edita administración.' });
    return true;
  }
  return false;
}

/** Las listas mayoristas que la oficina puede elegir. 12 = Lista 1 … 15 = Lista 4. */
const LISTAS_VALIDAS = new Set([12, 13, 14, 15]);

export interface RenglonEditado {
  /** `0` = renglón libre, sin artículo del catálogo (el costo de distribución). */
  cod_articulo: number;
  cantidad: number;
  cod_lista_precios: number;
  descuento_porc: number;
  /** El precio BRUTO de lista. IM le aplica el descuento encima. */
  precio?: number;
  /** Obligatorio en los renglones libres: es lo único que los describe. */
  detalle?: string;
}

/**
 * La "firma" del surtido: qué artículo, en qué lista y con qué descuento, EN ORDEN.
 *
 * Si dos firmas coinciden, lo único que cambió son cantidades y alcanza con el PUT. El descuento
 * y la lista están adentro a propósito: IM los ignora en el PUT, así que si cambiaran sin que la
 * firma se entere, el panel diría "guardado" y a InfoManager no habría llegado nada.
 */
export function firmaDelSurtido(rs: Array<{ cod_articulo: any; cod_lista_precios: any; descuento_porc?: any }>): string {
  return rs.map(r =>
    `${Number(r.cod_articulo)}:${Number(r.cod_lista_precios)}:${Number(r.descuento_porc) || 0}`).join('|');
}

/**
 * Empareja los renglones nuevos con los de IM para el PUT, consumiendo una cola por artículo.
 * Devuelve `null` si alguno se queda sin pareja: ahí hay que recrear, no adivinar.
 */
export function emparejarParaPut(
  nuevos: Array<{ cod_articulo: number; cantidad: number }>,
  imItems: Array<{ id: number | string; cod_articulo: number | string }>,
): Array<{ id: number; cantidad: number }> | null {
  const cola = new Map<number, number[]>();
  for (const it of imItems) {
    const k = Number(it.cod_articulo);
    if (!cola.has(k)) cola.set(k, []);
    cola.get(k)!.push(Number(it.id));
  }
  const payload: Array<{ id: number; cantidad: number }> = [];
  for (const n of nuevos) {
    const id = cola.get(Number(n.cod_articulo))?.shift();
    if (id == null) return null;
    payload.push({ id, cantidad: Number(n.cantidad) });
  }
  return payload;
}

/** Único por intento: IM rechaza un código ya usado, incluso si ese comprobante está anulado. */
const codCompatibilidad = () => `EDIT-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`.toUpperCase();

/**
 * PUT /api/presupuestos/:comprobanteId/editar — guarda el presupuesto editado.
 *
 * Body: `{ items: [{ cod_articulo, cantidad, cod_lista_precios, descuento_porc, precio }],
 * observaciones? }`.
 */
export async function editarPresupuesto(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  const id = String(req.params.comprobanteId);
  try {
    const entrada: any[] = Array.isArray(req.body?.items) ? req.body.items : [];
    const items: RenglonEditado[] = entrada
      .map(i => ({
        cod_articulo: Number(i.cod_articulo),
        cantidad: Number(i.cantidad),
        cod_lista_precios: LISTAS_VALIDAS.has(Number(i.cod_lista_precios)) ? Number(i.cod_lista_precios) : 0,
        descuento_porc: Math.min(Math.max(Number(i.descuento_porc) || 0, 0), 100),
        precio: i.precio != null ? Number(i.precio) : undefined,
        detalle: i.detalle ? String(i.detalle).trim().slice(0, 200) : undefined,
      }))
      /**
       * 🔑 Entra el renglón con artículo del catálogo Y el renglón LIBRE (`cod_articulo: 0` con
       * detalle): así carga la oficina el costo de distribución, que no es un producto (Mati,
       * 09/09/2026). Sin artículo el precio es obligatorio — no hay lista de dónde sacarlo.
       */
      .filter(i => i.cantidad > 0 && (i.cod_articulo > 0 || (!!i.detalle && Number.isFinite(i.precio))));
    if (!items.length) {
      res.status(400).json({ error: 'El presupuesto tiene que quedar con al menos un producto. Si hay que darlo de baja, anulalo en InfoManager.' });
      return;
    }
    if (items.some(i => !i.cod_lista_precios)) {
      res.status(400).json({ error: 'Hay un renglón sin lista de precios válida.' });
      return;
    }

    /**
     * 🔴 Un presupuesto ya facturado no se toca: la factura quedaría diciendo otra cosa. Se mira
     * `presupuestos_facturados`, que es donde vive ese vínculo — IM no lo expone.
     */
    const { data: emitido, error: errEmitido } = await sb().from('presupuestos_facturados')
      .select('im_factura_numero, facturado_at').eq('tenant_id', TENANT_ID)
      .eq('im_comprobante_id', id).maybeSingle();
    if (errEmitido) { res.status(502).json({ error: `No pude verificar si ya se facturó (${errEmitido.message}).` }); return; }
    if (emitido?.facturado_at || emitido?.im_factura_numero) {
      res.status(409).json({ error: `Este presupuesto ya se facturó (factura ${emitido.im_factura_numero ?? '—'}). Para cambiarlo hay que hacer una nota de crédito en InfoManager.` });
      return;
    }

    const cab = await cabeceraComprobante(id);
    if (cab.existe === false) { res.status(404).json({ error: 'El presupuesto ya no está en InfoManager.' }); return; }
    // "No pude preguntar" no habilita a escribir: se cae del lado seguro.
    if (cab.existe !== true) { res.status(502).json({ error: 'No pude leer el presupuesto en InfoManager. Probá de nuevo en un rato.' }); return; }
    if (cab.anulada === true) { res.status(409).json({ error: 'El presupuesto está ANULADO en InfoManager.' }); return; }

    const imItems = await getItemsComprobante(id);
    /**
     * 🪤 Con renglones LIBRES (`cod_articulo: 0`) el camino barato no sirve: `emparejarParaPut`
     * empareja por artículo y todos los libres comparten el código 0, así que dos de ellos se
     * confundirían entre sí. Con uno solo en juego se recrea, que siempre es correcto.
     */
    const hayLibres = items.some(i => !(i.cod_articulo > 0)) || (imItems as any[]).some(i => !(Number(i.cod_articulo) > 0));
    const mismoSurtido = !hayLibres && firmaDelSurtido(items) === firmaDelSurtido(imItems as any);

    // ── Camino barato: sólo cambiaron cantidades ──────────────────────────────
    if (mismoSurtido) {
      const payload = emparejarParaPut(items, imItems as any);
      if (!payload) {
        res.status(409).json({ error: 'Los renglones no coinciden con los de InfoManager. Actualizá la pantalla y probá de nuevo.' });
        return;
      }
      const r = await actualizarPresupuestoCantidades(id, payload);
      if (!r.ok) { res.status(502).json({ error: `InfoManager rechazó el cambio: ${r.error}` }); return; }
      await limpiarRevision(id);
      invalidarVista(); invalidarRemitos();
      res.json({ ok: true, modo: 'cantidades', im_comprobante_id: id, im_numero: cab.numero });
      return;
    }

    // ── Recrear: cambió el surtido, una lista o un descuento ──────────────────
    if (cab.cod_cliente == null || cab.cod_empresa == null) {
      res.status(502).json({ error: 'No pude leer el cliente o la empresa del presupuesto en InfoManager. No cambié nada.' });
      return;
    }

    /**
     * 🔑 PRIMERO SE CREA EL NUEVO, RECIÉN DESPUÉS SE ANULA EL VIEJO.
     *
     * Al revés, una creación fallida deja al cliente sin NINGÚN presupuesto vivo: se perdió el
     * pedido y en InfoManager no queda nada para facturar. De los dos pasos, el que no se puede
     * deshacer es la anulación.
     */
    const creado = await crearPresupuesto({
      cod_empresa: cab.cod_empresa,
      cod_cliente: cab.cod_cliente,
      cod_vendedor: cab.cod_vendedor ?? 0,
      cod_lista_precios: cab.cod_lista_precios ?? items[0].cod_lista_precios,
      usuario: cab.usuario || String(req.body?.usuario_im ?? 'jorgelina'),
      punto_de_venta: cab.punto_de_venta ?? 1,
      observaciones: req.body?.observaciones != null ? String(req.body.observaciones) : (cab.observaciones ?? ''),
      // La fecha manda en qué día de reparto entra: se conserva la del original.
      fecha: cab.fecha ?? fechaArgentina(),
      fecha_entrega: cab.fecha_entrega ?? cab.fecha ?? fechaArgentina(),
      cod_compatibilidad: codCompatibilidad(),
      items: items.map(i => ({
        cod_articulo: i.cod_articulo,
        cantidad: i.cantidad,
        cod_lista_precios: i.cod_lista_precios,
        descuento_porc: i.descuento_porc,
        ...(i.precio != null ? { precio: i.precio } : {}),
        ...(i.detalle ? { detalle: i.detalle } : {}),
      })),
    });
    if (!creado.ok) {
      res.status(502).json({
        error: `InfoManager no aceptó el presupuesto nuevo: ${creado.error}. No se anuló el original, así que el pedido sigue como estaba.`,
      });
      return;
    }

    // Ahora sí: el viejo se anula. Si esto falla quedan DOS vivos y hay que decirlo fuerte.
    let avisoAnular: string | null = null;
    if (cab.numero != null && cab.punto_de_venta != null && cab.fecha) {
      const anulado = await anularComprobante({
        id, numero: cab.numero, punto_de_venta: cab.punto_de_venta, fecha: cab.fecha,
        observaciones: `Reemplazado por el presupuesto ${creado.numero ?? creado.id} (editado desde el panel)`,
      });
      if (!anulado.ok) {
        avisoAnular = `🔴 Se creó el presupuesto ${creado.numero ?? ''} pero NO se pudo anular el ${cab.numero}: ${anulado.error}. Quedaron los dos vivos — anulá el viejo en InfoManager para no facturarlo dos veces.`;
      }
    } else {
      avisoAnular = `🔴 Se creó el presupuesto ${creado.numero ?? ''} pero no pude anular el original (faltan sus datos en InfoManager). Anulalo a mano para no facturarlo dos veces.`;
    }

    /**
     * La revisión viaja al comprobante nuevo: si el presupuesto estaba aprobado y sólo se le
     * corrigió una lista, no tiene sentido volver a revisarlo desde cero. Pero se deja el rastro
     * de que cambió.
     */
    await moverRevision(id, String(creado.id), creado.numero ?? null, cab.cod_cliente);

    invalidarVista(); invalidarRemitos();
    res.json({
      ok: true, modo: 'recreado',
      im_comprobante_id: String(creado.id), im_numero: creado.numero,
      anterior: { im_comprobante_id: id, im_numero: cab.numero },
      aviso: avisoAnular,
    });
  } catch (err: any) {
    console.error('[editarPresupuesto]', err?.message);
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/** Cambió el pedido: la aprobación era sobre otra cosa. */
async function limpiarRevision(comprobanteId: string) {
  const { error } = await sb().from('presupuestos_revision')
    .delete().eq('tenant_id', TENANT_ID).eq('im_comprobante_id', comprobanteId);
  if (error) console.warn('[editarPresupuesto] no pude limpiar la revisión:', error.message);
}

/**
 * Al recrear, la revisión del viejo se borra y el nuevo nace SIN revisar: cambió el surtido o un
 * precio, así que alguien lo tiene que volver a mirar antes de facturarlo.
 */
async function moverRevision(viejo: string, _nuevo: string, _numero: number | null, _codCliente: number) {
  await limpiarRevision(viejo);
}

/**
 * GET /api/articulos/buscar?q= — para agregar productos al presupuesto.
 *
 * Sale del catálogo cacheado (1 h), así que no le pega a InfoManager por cada tecla.
 */
export async function buscarArticulos(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  try {
    const q = String(req.query.q ?? '').trim().toLowerCase();
    if (q.length < 2) { res.json({ ok: true, articulos: [] }); return; }
    const cat = await fetchArticulosCatalogo();
    const salida: any[] = [];
    for (const [cod, art] of cat) {
      const desc = String((art as any).descripcion ?? '');
      // Se busca por descripción o por código: la oficina se sabe algunos de memoria.
      if (!desc.toLowerCase().includes(q) && String(cod) !== q) continue;
      salida.push({
        cod_articulo: cod,
        descripcion: desc,
        unidad_de_medida: (art as any).unidad_de_medida ?? null,
        equivalencia_um: (art as any).equivalencia_um ?? null,
        precio_venta: (art as any).precio_venta ?? null,
      });
      if (salida.length >= 30) break;      // la lista es para elegir, no para navegar
    }
    res.json({ ok: true, articulos: salida });
  } catch (err: any) {
    res.status(502).json({ error: `No pude traer el catálogo: ${err?.message ?? 'sin respuesta de IM'}` });
  }
}
