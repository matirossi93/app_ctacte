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
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { sb, TENANT_ID } from './supabase.js';
import type { JwtPayload } from './auth.js';
import { puedeArmarHojasDeRuta } from './permisos.js';
import {
  cabeceraComprobante, getItemsComprobante, actualizarPresupuestoCantidades,
  crearPresupuesto, anularComprobante, fetchArticulosCatalogo, fechaArgentina,
  fetchClientesIMCached, actualizarCabecera,
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

/** El artículo del catálogo con el que se carga el costo de distribución (Mati, 09/09/2026). */
export const COD_COSTO_DISTRIBUCION = Number(process.env.IM_ART_COSTO_DISTRIBUCION || 13819);

export interface RenglonEditado {
  cod_articulo: number;
  cantidad: number;
  cod_lista_precios: number;
  descuento_porc: number;
  /** El precio BRUTO de lista. IM le aplica el descuento encima. */
  precio?: number;
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

/**
 * 🔴 ÚNICO POR INTENTO. IM lo rechaza repetido, incluso contra comprobantes anulados.
 *
 * 🪤 Iba `EDIT-<timestamp>-<random>` y **`crearPresupuesto` lo trunca a 8 caracteres**, así que
 * de todo eso sobrevivía `EDIT-` + 3 dígitos del reloj: el mismo código para TODAS las ediciones
 * de una ventana de ~17 horas. La primera creaba el presupuesto y las siguientes chocaban contra
 * ella —IM devolvía el que ya existía— y el panel se quedaba sin guardar nada. Pasó en vivo el
 * 09/09/2026: todas las ediciones de la tarde compartieron `EDIT-MTU`.
 *
 * Los 8 caracteres de un UUID son 4.300 millones de combinaciones y es lo que ya usa
 * `crearPedido` desde agosto. Si aun así colisionara, `crearPresupuesto` lo detecta y lo dice.
 */
const codCompatibilidad = () => randomUUID().slice(0, 8);

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
      }))
      /**
       * 🔴 Todos con artículo del catálogo. La API de IM NO tiene renglones libres: `cod_articulo`
       * es int64 obligatorio, y con `""` o `0` rechaza el presupuesto entero (probado el
       * 09/09/2026 — era por esto que no guardaba). El costo de distribución va con su artículo,
       * el 13819, y el precio a mano: es un importe que escribe la oficina, no sale de una lista.
       */
      .filter(i => i.cod_articulo > 0 && i.cantidad > 0);
    if (!items.length) {
      res.status(400).json({ error: 'El presupuesto tiene que quedar con al menos un producto. Si hay que darlo de baja, anulalo en InfoManager.' });
      return;
    }
    if (items.some(i => !i.cod_lista_precios)) {
      res.status(400).json({ error: 'Hay un renglón sin lista de precios válida.' });
      return;
    }
    /**
     * 🪤 Sin `precio` IM guarda el renglón en $0 — no lo busca en la lista (probado el
     * 09/09/2026). El editor manda siempre el precio; si falta, se frena antes de recrear.
     */
    const sinPrecio = items.find(i => !(Number(i.precio) > 0));
    if (sinPrecio) {
      res.status(400).json({ error: `El renglón del artículo ${sinPrecio.cod_articulo} no tiene precio. Ponelo antes de guardar: InfoManager lo grabaría en $0.` });
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
     * 🪤 Si el presupuesto trae renglones SIN artículo (notas que escribe la oficina desde el
     * sistema de IM, con `cod_articulo: ""`), recrearlo los perdería: la API no los puede volver
     * a escribir. Se deja corregir cantidades —que no los toca— y se frena lo demás, en vez de
     * borrarle una nota sin avisar.
     */
    const notasIM = imItems.filter(i => !(i.cod_articulo > 0));
    const mismoSurtido = firmaDelSurtido(items) === firmaDelSurtido(imItems.filter(i => i.cod_articulo > 0));
    /**
     * 🔑 Las observaciones son el campo que la oficina lee justo antes de facturar ("facturar a
     * nombre de la SRL", "entregar el jueves"). Mati (09/09/2026) pidió poder escribirlas desde
     * el panel. `undefined` = la pantalla no las mandó: no se tocan.
     */
    const obsNueva = req.body?.observaciones != null ? String(req.body.observaciones).trim().slice(0, 500) : undefined;
    const cambiaObs = obsNueva != null && obsNueva !== (cab.observaciones ?? '');
    /**
     * 🔑 La FECHA del presupuesto es la que decide en qué día de reparto entra el pedido. Mati
     * (09/09/2026): *"necesitamos poder editar la fecha del presupuesto apenas llegan al panel
     * así lo redireccionamos a otra fecha"*. Se valida el formato: una fecha inventada mueve el
     * pedido a un día que no existe y desaparece de la pantalla.
     */
    const fechaPedida = String(req.body?.fecha ?? '').trim();
    if (fechaPedida && !/^\d{4}-\d{2}-\d{2}$/.test(fechaPedida)) {
      res.status(400).json({ error: 'La fecha del presupuesto tiene que ser una fecha válida.' });
      return;
    }
    const fechaNueva = fechaPedida || undefined;
    const cambiaFecha = fechaNueva != null && fechaNueva !== (cab.fecha ?? '');
    if (!mismoSurtido && notasIM.length) {
      res.status(409).json({
        error: `Este presupuesto tiene ${notasIM.length} renglón(es) sin código escritos en InfoManager (${notasIM.map(n => `"${n.detalle ?? 'sin texto'}"`).join(', ')}). Rehacerlo los borraría, y la API de InfoManager no los puede volver a cargar. Cambiá sólo cantidades acá, o hacé el cambio en InfoManager.`,
      });
      return;
    }

    // ── Camino barato: sólo cambiaron cantidades ──────────────────────────────
    if (mismoSurtido) {
      const payload = emparejarParaPut(items, imItems as any);
      if (!payload) {
        res.status(409).json({ error: 'Los renglones no coinciden con los de InfoManager. Actualizá la pantalla y probá de nuevo.' });
        return;
      }
      const r = await actualizarPresupuestoCantidades(id, payload);
      if (!r.ok) { res.status(502).json({ error: `InfoManager rechazó el cambio: ${r.error}` }); return; }
      /**
       * La fecha y las observaciones van por otro PUT: el de presupuestos no las tiene en el
       * schema (las ignora en silencio). Se hace DESPUÉS de las cantidades y no frena: si falla,
       * el cambio de cantidades ya está hecho y lo que corresponde es avisarlo, no fingir que no
       * pasó. Las dos viajan juntas porque es el mismo PUT: mandar una sola pisaría la otra.
       */
      let avisoCab: string | null = null;
      if ((cambiaObs || cambiaFecha) && cab.numero != null && cab.punto_de_venta != null) {
        const o = await actualizarCabecera({
          id, numero: cab.numero, punto_de_venta: cab.punto_de_venta,
          fecha: fechaNueva ?? cab.fecha ?? fechaArgentina(),
          observaciones: obsNueva ?? cab.observaciones ?? '',
        });
        if (!o.ok) avisoCab = `Se guardaron las cantidades, pero NO ${cambiaFecha ? 'la fecha' : 'las observaciones'}: ${o.error}`;
      }
      await limpiarRevision(id);
      invalidarVista(); invalidarRemitos();
      res.json({
        ok: true, modo: 'cantidades', im_comprobante_id: id, im_numero: cab.numero,
        fecha: fechaNueva ?? cab.fecha ?? null, aviso: avisoCab,
      });
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
      observaciones: obsNueva ?? cab.observaciones ?? '',
      // La fecha manda en qué día de reparto entra: la nueva si la mandaron, si no la del original.
      fecha: fechaNueva ?? cab.fecha ?? fechaArgentina(),
      fecha_entrega: fechaNueva ?? cab.fecha_entrega ?? cab.fecha ?? fechaArgentina(),
      cod_compatibilidad: codCompatibilidad(),
      items: items.map(i => ({
        cod_articulo: i.cod_articulo,
        cantidad: i.cantidad,
        cod_lista_precios: i.cod_lista_precios,
        descuento_porc: i.descuento_porc,
        precio: i.precio,
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

/**
 * GET /api/comprobantes/:id/imprimir — todo lo que hace falta para imprimir un comprobante.
 *
 * Mati (09/09/2026): *"tenemos que tener algún botón para poder imprimir el presupuesto y
 * también la factura"*. Sirve para los dos: la cabecera y los renglones salen del mismo lugar,
 * y lo único que cambia es qué dice el papel.
 */
export async function comprobanteParaImprimir(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  try {
    const id = String(req.params.id);
    const [cab, items, cat, clientes] = await Promise.all([
      cabeceraComprobante(id),
      getItemsComprobante(id),
      fetchArticulosCatalogo(),
      fetchClientesIMCached().catch(() => [] as any[]),
    ]);
    if (cab.existe === false) { res.status(404).json({ error: 'Ese comprobante ya no está en InfoManager.' }); return; }
    if (cab.existe !== true) { res.status(502).json({ error: 'No pude leer el comprobante en InfoManager.' }); return; }

    const cliente = (clientes as any[]).find(c => Number(c.cod_cliente) === Number(cab.cod_cliente));
    /**
     * 🔑 La dirección y el teléfono van EN EL PAPEL. Mati (09/09/2026): *"tiene que decir la
     * dirección y teléfono del cliente"* — el que reparte necesita saber a dónde va y a quién
     * llamar si no encuentra el domicilio, y hoy eso lo tiene que buscar aparte.
     */
    const domicilio = [cliente?.domicilio, cliente?.localidad]
      .map((x: any) => String(x ?? '').trim()).filter(Boolean).join(' · ') || null;
    const telefono = [cliente?.telefono, cliente?.whatsapp, cliente?.telefonos]
      .map((t: any) => String(t ?? '').trim()).find(Boolean) || null;
    res.json({
      ok: true,
      comprobante: {
        id, numero: cab.numero, fecha: cab.fecha, observaciones: cab.observaciones,
        anulada: cab.anulada, cod_cliente: cab.cod_cliente,
        cliente: cliente?.razon_social ?? cliente?.nombre ?? `Cliente ${cab.cod_cliente ?? ''}`,
        domicilio, telefono,
      },
      items: (items as any[]).map(it => {
        const art = cat.get(Number(it.cod_articulo));
        const cant = Number(it.cantidad) || 0;
        // 🪤 `precio` viene NETO (con el descuento adentro) y `precio_orig` bruto. El papel
        // muestra el bruto y el descuento aparte, que es como lo lee el cliente.
        const desc = Number(it.descuento_porc) || 0;
        const bruto = Number(it.precio_orig ?? it.precio ?? 0) || Number(it.precio ?? 0);
        const neto = Number(it.precio ?? 0);
        return {
          cod_articulo: Number(it.cod_articulo) || 0,
          // Un renglón libre no está en el catálogo: su texto es lo único que lo describe.
          descripcion: art?.descripcion ?? (it.detalle ? String(it.detalle) : `Artículo ${it.cod_articulo}`),
          cantidad: cant,
          precio_unit: desc > 0 ? bruto : neto,
          descuento_porc: desc || null,
          subtotal: Math.round(cant * neto * 100) / 100,
        };
      }),
    });
  } catch (err: any) {
    console.error('[comprobanteParaImprimir]', err?.message);
    res.status(502).json({ error: `No pude traer el comprobante: ${err?.message ?? 'sin respuesta de IM'}` });
  }
}
