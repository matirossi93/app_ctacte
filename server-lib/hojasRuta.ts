/**
 * Hojas de ruta: el panel con el que la oficina arma lo que sale en cada camión.
 *
 * Reemplaza el panel de InfoManager, que **no expone nada de esto por API** (85 endpoints
 * revisados el 04/09/2026). El circuito que copia, contado por Mati el 07/09/2026: los
 * vendedores cargan → Jorgelina revisa y corrige → factura → agrupa por ZONA en 1, 2 o 3 hojas
 * por día → imprime el listado de fraccionado y la hoja de ruta con el saldo anterior de cada
 * cliente → todo eso va al galpón y se carga el camión.
 *
 * 🔑 La unidad es el COMPROBANTE DE IM, no nuestro pedido: hoy conviven pedidos de la app con
 * otros cargados directo en IM, y una hoja que sólo pudiera llevar los nuestros obligaría a
 * usar los dos sistemas.
 */
import type { Request, Response } from 'express';
import { sb, TENANT_ID } from './supabase.js';
import type { JwtPayload } from './auth.js';
import { puedeArmarHojasDeRuta } from './permisos.js';
import {
  fetchVentas, fetchVentasItems, fetchArticulosCatalogo, fetchClientesIMCached,
  fechaArgentina, getDisponibleCliente, desconfirmarPresupuesto, cabeceraComprobante,
} from './infomanager.js';
import { pesoDeRenglones, cargaDelCamion } from './pesoComprobante.js';
import { vistaDeRango, invalidarVista } from './vistaPresupuestos.js';
import { armarFraccionado, totalesFraccionado } from './fraccionado.js';
import { emitirFactura, emitirRemito, letraDeFactura, proximoNumeroFactura } from './facturarIM.js';
import type { DatosComprobante } from './facturarIM.js';
import { usuarioIM } from './pedidos.js';
import { sugerirRepartos } from './sugerirRepartos.js';

/** Sólo la oficina. Devuelve true si ya contestó el 403. */
function frenaSiNoPuede(req: Request & { user?: JwtPayload }, res: Response): boolean {
  if (!puedeArmarHojasDeRuta(String(req.user?.rol ?? ''))) {
    res.status(403).json({ error: 'Las hojas de ruta las arma administración.' });
    return true;
  }
  return false;
}

/**
 * Cuántos días para atrás se miran además de la fecha elegida. Un presupuesto vigente de la
 * semana pasada sigue esperando el camión: si no aparece, no entra en ninguna hoja.
 */
const VENTANA_DIAS = 15;

/**
 * Tope de días para los que se piden renglones. Cada día son ~1,2 s contra IM, así que sin
 * tope una ventana larga vuelve a colgar la pantalla. Se toman los más recientes.
 */
const MAX_DIAS_ITEMS = 12;

/** Mismos defaults que el módulo de pedidos: 1 = Casa Central, 12 = Lista 1. */
const PEDIDO_EMPRESA_DEFAULT = Number(process.env.PEDIDO_EMPRESA_DEFAULT || 1);
const PEDIDO_LISTA_FALLBACK = Number(process.env.PEDIDO_LISTA_FALLBACK || 12);

/** `?fecha=YYYY-MM-DD`, y si no viene, hoy. */
function fechaPedida(req: Request): string {
  const f = String(req.query.fecha ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(f) ? f : fechaArgentina();
}

/**
 * GET /api/hojas-ruta/pendientes?fecha= — los comprobantes del día para armar las hojas.
 *
 * Trae de IM los presupuestos vigentes de esa fecha, y de cada uno: cliente, zona, bultos,
 * kilos, total, si vino de la app (con sus avisos del control de listas) y en qué hoja está.
 *
 * 🔑 El peso sale de `/ventas/items` por rango, UNA llamada para todo el día, en vez de pedir
 * los renglones comprobante por comprobante: con 50 pedidos eso eran 50 requests a IM y la
 * pantalla tardaba medio minuto en abrir.
 */
export async function pendientesDelDia(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  try {
    const fecha = fechaPedida(req);
    // `?dias=N` para incluir los vigentes de días anteriores. El default es 0 porque la
    // pantalla tiene que abrir rápido; el aviso de que hay pedidos viejos lo da /arrastre.
    const dias = Math.min(Math.max(Number(req.query.dias) || 0, 0), VENTANA_DIAS);
    const armado = await armarVistaDelDia(fecha, dias, req.query.refrescar === '1');
    res.json({ ok: true, fecha, dias, ...armado });
  } catch (err: any) {
    console.error('[pendientesDelDia]', err?.message);
    res.status(502).json({ error: `No se pudieron traer los pedidos del día: ${err?.message ?? 'sin respuesta de IM'}` });
  }
}

/**
 * Lo que se muestra del día. Separado del handler para que el sugeridor lo reuse.
 *
 * `dias` es cuántos días para atrás se miran ADEMÁS del elegido. Por defecto 0 — sólo el día.
 *
 * 🪤 Al principio esto miraba siempre 15 días para no perderse los pedidos viejos vigentes.
 * Medido el 07/09/2026 contra IM: **24,4 s y 476 pedidos en pantalla**, de los cuales 417 eran
 * de otros días. Ni abría a tiempo ni servía para trabajar. La versión anterior era peor
 * (miraba sólo la fecha exacta y se perdía 166 pedidos en silencio), así que la salida no es
 * elegir entre las dos: el día abre rápido y los anteriores se piden cuando hacen falta.
 */
/**
 * La vista del día sale de `vistaPresupuestos.ts`: la misma consulta la usan esta pantalla y la
 * de revisión de presupuestos (etapa 1), que trabaja por rango de fechas.
 */
async function armarVistaDelDia(fecha: string, dias = 0, forzar = false) {
  // 🪤 Mirar SÓLO la fecha exacta se perdía la mayoría de los pedidos: el 07/09/2026 había 225
  // presupuestos vigentes y el panel mostraba 59. La oficina MUEVE la fecha del comprobante
  // para reordenar despachos, así que un pedido fechado para el 10 existe desde antes.
  const desde = dias > 0
    ? fechaArgentina(new Date(fecha + 'T12:00:00Z').getTime() - dias * 864e5)
    : fecha;
  return vistaDeRango(desde, fecha, forzar);
}

/**
 * GET /api/hojas-ruta/sugerencia?fecha= — cómo repartir el día en hojas que entren en los
 * camiones. Es el trabajo que hoy hace Jorgelina a mano cuando una zona da más kilos que un
 * camión. Sugiere: no crea nada.
 */
export async function sugerenciaDelDia(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  try {
    const fecha = fechaPedida(req);
    const [{ pendientes }, { data: camiones }] = await Promise.all([
      armarVistaDelDia(fecha, Math.min(Math.max(Number(req.query.dias) || 0, 0), VENTANA_DIAS)),
      sb().from('hojas_ruta_camiones').select('id, nombre, capacidad_kg')
        .eq('tenant_id', TENANT_ID).eq('activo', true),
    ]);
    const flota = (camiones ?? []).map((c: any) => ({
      id: String(c.id), nombre: String(c.nombre), capacidad_kg: Number(c.capacidad_kg),
    }));
    res.json({ ok: true, fecha, ...sugerirRepartos(pendientes as any, flota) });
  } catch (err: any) {
    console.error('[sugerenciaDelDia]', err?.message);
    res.status(502).json({ error: `No se pudo armar la sugerencia: ${err?.message ?? 'sin respuesta de IM'}` });
  }
}

/**
 * GET /api/hojas-ruta/arrastre?fecha= — cuántos presupuestos vigentes quedaron de días
 * anteriores, sin traer sus renglones.
 *
 * Va aparte y lo pide la pantalla DESPUÉS de dibujar el día, para que el aviso no retrase la
 * apertura. Sin renglones tarda ~6 s en vez de 24; con ellos no entra en el timeout del proxy.
 */
export async function arrastreDelDia(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  try {
    const fecha = fechaPedida(req);
    const desde = fechaArgentina(new Date(fecha + 'T12:00:00Z').getTime() - VENTANA_DIAS * 864e5);
    const ventas = await fetchVentas(desde, fecha);
    const previos = ventas.filter((v: any) =>
      String(v.tipo_comprobante ?? '').trim() === 'PR' &&
      String(v.anulada ?? '').trim().toUpperCase() !== 'S' &&
      String(v.fecha ?? '').slice(0, 10) !== fecha);
    const ids = previos.map((p: any) => String(p.id));
    // Los que ya están en una hoja no son arrastre: alguien se ocupó.
    const { data: asignados } = ids.length
      ? await sb().from('hojas_ruta_pedidos').select('im_comprobante_id').in('im_comprobante_id', ids.slice(0, 400))
      : { data: [] as any[] };
    const yaEn = new Set((asignados ?? []).map((a: any) => String(a.im_comprobante_id)));
    const sueltos = previos.filter((p: any) => !yaEn.has(String(p.id)));
    const porFecha: Record<string, number> = {};
    for (const p of sueltos) porFecha[String(p.fecha).slice(0, 10)] = (porFecha[String(p.fecha).slice(0, 10)] ?? 0) + 1;
    res.json({ ok: true, fecha, cantidad: sueltos.length, desde, por_fecha: porFecha });
  } catch (err: any) {
    res.status(502).json({ error: err?.message ?? 'no se pudo consultar' });
  }
}

/** GET /api/hojas-ruta?fecha= — las hojas del día, con su carga y el camión. */
export async function listarHojas(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  try {
    const fecha = fechaPedida(req);
    const { data: hojas, error } = await sb().from('hojas_ruta')
      .select('*, hojas_ruta_camiones(nombre, capacidad_kg), hojas_ruta_pedidos(*)')
      .eq('tenant_id', TENANT_ID).eq('fecha', fecha).order('numero');
    if (error) { res.status(500).json({ error: error.message }); return; }
    const conCarga = (hojas ?? []).map((h: any) => {
      const ps = h.hojas_ruta_pedidos ?? [];
      const kg = ps.reduce((s: number, p: any) => s + Number(p.kg ?? 0), 0);
      const bultos = ps.reduce((s: number, p: any) => s + Number(p.bultos ?? 0), 0);
      const cap = h.hojas_ruta_camiones?.capacidad_kg;
      return {
        ...h,
        camion: h.hojas_ruta_camiones?.nombre ?? null,
        capacidad_kg: cap ?? null,
        pedidos: ps.sort((a: any, b: any) => a.orden - b.orden),
        totales: { pedidos: ps.length, bultos: Math.round(bultos * 100) / 100, kg: Math.round(kg * 100) / 100 },
        carga: cargaDelCamion(kg, cap),
      };
    });
    res.json({ ok: true, fecha, hojas: conCarga });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/**
 * GET /api/hojas-ruta/:id/impresion — todo lo que hace falta para imprimir una hoja.
 *
 * Devuelve las dos cosas que hoy Jorgelina arma a mano:
 *  1. **La hoja de ruta**: cabecera y los comprobantes agrupados POR CLIENTE con su total, tal
 *     como la hoja real nº 3394. Un cliente puede llevar varios comprobantes.
 *  2. **El listado de fraccionado**: sólo lo que se vende por kilo, agrupado por producto y con
 *     **cada cantidad separada** — cada una es un paquete a preparar. Mati fue explícito: *"no
 *     hace falta aclarar por cliente, sólo el producto y la cantidad"* y *"no se puede
 *     globalizar cantidades"*.
 *
 * 🔑 Los importes, saldos, bultos y kilos salen del SNAPSHOT guardado al armar la hoja, no se
 * recalculan. Los renglones del fraccionado sí se piden a IM: son el detalle de qué preparar y
 * tienen que reflejar el pedido como está ahora.
 */
export async function impresionHoja(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  try {
    const { data: hoja, error } = await sb().from('hojas_ruta')
      .select('*, hojas_ruta_camiones(nombre, capacidad_kg), hojas_ruta_pedidos(*)')
      .eq('id', String(req.params.id)).eq('tenant_id', TENANT_ID).maybeSingle();
    if (error) { res.status(500).json({ error: error.message }); return; }
    if (!hoja) { res.status(404).json({ error: 'Hoja de ruta no encontrada' }); return; }

    const pedidos = [...((hoja as any).hojas_ruta_pedidos ?? [])].sort((a: any, b: any) => a.orden - b.orden);

    // Agrupado por cliente, como la hoja impresa: un cliente puede tener varios comprobantes
    // y abajo el "Total por cliente".
    const porCliente = new Map<number, any>();
    for (const p of pedidos) {
      const k = Number(p.cod_cliente);
      if (!porCliente.has(k)) {
        porCliente.set(k, {
          cod_cliente: k, cliente_nombre: p.cliente_nombre, saldo_anterior: p.saldo_anterior,
          comprobantes: [], total: 0, bultos: 0, kg: 0,
        });
      }
      const c = porCliente.get(k);
      c.comprobantes.push({
        im_comprobante_id: p.im_comprobante_id, im_numero: p.im_numero,
        bultos: Number(p.bultos ?? 0), kg: Number(p.kg ?? 0), total: Number(p.total ?? 0),
        im_remito_numero: p.im_remito_numero ?? null,
        facturado: !!p.facturado_at,
      });
      c.total += Number(p.total ?? 0);
      c.bultos += Number(p.bultos ?? 0);
      c.kg += Number(p.kg ?? 0);
      // 🪤 El saldo es del CLIENTE, no del comprobante: si tiene dos pedidos no se suma dos
      // veces. Se queda con el primero que tenga uno cargado.
      if (c.saldo_anterior == null && p.saldo_anterior != null) c.saldo_anterior = p.saldo_anterior;
    }

    // ── Fraccionado: lo que se vende por kilo, producto por producto ──────────
    // 🔑 El armado vive en `fraccionado.ts` y lo comparte con la etapa de presupuestos, que es
    // donde la oficina lo prepara ahora (antes del armado de la hoja).
    let fraccionado: ReturnType<typeof armarFraccionado> = [];
    try {
      const cat = await fetchArticulosCatalogo();
      const ids = new Set(pedidos.map((p: any) => String(p.im_comprobante_id)));
      const dias = [...new Set(pedidos.map((p: any) => String((hoja as any).fecha).slice(0, 10)))];
      const renglones: Array<{ cod_articulo: number; cantidad: number }> = [];
      for (const f of dias.slice(0, 6)) {
        for (const it of await fetchVentasItems(f, f).catch(() => [] as any[])) {
          if (!ids.has(String((it as any).id_comprobante))) continue;
          renglones.push({ cod_articulo: Number((it as any).cod_articulo), cantidad: Number((it as any).cantidad) });
        }
      }
      fraccionado = armarFraccionado(renglones, cat);
    } catch (e: any) {
      // Sin el detalle no se puede imprimir el listado de fraccionado, pero la hoja de ruta sí:
      // se devuelve vacío y la pantalla avisa, en vez de fallar entera.
      console.warn('[impresionHoja] no pude armar el fraccionado:', e?.message);
    }

    const totales = pedidos.reduce((acc: any, p: any) => ({
      bultos: acc.bultos + Number(p.bultos ?? 0),
      kg: acc.kg + Number(p.kg ?? 0),
      total: acc.total + Number(p.total ?? 0),
    }), { bultos: 0, kg: 0, total: 0 });

    res.json({
      ok: true,
      hoja: {
        id: (hoja as any).id, numero: (hoja as any).numero, fecha: (hoja as any).fecha,
        turno: (hoja as any).turno, transporte: (hoja as any).transporte,
        camion: (hoja as any).hojas_ruta_camiones?.nombre ?? null,
        capacidad_kg: (hoja as any).hojas_ruta_camiones?.capacidad_kg ?? null,
        estado: (hoja as any).estado,
      },
      clientes: [...porCliente.values()],
      totales: {
        clientes: porCliente.size, comprobantes: pedidos.length,
        bultos: Math.round(totales.bultos * 100) / 100,
        kg: Math.round(totales.kg * 100) / 100,
        total: Math.round(totales.total * 100) / 100,
      },
      fraccionado,
      fraccionado_totales: totalesFraccionado(fraccionado),
      sin_saldo: [...porCliente.values()].filter((c: any) => c.saldo_anterior == null).length,
    });
  } catch (err: any) {
    console.error('[impresionHoja]', err?.message);
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/**
 * Qué le va a pasar a cada pedido de la hoja cuando se apriete Facturar.
 *
 * `listo` sale entero (factura + remito) · `falta_remito` ya tiene la factura emitida y sólo
 * le falta el remito · `facturado` está completo · `no_se_puede` no se toca y dice por qué.
 */
type EstadoFacturacion = 'listo' | 'falta_remito' | 'facturado' | 'no_se_puede';

interface PedidoPreparado {
  fila: any;
  estado: EstadoFacturacion;
  motivo: string | null;
  letra: 'A' | 'B' | null;
  /** Lo que se le manda a IM. `null` cuando el pedido no se puede facturar. */
  datos: DatosComprobante | null;
}

/** Tope de días de renglones que se piden para una hoja. Cada día es una consulta a IM. */
const MAX_DIAS_FACTURA = 6;

/**
 * Revisa, contra IM, qué se puede emitir de una hoja — **sin emitir nada**.
 *
 * La usan el botón (para mostrar de antemano qué va a salir) y la facturación misma, a
 * propósito: si fueran dos caminos distintos, la pantalla podría prometer algo que después no
 * se emite.
 *
 * 🪤 Los renglones se piden por la FECHA REAL de cada comprobante, no por la de la hoja. Una
 * hoja lleva pedidos arrastrados de días anteriores (el 07/09/2026 había 417 vigentes sin
 * salir), y pidiendo sólo el día de la hoja esos pedidos se quedaban sin renglones y no se
 * podían facturar.
 *
 * 🪤 También mira si el presupuesto sigue vivo: la oficina anula comprobantes en IM todo el
 * tiempo, y facturar uno anulado deja una factura sin respaldo.
 */
async function prepararFacturacion(hoja: any, filas: any[], usuario: string): Promise<PedidoPreparado[]> {
  const clientes = await fetchClientesIMCached().catch(() => [] as any[]);
  const porCliente = new Map(clientes.map((c: any) => [Number(c.cod_cliente), c]));

  // Lo ya facturado no necesita nada de IM.
  const aRevisar = filas.filter((f: any) => !f.facturado_at);

  const cabeceras = new Map<string, { fecha: string | null; anulada: boolean | null; existe: boolean | null }>();
  await Promise.all(aRevisar.map(async (f: any) => {
    const k = String(f.im_comprobante_id);
    try { cabeceras.set(k, await cabeceraComprobante(k)); }
    catch { cabeceras.set(k, { fecha: null, anulada: null, existe: null }); }
  }));

  // Un día = una consulta de renglones. Los que no tienen cabecera caen en el día de la hoja.
  const dia = String(hoja.fecha).slice(0, 10);
  const dias = [...new Set(aRevisar.map((f: any) => cabeceras.get(String(f.im_comprobante_id))?.fecha ?? dia))].sort();
  const renglonesPorComp = new Map<string, any[]>();
  // 🪤 Con muchos días sueltos se pide el RANGO entero de una vez. Truncar la lista dejaría
  // pedidos sin renglones y el error diría "no pude traer los renglones", que es mentira: no se
  // habría consultado ese día. Una consulta larga es lenta, pero factura todo lo que hay.
  const tandas = dias.length > MAX_DIAS_FACTURA
    ? [await fetchVentasItems(dias[0], dias[dias.length - 1]).catch(() => [] as any[])]
    : await Promise.all(dias.map(d => fetchVentasItems(d, d).catch(() => [] as any[])));
  for (const it of tandas.flat()) {
    const k = String((it as any).id_comprobante);
    if (!renglonesPorComp.has(k)) renglonesPorComp.set(k, []);
    renglonesPorComp.get(k)!.push(it);
  }

  return filas.map((f: any): PedidoPreparado => {
    const quien = `${f.cliente_nombre ?? 'cliente ' + f.cod_cliente} (PR ${f.im_numero ?? f.im_comprobante_id})`;
    const cliente = porCliente.get(Number(f.cod_cliente));
    const letra = letraDeFactura(cliente?.categoria_iva);
    const no = (motivo: string): PedidoPreparado => ({ fila: f, estado: 'no_se_puede', motivo, letra, datos: null });

    if (f.facturado_at) return { fila: f, estado: 'facturado', motivo: null, letra, datos: null };

    const cab = cabeceras.get(String(f.im_comprobante_id));
    if (cab?.existe === false) return no(`${quien}: el presupuesto ya no está en InfoManager. Sacalo de la hoja.`);
    if (cab?.anulada === true) return no(`${quien}: el presupuesto está ANULADO en InfoManager. Sacalo de la hoja.`);

    const items = renglonesPorComp.get(String(f.im_comprobante_id)) ?? [];
    if (!items.length) return no(`No pude traer los renglones del ${quien}. Facturalo a mano.`);

    // 🔴 Con la factura ya emitida NO se vuelve a emitir: sólo falta el remito, que es X y no
    // depende de la condición de IVA.
    const yaTieneFactura = !!f.im_factura_id;
    if (!yaTieneFactura && !letra) {
      return no(`${quien}: no se sabe qué letra de factura le corresponde (condición de IVA: ${cliente?.categoria_iva ?? 'sin cargar'}). Facturalo a mano.`);
    }

    return {
      fila: f,
      estado: yaTieneFactura ? 'falta_remito' : 'listo',
      motivo: null,
      letra,
      datos: {
        cod_empresa: Number(hoja.cod_empresa) || PEDIDO_EMPRESA_DEFAULT,
        cod_cliente: Number(f.cod_cliente),
        cod_vendedor: Number(items[0]?.cod_vendedor ?? 0) || 1,
        categoria_iva: cliente?.categoria_iva,
        cod_lista_precios: Number(items[0]?.cod_lista_precios) || PEDIDO_LISTA_FALLBACK,
        usuario,
        observaciones: `Pedido ${f.im_numero ?? ''} · hoja ${hoja.numero}`,
        origen_id: f.im_comprobante_id,
        total: Number(f.total ?? 0),
        cod_deposito: 1,
        items: items.map((it: any) => ({
          cod_articulo: Number(it.cod_articulo), cantidad: Number(it.cantidad),
          precio: Number(it.precio ?? 0), iva_por: Number(it.iva_por ?? 0),
          cod_lista_precios: it.cod_lista_precios != null ? Number(it.cod_lista_precios) : null,
          descuento_porc: it.descuento_porc ? Number(it.descuento_porc) : null,
        })),
      },
    };
  });
}

/** La hoja con sus pedidos, o `null` si no existe (ya contestó el 404). */
async function hojaConPedidos(req: Request, res: Response): Promise<any | null> {
  const { data: hoja } = await sb().from('hojas_ruta')
    .select('*, hojas_ruta_pedidos(*)').eq('id', String(req.params.id)).eq('tenant_id', TENANT_ID).maybeSingle();
  if (!hoja) { res.status(404).json({ error: 'Hoja de ruta no encontrada' }); return null; }
  return hoja;
}

/**
 * GET /api/hojas-ruta/:id/facturacion — qué se va a emitir, ANTES de emitir nada.
 *
 * Es la pantalla de confirmación: facturar consume numeración fiscal y descuenta stock, así que
 * quien aprieta el botón tiene que ver primero comprobante por comprobante qué sale, con qué
 * letra, y cuáles no se pueden y por qué.
 */
export async function previsualizarFacturacion(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  try {
    const hoja = await hojaConPedidos(req, res);
    if (!hoja) return;
    const filas = [...(hoja.hojas_ruta_pedidos ?? [])].sort((a: any, b: any) => a.orden - b.orden);
    // El usuario de IM va vacío a propósito: esto no emite nada y el payload no se usa para
    // emitir. Cuando se factura de verdad se vuelve a preparar, ahí sí con el usuario real.
    const preparados = await prepararFacturacion(hoja, filas, '');

    const pedidos = preparados.map(p => ({
      im_comprobante_id: p.fila.im_comprobante_id,
      im_numero: p.fila.im_numero,
      cod_cliente: p.fila.cod_cliente,
      cliente_nombre: p.fila.cliente_nombre,
      total: Number(p.fila.total ?? 0),
      letra: p.letra,
      estado: p.estado,
      motivo: p.motivo,
      im_factura_numero: p.fila.im_factura_numero ?? null,
      im_remito_numero: p.fila.im_remito_numero ?? null,
      renglones: p.datos?.items.length ?? 0,
    }));
    const listos = preparados.filter(p => p.estado === 'listo');

    res.json({
      ok: true,
      hoja: {
        id: hoja.id, numero: hoja.numero, fecha: hoja.fecha,
        estado: hoja.estado, facturada_at: hoja.facturada_at ?? null,
      },
      pedidos,
      a_emitir: {
        facturas: listos.length,
        // Los que ya tienen la factura emitida igual necesitan su remito.
        remitos: listos.length + preparados.filter(p => p.estado === 'falta_remito').length,
        clientes: new Set(listos.map(p => Number(p.fila.cod_cliente))).size,
        // Sólo lo que se va a facturar: lo ya emitido no vuelve a sumar.
        total: Math.round(listos.reduce((s, p) => s + Number(p.fila.total ?? 0), 0) * 100) / 100,
        letras: {
          A: listos.filter(p => p.letra === 'A').length,
          B: listos.filter(p => p.letra === 'B').length,
        },
      },
      no_se_puede: preparados.filter(p => p.estado === 'no_se_puede').length,
      ya_facturados: preparados.filter(p => p.estado === 'facturado').length,
      punto_de_venta: Number(process.env.IM_PTO_VENTA_FACTURA || 777),
    });
  } catch (err: any) {
    console.error('[previsualizarFacturacion]', err?.message);
    res.status(502).json({ error: `No pude consultar InfoManager para saber qué se puede facturar: ${err?.message ?? 'sin respuesta'}` });
  }
}

/**
 * POST /api/hojas-ruta/:id/facturar — emite factura y remito de los pedidos de la hoja.
 *
 * 🔴 ES LO ÚNICO IRREVERSIBLE DEL CIRCUITO. Una factura consume numeración fiscal y toca la
 * cuenta corriente; el remito descuenta stock. Todo acá está escrito para fallar del lado
 * seguro:
 *
 *  · **De a un pedido por vez, nunca en paralelo.** Si algo se rompe a la mitad, quedan
 *    emitidos los que ya salieron y ni uno más — no diez comprobantes huérfanos.
 *  · **El id se guarda APENAS se emite**, antes de seguir. Un comprobante emitido que no
 *    quedó registrado es un comprobante que alguien va a volver a emitir.
 *  · **`sinRespuesta` FRENA TODO.** Si IM no contestó, no se sabe si la factura salió:
 *    reintentar es facturarle dos veces al mismo cliente. Se corta y lo revisa una persona.
 *  · **Lo ya facturado se saltea**, aunque venga en el pedido, y al que ya tiene la factura
 *    emitida se le hace SÓLO el remito.
 *
 * 🪤 Facturar por API NO vincula el comprobante con el presupuesto (probado el 07/09/2026):
 * la relación la guardamos nosotros, y al final se **desconfirma el presupuesto** para que no
 * quede en la ventana de facturación de la oficina y alguien lo facture de nuevo.
 */
export async function facturarHoja(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  try {
    const hojaId = String(req.params.id);
    const hoja = await hojaConPedidos(req, res);
    if (!hoja) return;

    const todos = hoja.hojas_ruta_pedidos ?? [];
    // Se puede facturar la hoja entera o sólo algunos comprobantes.
    const pedidos = Array.isArray(req.body?.im_comprobante_ids) && req.body.im_comprobante_ids.length
      ? todos.filter((p: any) => req.body.im_comprobante_ids.includes(String(p.im_comprobante_id)))
      : todos;
    if (!pedidos.filter((p: any) => !p.facturado_at).length) {
      res.status(409).json({ error: 'No hay pedidos sin facturar en esta hoja.' }); return;
    }

    const usuario = await usuarioIM(req.user);
    const preparados = (await prepararFacturacion(hoja, pedidos, usuario))
      .filter(p => p.estado !== 'facturado');

    const hechos: any[] = [];
    const fallados: string[] = [];
    let cortado: string | null = null;

    // 🔑 El número de factura se calcula UNA vez por hoja y después se incrementa: IM no lo
    // asigna, y averiguarlo cuesta ~6 s de consulta a IM cada vez. Si otro lo tomó mientras
    // tanto, `emitirFactura` reintenta con el siguiente.
    const numeros: Record<string, number | null> = { A: null, B: null };
    for (const letra of ['A', 'B'] as const) {
      if (preparados.some(p => p.estado === 'listo' && p.letra === letra)) {
        numeros[letra] = await proximoNumeroFactura(letra, Number(process.env.IM_PTO_VENTA_FACTURA || 777));
      }
    }

    for (const p of preparados) {
      if (cortado) break;
      if (p.estado === 'no_se_puede' || !p.datos) { fallados.push(p.motivo ?? 'no se pudo facturar'); continue; }
      const f = p.fila;
      const quien = `${f.cliente_nombre ?? 'cliente ' + f.cod_cliente} (PR ${f.im_numero ?? f.im_comprobante_id})`;

      // 1) FACTURA — salvo que ya la tenga: reintentar emitirla sería facturarle dos veces.
      let facturaNumero: number | null = f.im_factura_numero ?? null;
      let tipoFactura = `FA ${p.letra ?? ''}`.trim();
      if (!f.im_factura_id) {
        const letra = p.letra!;
        const fa = await emitirFactura({ ...p.datos, numero: numeros[letra] } as any);
        // El siguiente de este talonario, para no volver a consultarlo.
        if (fa.ok && fa.numero != null) numeros[letra] = Number(fa.numero) + 1;
        if (!fa.ok) {
          fallados.push(`${quien}: ${fa.error}`);
          // 🔴 Sin respuesta = NO se sabe si la factura salió. Se corta acá: seguir sería
          // arriesgarse a facturar dos veces al resto si IM está a medio camino.
          if (fa.sinRespuesta) cortado = `InfoManager no contestó al facturar ${quien}. NO se sabe si la factura se emitió: verificalo en IM antes de volver a intentar. Se frenó el resto de la hoja.`;
          continue;
        }
        // Se guarda ANTES de seguir: un comprobante emitido sin registrar se vuelve a emitir.
        await sb().from('hojas_ruta_pedidos')
          .update({ im_factura_id: fa.id, im_factura_numero: fa.numero }).eq('id', f.id);
        facturaNumero = fa.numero;
        tipoFactura = fa.tipo;
      }

      // 2) REMITO
      const re = await emitirRemito(p.datos as any);
      if (!re.ok) {
        fallados.push(`${quien}: la FACTURA ${facturaNumero} se emitió, pero el remito falló (${re.error}). Hacé el remito a mano.`);
        if (re.sinRespuesta) cortado = `InfoManager no contestó al emitir el remito de ${quien}. La factura ${facturaNumero} SÍ se emitió. Revisalo en IM. Se frenó el resto.`;
        continue;
      }
      await sb().from('hojas_ruta_pedidos').update({
        im_remito_id: re.id, im_remito_numero: re.numero, facturado_at: new Date().toISOString(),
      }).eq('id', f.id);

      // 3) El presupuesto sale de la ventana de facturación de la oficina.
      const desc = await desconfirmarPresupuesto(f.im_comprobante_id);
      if (!desc.ok) console.warn(`[facturarHoja] no pude desconfirmar el PR ${f.im_numero}:`, desc.error);

      // 4) Si el pedido vino de la app, queda marcado también ahí.
      if (f.pedido_id) {
        await sb().from('pedidos_vendedor').update({ estado: 'facturado' }).eq('id', f.pedido_id);
      }
      hechos.push({ cliente: f.cliente_nombre, factura: facturaNumero, remito: re.numero, tipo: tipoFactura });
    }

    // La hoja queda marcada cuando no le falta ninguno.
    const { data: quedan } = await sb().from('hojas_ruta_pedidos')
      .select('id').eq('hoja_id', hojaId).is('facturado_at', null);
    if (!(quedan ?? []).length) {
      await sb().from('hojas_ruta').update({ facturada_at: new Date().toISOString() }).eq('id', hojaId);
    }

    res.json({
      ok: !fallados.length && !cortado,
      facturados: hechos.length, hechos,
      fallados,
      cortado,
      quedan_sin_facturar: (quedan ?? []).length,
    });
  } catch (err: any) {
    console.error('[facturarHoja]', err?.message);
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}
/** GET /api/hojas-ruta/camiones — la flota, para elegir al crear la hoja. */
export async function listarCamiones(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  const { data, error } = await sb().from('hojas_ruta_camiones')
    .select('*').eq('tenant_id', TENANT_ID).eq('activo', true).order('capacidad_kg');
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ ok: true, camiones: data ?? [] });
}

/** POST /api/hojas-ruta — crea una hoja vacía. */
export async function crearHoja(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  try {
    const b = req.body ?? {};
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(b.fecha ?? '')) ? String(b.fecha) : fechaArgentina();
    // El número sigue al último, para que se parezca al de IM (la hoja del 07/09 era la 3394)
    // y la oficina pueda hablar de "la 3395" sin traducir.
    // 🪤 La primera hoja NO puede salir con el número 1: arrancaría una numeración paralela a
    // la de IM y la oficina tendría que llevar dos. Por eso el arranque se toma de
    // HOJA_RUTA_NUMERO_INICIAL (o el 3395, que es la que sigue a la última que se imprimió).
    const { data: ultima } = await sb().from('hojas_ruta')
      .select('numero').eq('tenant_id', TENANT_ID).order('numero', { ascending: false }).limit(1).maybeSingle();
    const arranque = Number(process.env.HOJA_RUTA_NUMERO_INICIAL) || 3395;
    const siguiente = ultima?.numero != null ? Number(ultima.numero) + 1 : arranque;
    const numero = Number(b.numero) || siguiente;
    const { data, error } = await sb().from('hojas_ruta').insert({
      tenant_id: TENANT_ID, fecha, numero,
      turno: b.turno ? String(b.turno) : null,
      transporte: b.transporte ? String(b.transporte) : null,
      camion_id: b.camion_id ? String(b.camion_id) : null,
      cod_zona: Number.isFinite(Number(b.cod_zona)) && Number(b.cod_zona) > 0 ? Number(b.cod_zona) : null,
      observaciones: b.observaciones ? String(b.observaciones) : null,
      created_by: req.user?.sub ?? null,
    }).select().maybeSingle();
    if (error) {
      // El número es único por tenant: si dos personas crean una hoja a la vez, la segunda
      // choca. Se dice claro en vez de un 500 que no se entiende.
      if ((error as any).code === '23505') {
        res.status(409).json({ error: `Ya existe una hoja de ruta con el número ${numero}. Probá de nuevo.` });
        return;
      }
      res.status(500).json({ error: error.message }); return;
    }
    res.json({ ok: true, hoja: data });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/**
 * POST /api/hojas-ruta/:id/pedidos — mete comprobantes en la hoja.
 *
 * Guarda un SNAPSHOT de saldo, bultos y kilos. No se recalcula al imprimir: el saldo del
 * cliente cambia solo (entra un recibo, se factura otra cosa) y el papel que se llevó el
 * repartidor tiene que poder explicarse después.
 */
export async function asignarPedidos(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  try {
    const hojaId = String(req.params.id);
    const { data: hoja } = await sb().from('hojas_ruta').select('*')
      .eq('id', hojaId).eq('tenant_id', TENANT_ID).maybeSingle();
    if (!hoja) { res.status(404).json({ error: 'Hoja de ruta no encontrada' }); return; }
    if (hoja.estado !== 'abierta') {
      res.status(409).json({ error: `La hoja ${hoja.numero} está ${hoja.estado}: no se le pueden agregar pedidos.` });
      return;
    }

    const entrada: any[] = Array.isArray(req.body?.pedidos) ? req.body.pedidos : [];
    if (!entrada.length) { res.status(400).json({ error: 'No mandaste ningún pedido' }); return; }

    // ¿Alguno ya está en otra hoja? Se avisa antes de tocar nada: un comprobante en dos hojas
    // se carga en dos camiones.
    const ids = entrada.map(p => String(p.im_comprobante_id));
    const { data: yaAsignados } = await sb().from('hojas_ruta_pedidos')
      .select('im_comprobante_id, hoja_id, im_numero').in('im_comprobante_id', ids);
    const enOtra = (yaAsignados ?? []).filter((a: any) => String(a.hoja_id) !== hojaId);
    // 🔑 Con `mover: true` se reasignan a esta hoja. Es una operación NORMAL de la oficina:
    // cuando una zona se pasa de kilos, Jorgelina va moviendo pedidos entre hojas hasta que
    // entren (Mati, 07/09/2026: "permitir que podamos mover los pedidos y manejar las hojas").
    // Sin el flag se avisa, para que un clic distraído no le saque un pedido a otro camión.
    if (enOtra.length && req.body?.mover !== true) {
      res.status(409).json({
        error: `Estos pedidos ya están en otra hoja de ruta: ${enOtra.map((a: any) => a.im_numero ?? a.im_comprobante_id).join(', ')}. Sacalos de ahí primero.`,
        mover_disponible: true,
        en_otra_hoja: enOtra.map((a: any) => String(a.im_comprobante_id)),
      });
      return;
    }

    // El saldo del cliente: es JUSTO lo que hoy escriben a mano en la hoja impresa. Se consulta
    // de a uno porque IM no tiene un endpoint masivo; son pocos por hoja y se guarda el número.
    const saldos = new Map<number, number | null>();
    await Promise.all([...new Set(entrada.map(p => Number(p.cod_cliente)))].map(async (cod) => {
      try { const d = await getDisponibleCliente(cod); saldos.set(cod, d ? d.saldo : null); }
      catch { saldos.set(cod, null); }   // sin saldo se imprime en blanco, como hoy
    }));

    const { data: ultimo } = await sb().from('hojas_ruta_pedidos')
      .select('orden').eq('hoja_id', hojaId).order('orden', { ascending: false }).limit(1).maybeSingle();
    let orden = Number(ultimo?.orden ?? -1);

    // 🔑 El peso se RECALCULA acá contra IM; no se guarda el que mandó el navegador. Los kilos
    // deciden en qué camión entra la mercadería: si la pantalla quedó abierta desde ayer, o
    // alguien editó el pedido mientras tanto, guardar el número viejo arma una hoja que no
    // entra y eso se descubre en el galpón, cargando.
    const pesos = new Map<string, { bultos: number; kg: number }>();
    try {
      const cat = await fetchArticulosCatalogo();
      const porComprobante = new Map<string, any[]>();
      // Sólo los días de los comprobantes que se están asignando: pedir la ventana entera
      // tarda 23 s y esto corre con el usuario esperando.
      const dias = [...new Set(entrada.map((p: any) => String(p.fecha ?? hoja.fecha).slice(0, 10)).filter(Boolean))];
      const tandas = await Promise.all(dias.slice(0, 6).map(f => fetchVentasItems(f, f).catch(() => [] as any[])));
      for (const it of tandas.flat()) {
        const k = String((it as any).id_comprobante);
        if (!porComprobante.has(k)) porComprobante.set(k, []);
        porComprobante.get(k)!.push({
          cantidad: (it as any).cantidad,
          equivalencia_um: cat.get(Number((it as any).cod_articulo))?.equivalencia_um,
        });
      }
      for (const p of entrada) {
        const rs = porComprobante.get(String(p.im_comprobante_id));
        if (rs) pesos.set(String(p.im_comprobante_id), pesoDeRenglones(rs));
      }
    } catch (e: any) {
      // Si IM no contesta se usa lo que mandó la pantalla, que es mejor que no poder armar la
      // hoja; queda dicho en la respuesta para que no se confíe en el total.
      console.warn('[asignarPedidos] no pude recalcular el peso, uso el de la pantalla:', e?.message);
    }

    const filas = entrada.map((p) => {
      const peso = pesos.get(String(p.im_comprobante_id));
      return {
        hoja_id: hojaId,
        im_comprobante_id: String(p.im_comprobante_id),
        im_numero: p.im_numero != null ? Number(p.im_numero) : null,
        cod_cliente: Number(p.cod_cliente),
        cliente_nombre: p.cliente_nombre ? String(p.cliente_nombre) : null,
        pedido_id: p.pedido_id ? String(p.pedido_id) : null,
        orden: ++orden,
        saldo_anterior: saldos.get(Number(p.cod_cliente)) ?? null,
        bultos: peso ? peso.bultos : (Number(p.bultos) || 0),
        kg: peso ? peso.kg : (Number(p.kg) || 0),
        // El importe sale impreso en la hoja ("Imp. Total" y "Total por cliente").
        total: Number(p.total) || 0,
      };
    });
    let { error } = await sb().from('hojas_ruta_pedidos').upsert(filas, { onConflict: 'im_comprobante_id' });
    // 🪤 `total` lo agrega la migración 033. Si todavía no corrió, un insert con una columna
    // inexistente falla ENTERO y no se puede armar ninguna hoja. Se reintenta sin el importe:
    // lo único que se pierde es que salga impreso, y eso se nota; quedarse sin panel, no.
    if (error && /total/i.test(error.message) && /column|schema/i.test(error.message)) {
      console.warn('[asignarPedidos] sin columna `total` (¿falta la migración 033?), guardo sin el importe');
      const sinTotal = filas.map(({ total, ...resto }) => resto);
      ({ error } = await sb().from('hojas_ruta_pedidos').upsert(sinTotal, { onConflict: 'im_comprobante_id' }));
    }
    if (error) { res.status(500).json({ error: error.message }); return; }
    invalidarVista();
    res.json({
      ok: true, agregados: filas.length,
      sin_saldo: filas.filter(f => f.saldo_anterior == null).length,
      peso_recalculado: pesos.size === entrada.length,
    });
  } catch (err: any) {
    console.error('[asignarPedidos]', err?.message);
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/**
 * PUT /api/hojas-ruta/:id — cambia camión, transporte, turno, zona, estado u observaciones.
 *
 * 🔑 La decisión de qué camión va a cada reparto es de la oficina, no del algoritmo (Mati,
 * 07/09/2026: *"el criterio de cómo asignar los camiones tiene que seguir siendo una decisión
 * nuestra... por ahí quizás sí una sugerencia tuya"*). El sugeridor propone; acá se decide.
 */
export async function editarHoja(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  try {
    const b = req.body ?? {};
    const cambios: Record<string, any> = {};
    if ('turno' in b) cambios.turno = b.turno ? String(b.turno) : null;
    if ('transporte' in b) cambios.transporte = b.transporte ? String(b.transporte) : null;
    if ('camion_id' in b) cambios.camion_id = b.camion_id ? String(b.camion_id) : null;
    if ('observaciones' in b) cambios.observaciones = b.observaciones ? String(b.observaciones) : null;
    if ('cod_zona' in b) cambios.cod_zona = Number(b.cod_zona) > 0 ? Number(b.cod_zona) : null;
    if ('estado' in b) {
      const e = String(b.estado);
      if (!['abierta', 'cerrada', 'anulada'].includes(e)) { res.status(400).json({ error: 'Estado inválido' }); return; }
      cambios.estado = e;
    }
    if (!Object.keys(cambios).length) { res.status(400).json({ error: 'No mandaste nada para cambiar' }); return; }
    const { data, error } = await sb().from('hojas_ruta').update(cambios)
      .eq('id', String(req.params.id)).eq('tenant_id', TENANT_ID).select().maybeSingle();
    if (error) { res.status(500).json({ error: error.message }); return; }
    if (!data) { res.status(404).json({ error: 'Hoja de ruta no encontrada' }); return; }
    res.json({ ok: true, hoja: data });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/**
 * ¿Este pedido tiene comprobantes ya emitidos?
 *
 * 🔴 La fila de `hojas_ruta_pedidos` es el ÚNICO registro de qué factura salió de qué
 * presupuesto: facturar por API NO deja ese vínculo en InfoManager (probado el 07/09/2026).
 * Borrarla es perder el rastro — y un presupuesto que vuelve a "pendiente" es un presupuesto
 * que alguien factura por segunda vez.
 */
function tieneEmitido(p: any): boolean {
  return !!(p?.facturado_at || p?.im_factura_id || p?.im_factura_numero || p?.im_remito_id || p?.im_remito_numero);
}

/** DELETE /api/hojas-ruta/:id — borra una hoja vacía. Los pedidos vuelven a pendientes. */
export async function borrarHoja(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  const id = String(req.params.id);
  const { data: dentro } = await sb().from('hojas_ruta_pedidos')
    .select('im_numero, im_factura_numero, facturado_at, im_factura_id, im_remito_id, im_remito_numero').eq('hoja_id', id);
  const emitidos = (dentro ?? []).filter(tieneEmitido);
  if (emitidos.length) {
    res.status(409).json({
      error: `Esta hoja tiene ${emitidos.length} comprobante(s) ya emitidos en InfoManager (factura ${emitidos.map((p: any) => p.im_factura_numero ?? '—').join(', ')}). No se puede borrar: se perdería el registro de qué se facturó.`,
    });
    return;
  }
  // Los pedidos se sueltan primero: si se borrara la hoja con pedidos adentro, el cascade se
  // los llevaría y nadie sabría que esos comprobantes quedaron sin repartir.
  const { error: e1 } = await sb().from('hojas_ruta_pedidos').delete().eq('hoja_id', id);
  if (e1) { res.status(500).json({ error: e1.message }); return; }
  const { error } = await sb().from('hojas_ruta').delete().eq('id', id).eq('tenant_id', TENANT_ID);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ ok: true });
}

/** DELETE /api/hojas-ruta/pedidos/:comprobanteId — lo saca de la hoja y vuelve a pendientes. */
export async function quitarPedido(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  const comprobanteId = String(req.params.comprobanteId);
  const { data: fila } = await sb().from('hojas_ruta_pedidos')
    .select('im_numero, im_factura_numero, im_remito_numero, im_factura_id, im_remito_id, facturado_at')
    .eq('im_comprobante_id', comprobanteId).maybeSingle();
  if (tieneEmitido(fila)) {
    res.status(409).json({
      error: `Este pedido ya se facturó (factura ${(fila as any)?.im_factura_numero ?? '—'}${(fila as any)?.im_remito_numero ? `, remito ${(fila as any).im_remito_numero}` : ''}). No se puede sacar de la hoja: se perdería el registro de qué comprobante salió de este presupuesto.`,
    });
    return;
  }
  const { error } = await sb().from('hojas_ruta_pedidos')
    .delete().eq('im_comprobante_id', comprobanteId);
  if (error) { res.status(500).json({ error: error.message }); return; }
  invalidarVista();   // el pedido volvió a estar libre y la lista quedó vieja
  res.json({ ok: true });
}
