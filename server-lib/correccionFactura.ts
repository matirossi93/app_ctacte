/**
 * CORREGIR UNA FACTURA YA EMITIDA, con notas de crédito y de débito.
 *
 * Mati (09/09/2026): *"muchas veces en el reparto llaman los repartidores a facturación porque
 * hay algún problema con la facturación, ya sea que se puso mal una lista o hay un artículo mal
 * cargado... con InfoManager la nota de crédito es muy engorrosa y muchas veces ya está hecho el
 * recibo, entonces tampoco se puede editar. Que sea lo más rápido y ágil y simple posible"*.
 *
 * 🔴 UNA FACTURA EMITIDA NO SE TOCA. Es un comprobante fiscal y la API tampoco lo permite
 * (`VentasActualizar` sólo acepta fecha, observaciones y anulada). Lo que se hace es lo mismo que
 * hace la oficina a mano, pero calculado: la diferencia entre lo que dice la factura y lo que
 * debería decir sale como NC (lo que baja) y ND (lo que sube).
 *
 * 🪤 Las NC y ND van por el PUNTO DE VENTA 999, no por el 777 de las facturas. No es un capricho:
 * IM valida la unicidad del número SIN mirar el tipo de comprobante, y como la serie de facturas
 * B va por 50.422 mientras la de NC B va por 30.073, cada NC choca contra una factura vieja del
 * mismo número. Probado de nuevo el 09/09/2026:
 *
 *   NC B pv777 numero 0      -> ✗ "Ya existe una factura con ... numero = 30073"
 *   NC B pv777 numero 30073  -> ✗ el mismo error
 *   ND B pv777 numero 0      -> ✗ "... numero = 742"
 *   **NC B pv999 destino 3** -> ✅ sale, e IM le asigna el número
 *   **ND B pv999 destino 3** -> ✅ sale, e IM le asigna el número
 *
 * ⚠️ Usar otro punto de venta es una DECISIÓN DE NEGOCIO, no técnica: es otra serie ante AFIP.
 * Se planteó como tal y Mati la tomó el 09/09/2026 (*"usemos ese punto de venta, no hay
 * problema"*). Queda en variables de entorno para poder volver al 777 sin deploy el día que
 * Sistec arregle la validación.
 */
import type { Request, Response } from 'express';
import type { JwtPayload } from './auth.js';
import { sb, TENANT_ID } from './supabase.js';
import { puedeArmarHojasDeRuta } from './permisos.js';
import {
  fetchVentasItems, fetchClientesIMCon, cabeceraComprobante, fechaArgentina,
} from './infomanager.js';
import { emitirNotaCredito, emitirNotaDebito, letraDeFactura } from './facturarIM.js';
import { usuarioIM } from './pedidos.js';
import { invalidarVista } from './vistaPresupuestos.js';
import { invalidarRemitos } from './vistaRemitos.js';

/** Un renglón, como está en la factura o como tiene que quedar. */
export interface RenglonCorreccion {
  cod_articulo: number;
  cantidad: number;
  /** Precio unitario BRUTO, el mismo criterio que usa la facturación. */
  precio: number;
  /**
   * 🔴 El descuento del renglón, en porcentaje. Lo que la factura realmente cobró es
   * `precio × (1 − descuento_porc/100)`, y ése es el importe que tiene que devolver la NC.
   */
  descuento_porc?: number | null;
  descripcion?: string;
  iva_por?: number | null;
  cod_lista_precios?: number | null;
}

/** Lo que hay que emitir para pasar de la factura a lo que corresponde. */
export interface Correccion {
  nc: RenglonCorreccion[];
  nd: RenglonCorreccion[];
  /** Cuánto baja y cuánto sube, en positivo. */
  total_nc: number;
  total_nd: number;
  /** El neto: negativo = se le devuelve plata al cliente. */
  diferencia: number;
}

const centavos = (n: number) => Math.round(n * 100) / 100;
/** Cuatro decimales: es la precisión con la que IM guarda los precios unitarios. */
const precioIM = (n: number) => Math.round(n * 10000) / 10000;
/**
 * 🔴 LA CANTIDAD TAMBIÉN VA A 4 DECIMALES, no a centavos. IM las usa: 1.094 renglones del 01 al
 * 10/09/2026 llevan más de dos (el granel se vende por kilo). Redondear 0,045 a 0,05 en un
 * artículo de $19.008 son $95 de más en un solo renglón.
 */
const cantidadIM = (n: number) => Math.round(n * 10000) / 10000;
/** Los precios de IM tienen 4 decimales; menos que medio centésimo de unidad es ruido. */
const CERO = 0.00005;
/** El descuento del renglón, saneado: fuera de 0-100 no es un porcentaje. */
const descuentoDe = (r?: RenglonCorreccion | null) =>
  Math.max(0, Math.min(100, Number(r?.descuento_porc ?? 0) || 0));
/** Lo que el renglón cobra de verdad por unidad: el bruto con el descuento adentro. */
const netoUnitario = (precio: number, descuento: number) => precio * (1 - descuento / 100);

/**
 * 🔴 EL MISMO ARTÍCULO EN DOS RENGLONES DE LA MISMA FACTURA — junta los renglones en uno.
 *
 * Medido contra IM el 10/09/2026 sobre las 349 facturas de Casa Central del 01 al 10/09: **17 lo
 * tienen**. Como los renglones se indexaban por `cod_articulo`, el segundo pisaba al primero y la
 * mercadería del primero desaparecía del cálculo — en la FA B 50432 el artículo 468 va en dos
 * renglones (150 + 30 unidades) y anular la factura entera devolvía $92.280,10 en vez de
 * $183.754,97.
 *
 * Las cantidades se suman y el precio sale ponderado por cantidad **sobre el neto**, así el
 * importe del renglón consolidado es exactamente el de los renglones sueltos. Cuando los dos
 * traen el mismo precio y el mismo descuento —15 de esos 17 casos— el ponderado da ese mismo
 * precio y el renglón queda idéntico al original.
 */
export function consolidarRenglones(rs: RenglonCorreccion[]): RenglonCorreccion[] {
  const out = new Map<number, RenglonCorreccion>();
  for (const r of rs) {
    const cod = Number(r.cod_articulo);
    const previo = out.get(cod);
    if (!previo) { out.set(cod, { ...r, cod_articulo: cod, descuento_porc: descuentoDe(r) }); continue; }
    const q0 = Number(previo.cantidad) || 0, q1 = Number(r.cantidad) || 0;
    const q = q0 + q1;
    if (q <= 0) continue;
    const d0 = descuentoDe(previo), d1 = descuentoDe(r);
    const netoMedio = (q0 * netoUnitario(previo.precio, d0) + q1 * netoUnitario(r.precio, d1)) / q;
    // Con el mismo descuento se conserva el porcentaje y el bruto se reconstruye desde el neto;
    // si difieren no hay un porcentaje común y el renglón queda expresado en neto.
    const mismoDescuento = Math.abs(d0 - d1) < 1e-9 && d0 < 100;
    out.set(cod, {
      ...previo,
      cantidad: q,
      descuento_porc: mismoDescuento ? d0 : 0,
      precio: mismoDescuento ? netoMedio / (1 - d0 / 100) : netoMedio,
    });
  }
  return [...out.values()];
}

/**
 * 🪤 Los artículos que están en más de un renglón **a distinto precio o distinto descuento**.
 *
 * Son 2 de esas 349 facturas. Ahí no hay un precio de lista que represente al renglón junto, así
 * que la pantalla no lo puede mostrar sin mentir: se avisa y esa corrección se hace en IM.
 */
export function articulosAmbiguos(rs: RenglonCorreccion[]): number[] {
  const visto = new Map<number, RenglonCorreccion>();
  const malos = new Set<number>();
  for (const r of rs) {
    const cod = Number(r.cod_articulo);
    const p = visto.get(cod);
    if (!p) { visto.set(cod, r); continue; }
    if (Math.abs(Number(p.precio) - Number(r.precio)) > CERO || descuentoDe(p) !== descuentoDe(r)) malos.add(cod);
  }
  return [...malos].sort((a, b) => a - b);
}

/**
 * 🔴 LOS RENGLONES ESCRITOS A MANO QUE LLEVAN PLATA.
 *
 * IM exige `cod_articulo` para crear una nota, así que un renglón de texto libre no puede entrar
 * en la corrección y se filtra. Casi siempre da igual —9 de los 11 renglones sin artículo que
 * emitió Casa Central del 01 al 10/09/2026 son notas "PENDIENTE" a precio 0— pero los otros dos
 * llevaban $351.932,25 y $194.189,50 de mercadería.
 *
 * Sin avisar, "sacar todo" emitiría la nota por el resto y la oficina creería que anuló la
 * factura entera. No se bloquea: se muestra y lo decide una persona.
 */
export function renglonesSinArticuloConImporte(
  rs: RenglonCorreccion[],
): Array<{ descripcion: string; cantidad: number; precio: number; importe: number }> {
  return rs
    .filter(r => !(Number(r.cod_articulo) > 0))
    .map(r => ({
      descripcion: String(r.descripcion ?? 'Renglón sin artículo'),
      cantidad: Number(r.cantidad) || 0,
      precio: Number(r.precio) || 0,
      importe: centavos((Number(r.cantidad) || 0) * netoUnitario(Number(r.precio) || 0, descuentoDe(r))),
    }))
    .filter(r => Math.abs(r.importe) > 0.005);
}

/**
 * QUÉ NOTA DE CRÉDITO Y QUÉ NOTA DE DÉBITO HACEN FALTA.
 *
 * Función pura: es el corazón de la pantalla y se prueba sin tocar InfoManager ni Supabase.
 *
 * La diferencia de cada artículo se parte en DOS pedazos, y la suma de los dos da exactamente la
 * diferencia de importe — no queda un peso sin explicar. Todo se calcula sobre el precio NETO
 * (`n = precio × (1 − descuento/100)`), que es lo que la factura cobró de verdad:
 *
 *   · CANTIDAD: `(cantidad_nueva − cantidad_vieja) × neto_viejo`
 *     Un producto que se saca, o del que se lleva menos, cae acá al precio al que se facturó.
 *   · PRECIO:   `cantidad_nueva × (neto_nuevo − neto_viejo)`
 *     Es lo que pasa cuando se cargó mal la lista: la misma mercadería a otro precio.
 *
 *   (q1−q0)·n0 + q1·(n1−n0) = q1·n1 − q0·n0 ✅
 *
 * 🔴 EL DESCUENTO NO ES UN DETALLE. Mati (10/09/2026): *"al calcular la NC no está tomando el
 * descuento que tiene ese producto, lo hace por el total"*. Medido en IM sobre la FA B 50422
 * (BIANCONI, 10/09/2026): los brutos suman $699.708,64 y la factura dice **$587.301,91**. Sin el
 * descuento, corregirla entera devolvía $112.406,73 de más.
 *
 * 🪤 EL PEDAZO DE CANTIDAD VA SIEMPRE AL PRECIO VIEJO, también cuando la cantidad SUBE. Con el
 * precio nuevo la identidad no cierra: 5×1200 → 9×800 son +1200 de diferencia y por ese camino
 * daba −400, o sea una nota de crédito donde correspondía una de débito.
 *
 * Lo que da negativo va a la NC y lo que da positivo a la ND, siempre con la cantidad y el precio
 * en positivo: un comprobante con cantidades negativas no lo acepta nadie.
 */
export function calcularCorreccion(
  originales: RenglonCorreccion[],
  finales: RenglonCorreccion[],
): Correccion {
  const nc: RenglonCorreccion[] = [];
  const nd: RenglonCorreccion[] = [];

  // 🪤 Por artículo, juntando los renglones repetidos: indexar pisando perdía mercadería.
  const viejos = new Map(consolidarRenglones(originales).map(r => [Number(r.cod_articulo), r]));
  const nuevos = new Map(consolidarRenglones(finales).map(r => [Number(r.cod_articulo), r]));

  /**
   * 🔑 El renglón viaja como lo espera IM y como lo manda la facturación: **precio BRUTO con el
   * `descuento_porc` aparte**. Así la nota se lee igual que la factura que corrige, con el mismo
   * precio de lista y el mismo descuento, y el importe lo calcula InfoManager.
   */
  const agregar = (
    destino: RenglonCorreccion[], base: RenglonCorreccion,
    cantidad: number, precio: number, descuento: number,
  ) => {
    const d = Math.max(0, Math.min(100, Number(descuento) || 0));
    // El corte es sobre la plata real: un precio alto con 100% de descuento no es un renglón.
    if (cantidad <= CERO || Math.abs(netoUnitario(precio, d)) <= CERO) return;
    destino.push({
      cod_articulo: Number(base.cod_articulo),
      cantidad: cantidadIM(cantidad),
      precio: precioIM(precio),
      ...(d ? { descuento_porc: d } : {}),
      descripcion: base.descripcion,
      iva_por: base.iva_por ?? 0,
      cod_lista_precios: base.cod_lista_precios ?? null,
    });
  };

  // El orden es por artículo, para que el comprobante salga siempre igual con los mismos datos.
  const codigos = [...new Set([...viejos.keys(), ...nuevos.keys()])].sort((a, b) => a - b);
  for (const cod of codigos) {
    const v = viejos.get(cod);
    const n = nuevos.get(cod);
    const q0 = Number(v?.cantidad ?? 0), p0 = Number(v?.precio ?? 0), d0 = descuentoDe(v);
    const q1 = Number(n?.cantidad ?? 0);
    // Un artículo que sólo está en la factura conserva su precio y su descuento.
    const p1 = n ? Number(n.precio ?? 0) : p0;
    const d1 = n ? descuentoDe(n) : d0;
    const base = n ?? v!;

    // 1) La cantidad, al precio ORIGINAL: es la mercadería que se saca o se agrega.
    // 🪤 `v ? p0 : p1` y no `n ? p1 : p0`: el precio viejo es el de la factura. Sólo un artículo
    // que NO estaba puede usar el precio nuevo, porque es el único que tiene.
    const dq = q1 - q0;
    if (dq < -CERO) agregar(nc, v!, -dq, p0, d0);
    else if (dq > CERO) agregar(nd, base, dq, v ? p0 : p1, v ? d0 : d1);

    // 2) El precio, sobre la cantidad que QUEDA: es la lista mal cargada.
    // 🪤 Sobre `q1` y no sobre `q0`: si además cambió la cantidad, el pedazo de cantidad ya se
    // contó arriba al precio viejo, y contarlo dos veces duplicaría la diferencia.
    if (q1 > CERO && v) {
      const dn = netoUnitario(p1, d1) - netoUnitario(p0, d0);
      if (Math.abs(dn) > CERO) {
        /**
         * Con el MISMO descuento la diferencia se expresa como bruto + descuento, igual que la
         * factura. Si el descuento también cambió no hay un bruto que dé esa diferencia, así que
         * va el importe neto con el descuento en cero: menos lindo de leer, pero exacto.
         */
        const mismoDescuento = Math.abs(d1 - d0) < 1e-9;
        const precio = mismoDescuento ? Math.abs(p1 - p0) : Math.abs(dn);
        const descuento = mismoDescuento ? d0 : 0;
        if (dn < 0) agregar(nc, v, q1, precio, descuento);
        else agregar(nd, base, q1, precio, descuento);
      }
    }
  }

  const suma = (rs: RenglonCorreccion[]) => centavos(
    rs.reduce((s, r) => s + r.cantidad * netoUnitario(r.precio, descuentoDe(r)), 0));
  const total_nc = suma(nc);
  const total_nd = suma(nd);
  return { nc, nd, total_nc, total_nd, diferencia: centavos(total_nd - total_nc) };
}

function frenaSiNoPuede(req: Request & { user?: JwtPayload }, res: Response): boolean {
  if (!puedeArmarHojasDeRuta(String(req.user?.rol ?? ''))) {
    res.status(403).json({ error: 'Corregir una factura lo hace administración.' });
    return true;
  }
  return false;
}

/**
 * GET /api/facturacion/corregir/:idFactura — la factura como salió, para poder tocarla.
 *
 * Los renglones salen de `/ventas/items` del día de la factura, que es la fuente viva: si alguien
 * la anuló o la tocó en IM, se ve acá.
 */
export async function verFacturaParaCorregir(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  const id = String(req.params.idFactura ?? '').trim();
  if (!/^\d+$/.test(id)) { res.status(400).json({ error: 'Falta la factura.' }); return; }
  try {
    const cab = await cabeceraComprobante(id);
    if (cab.existe === false) { res.status(404).json({ error: 'Esa factura ya no está en InfoManager.' }); return; }
    if (cab.existe !== true) { res.status(502).json({ error: 'No pude leer la factura en InfoManager. Probá de nuevo en un rato.' }); return; }
    if (cab.anulada) { res.status(409).json({ error: 'Esa factura está anulada: no hay nada que corregir.' }); return; }

    const fecha = cab.fecha ?? fechaArgentina();
    const items = (await fetchVentasItems(fecha, fecha)).filter((it: any) => String(it.id_comprobante) === id);
    if (!items.length) { res.status(502).json({ error: 'No pude traer los renglones de la factura. Probá de nuevo en un rato.' }); return; }

    const [cliente] = await fetchClientesIMCon([cab.cod_cliente ?? 0]).then(
      cs => cs.filter((c: any) => Number(c.cod_cliente) === Number(cab.cod_cliente))).catch(() => []);

    /**
     * 🪤 El precio va BRUTO (`precio_orig`), igual que al facturar: `/ventas/items` devuelve
     * `precio` YA NETO. Mezclarlos fue lo que hizo salir una factura $73.064 por debajo el
     * 09/09/2026.
     */
    const crudos = items.map((it: any) => ({
      cod_articulo: Number(it.cod_articulo) || 0,
      cantidad: Number(it.cantidad) || 0,
      precio: Number(it.precio_orig ?? 0) || Number(it.precio ?? 0) || 0,
      descripcion: String(it.detalle ?? '').trim() || `Artículo ${it.cod_articulo}`,
      iva_por: Number(it.iva_por ?? 0) || 0,
      cod_lista_precios: it.cod_lista_precios != null ? Number(it.cod_lista_precios) : null,
      descuento_porc: Number(it.descuento_porc ?? 0) || 0,
    }));

    /**
     * 🪤 El mismo artículo en dos renglones a PRECIOS DISTINTOS no se puede mostrar en una sola
     * fila sin cambiarle el precio, y la pantalla edita por artículo. Antes que emitir una nota
     * por un importe que no es el de la factura, se dice que esta va por InfoManager.
     */
    const ambiguos = articulosAmbiguos(crudos.filter((r: any) => r.cod_articulo > 0));
    if (ambiguos.length) {
      res.status(409).json({ error: `Esta factura tiene el artículo ${ambiguos.join(', ')} repetido en varios renglones a precios distintos, y así no se puede corregir desde el panel. Hay que hacerla en InfoManager.` });
      return;
    }
    // El mismo artículo repetido AL MISMO PRECIO sí: se muestra en una fila con la suma.
    const renglones = consolidarRenglones(crudos.filter((r: any) => r.cod_articulo > 0));

    res.json({
      ok: true,
      // Lo que la corrección NO puede tocar, para que se vea antes de emitir nada.
      sin_articulo: renglonesSinArticuloConImporte(crudos),
      factura: {
        id, numero: cab.numero, fecha, cod_cliente: cab.cod_cliente,
        cliente_nombre: (cliente as any)?.razon_social ?? (cliente as any)?.nombre ?? null,
        categoria_iva: (cliente as any)?.categoria_iva ?? null,
        letra: letraDeFactura((cliente as any)?.categoria_iva),
        cod_empresa: cab.cod_empresa, cod_vendedor: cab.cod_vendedor,
        cod_lista_precios: cab.cod_lista_precios,
      },
      renglones,
    });
  } catch (err: any) {
    console.error('[verFacturaParaCorregir]', err?.message);
    res.status(502).json({ error: `No pude leer la factura: ${err?.message ?? 'sin respuesta de InfoManager'}` });
  }
}

/**
 * POST /api/facturacion/corregir — previsualiza o emite la corrección.
 *
 * body: `{ im_factura_id, renglones: [{cod_articulo, cantidad, precio}], motivo?, emitir? }`
 *
 * 🔴 Sin `emitir: true` NO TOCA NADA: devuelve qué NC y qué ND saldrían. La pantalla muestra eso
 * y recién ahí se confirma. Es el mismo criterio que la facturación: primero se ve, después se
 * emite.
 */
export async function corregirFactura(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  const id = String(req.body?.im_factura_id ?? '').trim();
  if (!/^\d+$/.test(id)) { res.status(400).json({ error: 'Falta la factura.' }); return; }
  const pedidos: any[] = Array.isArray(req.body?.renglones) ? req.body.renglones : [];
  const emitir = req.body?.emitir === true;
  const motivo = String(req.body?.motivo ?? '').trim().slice(0, 200);

  try {
    const cab = await cabeceraComprobante(id);
    if (cab.existe !== true || cab.anulada !== false) {
      res.status(409).json({ error: 'No pude verificar que la factura siga vigente en InfoManager.' });
      return;
    }
    const fecha = cab.fecha ?? fechaArgentina();
    const items = (await fetchVentasItems(fecha, fecha)).filter((it: any) => String(it.id_comprobante) === id);
    if (!items.length) { res.status(502).json({ error: 'No pude traer los renglones de la factura.' }); return; }

    const originales: RenglonCorreccion[] = items.map((it: any) => ({
      cod_articulo: Number(it.cod_articulo) || 0,
      cantidad: Number(it.cantidad) || 0,
      precio: Number(it.precio_orig ?? 0) || Number(it.precio ?? 0) || 0,
      // 🔴 Sin esto la nota sale por el bruto: en la FA B 50422 eran $112.406,73 de más.
      descuento_porc: Number(it.descuento_porc ?? 0) || 0,
      descripcion: String(it.detalle ?? '').trim() || undefined,
      iva_por: Number(it.iva_por ?? 0) || 0,
      cod_lista_precios: it.cod_lista_precios != null ? Number(it.cod_lista_precios) : null,
    }));

    /**
     * 🪤 Los renglones SIN artículo no se pueden mandar a IM (`cod_articulo` es int64
     * obligatorio) y se descartan de los dos lados: si están en la factura y en lo pedido, la
     * diferencia da cero y no molestan.
     */
    const finales: RenglonCorreccion[] = pedidos
      .map(r => ({
        cod_articulo: Number(r?.cod_articulo) || 0,
        cantidad: Number(r?.cantidad) || 0,
        precio: Number(r?.precio) || 0,
        descuento_porc: Number(r?.descuento_porc ?? 0) || 0,
        descripcion: r?.descripcion != null ? String(r.descripcion) : undefined,
        iva_por: r?.iva_por != null ? Number(r.iva_por) : null,
        cod_lista_precios: r?.cod_lista_precios != null ? Number(r.cod_lista_precios) : null,
      }))
      .filter(r => r.cod_articulo > 0 && r.cantidad > 0);

    const conArticulo = originales.filter(r => r.cod_articulo > 0);
    // Mismo corte que al abrir la pantalla: lo que no se puede representar no se emite.
    const ambiguos = articulosAmbiguos(conArticulo);
    if (ambiguos.length) {
      res.status(409).json({ error: `Esta factura tiene el artículo ${ambiguos.join(', ')} repetido a precios distintos: hay que corregirla en InfoManager. No se emitió nada.` });
      return;
    }
    const correccion = calcularCorreccion(conArticulo, finales);

    if (!correccion.nc.length && !correccion.nd.length) {
      res.status(400).json({ error: 'No hay ninguna diferencia con lo que dice la factura.' });
      return;
    }

    const clientes = await fetchClientesIMCon([cab.cod_cliente ?? 0]).catch(() => [] as any[]);
    const cliente = clientes.find((c: any) => Number(c.cod_cliente) === Number(cab.cod_cliente));
    const letra = letraDeFactura((cliente as any)?.categoria_iva);
    if (!letra) {
      res.status(409).json({ error: `No se sabe qué letra le corresponde al cliente ${cab.cod_cliente} (condición de IVA: ${(cliente as any)?.categoria_iva ?? 'sin cargar'}). Hacelo a mano.` });
      return;
    }

    if (!emitir) {
      res.json({ ok: true, previsualizacion: true, letra, ...correccion });
      return;
    }

    // ── De acá para abajo se emiten comprobantes REALES ────────────────────────────────────
    /**
     * 🔴 Se comprueba que la tabla del vínculo EXISTA antes de emitir nada. Sin esto, en una base
     * donde todavía no corrió la migración 038 la nota sale en InfoManager y después no se puede
     * registrar: queda una nota de crédito real que el panel no ve y que nadie sabe que existe.
     * Cuesta una consulta y evita el peor de los estados.
     */
    const { error: errTabla } = await sb().from('facturas_correcciones').select('id').limit(1);
    if (errTabla) {
      res.status(503).json({ error: `Todavía no está la tabla de correcciones en la base (${errTabla.message}). Hay que correr la migración 038 antes de emitir. No se emitió nada.` });
      return;
    }

    const usuario = await usuarioIM(req.user);
    /**
     * 🪤 La API de IM no tiene ningún campo para relacionar la NC con su factura. La oficina lo
     * escribe en las observaciones y el panel hace lo mismo, para que se lea igual desde IM.
     */
    /**
     * 🔗 Va el número Y el id interno. El número es lo que lee una persona —es la convención que
     * la oficina ya escribe a mano, "SEGUN FACTURA 50415"— y el id es lo que identifica el
     * comprobante sin ambigüedad, que es lo que InfoManager usa para relacionarlos.
     */
    const obs = `SEGUN FACTURA ${cab.numero ?? id} [FA:${id}]${motivo ? ` - ${motivo}` : ''}`.slice(0, 500);
    const base = {
      cod_empresa: Number(cab.cod_empresa) || 1,
      cod_cliente: Number(cab.cod_cliente),
      cod_vendedor: Number(cab.cod_vendedor) || 0,
      categoria_iva: (cliente as any)?.categoria_iva,
      cod_lista_precios: Number(cab.cod_lista_precios) || 12,
      usuario,
      observaciones: obs,
      fecha: fechaArgentina(),
      cod_deposito: 1,
    };

    const emitidos: Array<{ tipo: string; numero: number | null; id: string; total: number }> = [];
    const fallados: string[] = [];

    if (correccion.nc.length) {
      const r = await emitirNotaCredito({
        ...base, total: correccion.total_nc, items: correccion.nc as any, numero: null,
      } as any);
      if (r.ok) emitidos.push({ tipo: r.tipo, numero: r.numero, id: r.id, total: correccion.total_nc });
      else {
        console.error(`[corregirFactura] NC rechazada · factura ${cab.numero}: ${r.error}`);
        fallados.push(`La nota de crédito no salió: ${r.error}`);
      }
    }
    /**
     * 🪤 La ND se emite aunque la NC haya fallado, y al revés: son dos correcciones distintas y
     * frenar la segunda porque falló la primera dejaría la factura a medio corregir sin que nadie
     * lo sepa. Lo que salió se registra; lo que no, se dice.
     */
    if (correccion.nd.length) {
      const r = await emitirNotaDebito({
        ...base, total: correccion.total_nd, items: correccion.nd as any, numero: null,
      } as any);
      if (r.ok) emitidos.push({ tipo: r.tipo, numero: r.numero, id: r.id, total: correccion.total_nd });
      else {
        console.error(`[corregirFactura] ND rechazada · factura ${cab.numero}: ${r.error}`);
        fallados.push(`La nota de débito no salió: ${r.error}`);
      }
    }

    // El vínculo con la factura vive de nuestro lado: IM no lo guarda en ningún campo.
    if (emitidos.length) {
      const { error } = await sb().from('facturas_correcciones').insert(emitidos.map(e => ({
        tenant_id: TENANT_ID,
        im_factura_id: id,
        im_factura_numero: cab.numero ?? null,
        cod_cliente: Number(cab.cod_cliente),
        tipo: e.tipo, im_comprobante_id: e.id, numero: e.numero, total: e.total,
        motivo: motivo || null,
        creado_por: req.user?.sub ?? null,
      })));
      if (error) {
        console.error('[corregirFactura] no pude registrar la corrección:', error.message);
        fallados.push(`Salieron ${emitidos.map(e => `${e.tipo} ${e.numero}`).join(' y ')} pero NO se pudieron registrar (${error.message}). ANOTALOS.`);
      }
    }

    // Lo emitido cambia los totales del cliente: las dos vistas tienen que verlo ya.
    invalidarVista(); invalidarRemitos();
    res.json({ ok: true, emitidos, fallados, letra, ...correccion });
  } catch (err: any) {
    console.error('[corregirFactura]', err?.message);
    res.status(502).json({ error: `No se pudo corregir: ${err?.message ?? 'sin respuesta de InfoManager'}` });
  }
}

/** GET /api/facturacion/corregir/:idFactura/historial — qué correcciones ya tiene la factura. */
export async function historialCorrecciones(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  const id = String(req.params.idFactura ?? '').trim();
  const { data, error } = await sb().from('facturas_correcciones')
    .select('tipo, numero, total, motivo, created_at')
    .eq('tenant_id', TENANT_ID).eq('im_factura_id', id)
    .order('created_at', { ascending: false });
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ ok: true, correcciones: data ?? [] });
}
