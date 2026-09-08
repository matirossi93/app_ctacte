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
  fechaArgentina, getDisponibleCliente,
} from './infomanager.js';
import { pesoDeRenglones, cargaDelCamion } from './pesoComprobante.js';
import { vistaDeRango, invalidarVista } from './vistaPresupuestos.js';
import { vistaRemitos, invalidarRemitos } from './vistaRemitos.js';
import { armarFraccionado, totalesFraccionado } from './fraccionado.js';
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
  /**
   * 🔄 Antes esto listaba PRESUPUESTOS. Mati (08/09/2026): *"la hoja de ruta debería armarse en
   * función a las facturas, que ese va a ser el definitivo de los comprobantes, el que manda
   * junto con el remito"*. Se eligió el REMITO porque es el papel que viaja con la mercadería:
   * medido contra IM, factura y remito van uno a uno salvo días sueltos (25 FA contra 29 RE el
   * 05/09), y en esos casos lo que sale en el camión es el remito.
   * 📌 Y no era un detalle: el 02/09 hubo 39 presupuestos contra 67 facturas. Todo lo que la
   * oficina factura directo, sin pedido previo, antes no aparecía en esta pantalla.
   */
  // 🪤 Mirar SÓLO la fecha exacta se perdía la mayoría de los pedidos: el 07/09/2026 había 225
  // presupuestos vigentes y el panel mostraba 59. La oficina MUEVE la fecha del comprobante
  // para reordenar despachos, así que un pedido fechado para el 10 existe desde antes.
  const desde = dias > 0
    ? fechaArgentina(new Date(fecha + 'T12:00:00Z').getTime() - dias * 864e5)
    : fecha;
  return vistaRemitos(desde, fecha, forzar);
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
    // 🔄 Cuenta REMITOS, igual que la pantalla: un remito de la semana pasada que no salió es
    // mercadería facturada esperando el camión, y ése es el aviso que importa.
    const previos = ventas.filter((v: any) =>
      String(v.tipo_comprobante ?? '').trim() === 'RE' &&
      String(v.anulada ?? '').trim().toUpperCase() !== 'S' &&
      String(v.fecha ?? '').slice(0, 10) !== fecha);
    const ids = previos.map((p: any) => String(p.id));
    // Los que ya están en una hoja no son arrastre: alguien se ocupó.
    const { data: asignados } = ids.length
      ? await sb().from('hojas_ruta_pedidos').select('im_comprobante_id').in('im_comprobante_id', ids.slice(0, 400))
      : { data: [] as any[] };
    const yaEn = new Set((asignados ?? []).map((a: any) => String(a.im_comprobante_id)));
    // Ni los que el cliente pasa a buscar: ésos tampoco esperan un camión.
    const { data: retiros } = ids.length
      ? await sb().from('retiros_sucursal').select('im_comprobante_id')
          .eq('tenant_id', TENANT_ID).in('im_comprobante_id', ids.slice(0, 400))
      : { data: [] as any[] };
    for (const r of retiros ?? []) yaEn.add(String((r as any).im_comprobante_id));
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
      .select('*, hojas_ruta_camiones(nombre, capacidad_kg), choferes(nombre), hojas_ruta_pedidos(*)')
      .eq('tenant_id', TENANT_ID).eq('fecha', fecha).order('numero');
    if (error) { res.status(500).json({ error: error.message }); return; }
    // 🔑 Lo emitido se cruza contra `presupuestos_facturados`, que es la fuente viva: los campos
    // copiados en `hojas_ruta_pedidos` son de cuando se armó la hoja, y si el pedido se facturó
    // DESPUÉS quedaban vacíos (auditoría del 08/09/2026).
    const idsEnHojas = (hojas ?? []).flatMap((h: any) => (h.hojas_ruta_pedidos ?? []).map((p: any) => String(p.im_comprobante_id)));
    const { data: emitidos } = idsEnHojas.length
      ? await sb().from('presupuestos_facturados')
          .select('im_comprobante_id, im_factura_numero, im_remito_id, im_remito_numero, facturado_at')
          .eq('tenant_id', TENANT_ID)
          .or(`im_comprobante_id.in.(${idsEnHojas.join(',')}),im_remito_id.in.(${idsEnHojas.join(',')})`)
      : { data: [] as any[] };
    // Por los dos caminos: hojas viejas armadas con presupuestos y nuevas armadas con remitos.
    const emitidoPor = new Map<string, any>();
    for (const e of emitidos ?? []) {
      emitidoPor.set(String((e as any).im_comprobante_id), e);
      if ((e as any).im_remito_id) emitidoPor.set(String((e as any).im_remito_id), e);
    }

    const conCarga = (hojas ?? []).map((h: any) => {
      const ps = (h.hojas_ruta_pedidos ?? []).map((p: any) => {
        const e = emitidoPor.get(String(p.im_comprobante_id));
        return e ? { ...p, im_factura_numero: e.im_factura_numero, im_remito_numero: e.im_remito_numero, facturado_at: e.facturado_at } : p;
      });
      const kg = ps.reduce((s: number, p: any) => s + Number(p.kg ?? 0), 0);
      const bultos = ps.reduce((s: number, p: any) => s + Number(p.bultos ?? 0), 0);
      const cap = h.hojas_ruta_camiones?.capacidad_kg;
      return {
        ...h,
        camion: h.hojas_ruta_camiones?.nombre ?? null,
        chofer: h.choferes?.nombre ?? null,
        // Se deriva de los pedidos: `hojas_ruta.facturada_at` quedó sin escritor cuando la
        // facturación se mudó de etapa.
        facturada: !!ps.length && ps.every((p: any) => p.facturado_at),
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
      .select('*, hojas_ruta_camiones(nombre, capacidad_kg), choferes(nombre), hojas_ruta_pedidos(*)')
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
        turno: (hoja as any).turno,
        // 🔑 Mati (08/09/2026): *"es el mismo dato: chofer y transportista"*. El chofer asignado
        // manda, porque es el que se liquida; `transporte` queda como texto libre para las hojas
        // viejas y para un flete de una sola vez que no está en la lista.
        transporte: (hoja as any).choferes?.nombre ?? (hoja as any).transporte,
        chofer: (hoja as any).choferes?.nombre ?? null,
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
 * 📌 LA FACTURACIÓN YA NO VIVE ACÁ. Se movió a `facturarPresupuestos.ts` (etapa 2) cuando Mati
 * corrigió el orden del circuito el 08/09/2026: se factura lo aprobado y **después**, con la
 * factura y el remito hechos, se arma la hoja. Cuando se factura, la hoja todavía no existe.
 */

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
    const { data: yaAsignados, error: errAsig } = await sb().from('hojas_ruta_pedidos')
      .select('im_comprobante_id, hoja_id, im_numero, hojas_ruta(numero, estado)').in('im_comprobante_id', ids);
    // Si no se puede consultar, no se asigna: el aviso de "ya está en otra hoja" es lo único que
    // evita que la misma mercadería salga en dos camiones.
    if (errAsig) { res.status(502).json({ error: `No pude verificar si esos pedidos ya están en otra hoja: ${errAsig.message}` }); return; }
    const enOtra = (yaAsignados ?? []).filter((a: any) => String(a.hoja_id) !== hojaId);

    /**
     * 🔴 Y tampoco entra a una hoja lo que el cliente pasa a buscar.
     *
     * `marcarRetiro` ya frenaba la dirección contraria ("ya está en una hoja → no lo marco"),
     * pero faltaba el espejo: se podía marcar un pedido como retiro y después mandarlo igual al
     * camión. Ese importe terminaba contado DOS VECES —en el acumulado mensual de retiros y en
     * la liquidación del chofer— además de cargar mercadería que el cliente ya se llevó.
     * Auditoría del 08/09/2026.
     */
    const { data: enRetiro, error: errRet } = await sb().from('retiros_sucursal')
      .select('im_comprobante_id, im_numero').eq('tenant_id', TENANT_ID).in('im_comprobante_id', ids);
    if (errRet) { res.status(502).json({ error: `No pude verificar si esos pedidos son retiro en sucursal: ${errRet.message}` }); return; }
    if ((enRetiro ?? []).length) {
      res.status(409).json({
        error: `Estos pedidos están marcados como RETIRO EN SUCURSAL (${(enRetiro ?? []).map((r: any) => r.im_numero ?? r.im_comprobante_id).join(', ')}): los pasa a buscar el cliente. Sacalos de Retiros si van a salir en el camión.`,
      });
      return;
    }

    // 🪤 `mover: true` reasigna la fila existente, así que se podía sacar un pedido de una hoja
    // CERRADA sin pasar por `quitarPedido`, que es donde vivía el guard. Una hoja cerrada ya se
    // liquidó: cambiarle la carga cambia el pago del chofer.
    const desdeCerrada = enOtra.filter((a: any) => estaCerrada(a.hojas_ruta));
    if (desdeCerrada.length) {
      res.status(409).json({
        error: `Estos pedidos están en hojas CERRADAS (${[...new Set(desdeCerrada.map((a: any) => a.hojas_ruta?.numero))].join(', ')}): ya se liquidaron. Reabrí la hoja si de verdad hay que moverlos.`,
      });
      return;
    }

    // 🪤 Y tampoco se mueve un pedido que ya tiene una nota de crédito emitida: el ajuste está
    // atado a la hoja donde se cargó, así que al chofer viejo se le seguiría descontando y al
    // nuevo no. Se saca de la hoja primero, se mueve, y se vuelve a cargar la diferencia.
    if (enOtra.length) {
      const { data: conAjuste, error: errAj } = await sb().from('hojas_ruta_ajustes')
        .select('im_comprobante_id').eq('tenant_id', TENANT_ID)
        .in('im_comprobante_id', enOtra.map((a: any) => String(a.im_comprobante_id)))
        .not('emitido_at', 'is', null);
      if (errAj) { res.status(502).json({ error: `No pude verificar si tienen notas de crédito: ${errAj.message}` }); return; }
      if ((conAjuste ?? []).length) {
        res.status(409).json({
          error: `Estos pedidos ya tienen notas de crédito cargadas en su hoja actual y no se pueden mover: el descuento quedaría en la hoja equivocada y le cambiaría el pago al chofer.`,
        });
        return;
      }
    }
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

    // 🔑 Lo que ya se facturó (etapa 2) viaja con el pedido: la hoja de ruta lleva el REMITO,
    // no el presupuesto, y ese vínculo sólo existe de nuestro lado. Sin esto, un pedido
    // facturado entraría en la hoja como si no lo estuviera y alguien lo facturaría de nuevo.
    // 🔄 Se busca por los DOS caminos: `im_comprobante_id` para las hojas armadas con
    // presupuestos (las anteriores al 08/09/2026) e `im_remito_id` para las de ahora, que se
    // arman con el remito. La fila que gana es la misma; sólo cambia por dónde se la encuentra.
    const { data: emitidos, error: errEmitidos } = await sb().from('presupuestos_facturados')
      .select('im_comprobante_id, im_factura_id, im_factura_numero, im_remito_id, im_remito_numero, facturado_at')
      .eq('tenant_id', TENANT_ID).or(`im_comprobante_id.in.(${ids.join(',')}),im_remito_id.in.(${ids.join(',')})`);
    // Sin esto la hoja se armaría sin los comprobantes emitidos y se imprimiría sin el remito.
    if (errEmitidos) { res.status(502).json({ error: `No pude leer qué comprobantes se emitieron: ${errEmitidos.message}` }); return; }
    const facturado = new Map<string, any>();
    for (const e of emitidos ?? []) {
      facturado.set(String((e as any).im_comprobante_id), e);
      if ((e as any).im_remito_id) facturado.set(String((e as any).im_remito_id), e);
    }

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
      const emitido = facturado.get(String(p.im_comprobante_id));
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
        // 🪤 TODAS las filas llevan las mismas claves, aunque vayan en null. En un upsert de
        // array, postgrest manda la UNIÓN de las claves de todas las filas y completa con NULL
        // las que falten: con claves distintas por fila, un pedido que ya tenía su remito
        // copiado se pisaba con NULL al reasignarlo (auditoría del 08/09/2026).
        /**
         * 🔑 Desde que la hoja se arma con remitos, el comprobante que llega YA ES el remito: no
         * hay que ir a buscarlo a ningún lado. La factura viene de `presupuestos_facturados`
         * cuando la emitimos nosotros, y si no, del apareo que hizo la vista (`aparearFactura`),
         * que es informativo — el importe de la hoja sale del remito, que es lo que viaja.
         */
        im_factura_id: emitido?.im_factura_id ?? (p.im_factura_id ? String(p.im_factura_id) : null),
        im_factura_numero: emitido?.im_factura_numero ?? (p.im_factura_numero != null ? Number(p.im_factura_numero) : null),
        im_remito_id: emitido?.im_remito_id ?? (p.tipo === 'RE' ? String(p.im_comprobante_id) : null),
        im_remito_numero: emitido?.im_remito_numero
          ?? (p.tipo === 'RE' && p.im_numero != null ? Number(p.im_numero) : null),
        facturado_at: emitido?.facturado_at ?? (p.tipo === 'RE' ? new Date().toISOString() : null),
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
    invalidarVista(); invalidarRemitos();
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
    // 🔑 El chofer es el dato del que sale el pago: se le liquida por el importe que entregó.
    if ('chofer_id' in b) cambios.chofer_id = b.chofer_id ? String(b.chofer_id) : null;
    if ('estado' in b) {
      const e = String(b.estado);
      if (!['abierta', 'cerrada', 'anulada'].includes(e)) { res.status(400).json({ error: 'Estado inválido' }); return; }
      cambios.estado = e;
      // Cerrar una hoja es decir "esto ya se entregó": queda quién y cuándo, porque a partir de
      // ahí entra en la liquidación del mes. Al reabrirla se limpia.
      cambios.cerrada_at = e === 'cerrada' ? new Date().toISOString() : null;
      cambios.cerrada_por = e === 'cerrada' ? (req.user?.sub ?? null) : null;
    }
    if (!Object.keys(cambios).length) { res.status(400).json({ error: 'No mandaste nada para cambiar' }); return; }

    /**
     * 🔴 Una hoja cerrada ya se liquidó. Cambiarle el chofer movería el importe ENTERO de la
     * hoja de un chofer a otro sin dejar rastro (`cerrada_at`/`cerrada_por` no se tocan), y el
     * camión, el turno o la zona cambiarían un papel que ya se firmó. Era el último guard de
     * "cerrada" que faltaba del lado del server — el front lo tapaba deshabilitando los selects,
     * pero eso es estado que puede estar viejo (dos personas, dos pestañas). Auditoría 08/09/2026.
     *
     * 🔑 Lo ÚNICO que se acepta sobre una hoja cerrada es reabrirla: si no, quedaría trabada.
     */
    const soloElEstado = Object.keys(cambios).every(k => k === 'estado' || k === 'cerrada_at' || k === 'cerrada_por');
    if (!soloElEstado) {
      const { data: actual, error: errActual } = await sb().from('hojas_ruta')
        .select('numero, estado').eq('id', String(req.params.id)).eq('tenant_id', TENANT_ID).maybeSingle();
      // 🪤 Fallar abierto acá sería editar una hoja ya pagada porque la consulta se cayó.
      if (errActual) { res.status(502).json({ error: `No pude verificar si la hoja está cerrada: ${errActual.message}` }); return; }
      if (!actual) { res.status(404).json({ error: 'Hoja de ruta no encontrada' }); return; }
      if (String((actual as any).estado) === 'cerrada') {
        res.status(409).json({
          error: `La hoja ${(actual as any).numero} está cerrada: ya entró en la liquidación del chofer. Reabrila si de verdad hay que cambiarla.`,
        });
        return;
      }
    }

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
 * ¿La hoja ya está cerrada?
 *
 * 🔄 Esto ANTES bloqueaba sacar cualquier pedido con comprobantes emitidos, porque la fila de
 * `hojas_ruta_pedidos` era el único registro de qué factura salió de qué presupuesto. Desde que
 * la facturación se mudó a su etapa (migración 035), ese registro vive en
 * `presupuestos_facturados` y **sobrevive al borrado de la fila de la hoja**: sacar un pedido ya
 * no pierde nada. Con el guard viejo, en cambio, la hoja quedaba inutilizable — en el circuito
 * nuevo TODO lo que entra a una hoja está facturado (auditoría del 08/09/2026).
 *
 * Lo que sí no se toca es una hoja **cerrada**: ésa ya volvió del reparto y es la base de la
 * liquidación del chofer.
 */
function estaCerrada(hoja: any): boolean {
  return String(hoja?.estado ?? '') === 'cerrada';
}

/** DELETE /api/hojas-ruta/:id — borra una hoja vacía. Los pedidos vuelven a pendientes. */
export async function borrarHoja(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  const id = String(req.params.id);
  const { data: hoja } = await sb().from('hojas_ruta')
    .select('numero, estado').eq('id', id).eq('tenant_id', TENANT_ID).maybeSingle();
  if (!hoja) { res.status(404).json({ error: 'Hoja de ruta no encontrada' }); return; }
  // Una hoja cerrada ya volvió del reparto y es la base de la liquidación del chofer.
  if (estaCerrada(hoja)) {
    res.status(409).json({ error: `La hoja ${(hoja as any).numero} está cerrada: es la base de la liquidación del chofer y no se borra. Reabrila si de verdad hay que cambiarla.` });
    return;
  }
  // 🔴 Los ajustes cuelgan de la hoja con `on delete cascade`: borrarla se llevaría notas de
  // crédito YA EMITIDAS en InfoManager, que es el único registro de a qué factura corresponden.
  const { data: ajustes, error: errAj } = await sb().from('hojas_ruta_ajustes')
    .select('im_ajuste_numero').eq('tenant_id', TENANT_ID).eq('hoja_id', id)
    .not('emitido_at', 'is', null);
  if (errAj) { res.status(502).json({ error: `No pude verificar las notas de crédito de la hoja: ${errAj.message}` }); return; }
  if ((ajustes ?? []).length) {
    res.status(409).json({
      error: `Esta hoja tiene ${(ajustes ?? []).length} nota(s) de crédito emitidas (${(ajustes ?? []).map((a: any) => a.im_ajuste_numero ?? '—').join(', ')}). No se puede borrar: se perdería el registro de a qué factura corresponden.`,
    });
    return;
  }

  // Los pedidos se sueltan primero: si se borrara la hoja con pedidos adentro, el cascade se
  // los llevaría y nadie sabría que esos comprobantes quedaron sin repartir.
  // 📌 Lo facturado NO se pierde: vive en `presupuestos_facturados`, que no se toca acá.
  const { error: e1 } = await sb().from('hojas_ruta_pedidos').delete().eq('hoja_id', id);
  if (e1) { res.status(500).json({ error: e1.message }); return; }
  const { error } = await sb().from('hojas_ruta').delete().eq('id', id).eq('tenant_id', TENANT_ID);
  if (error) { res.status(500).json({ error: error.message }); return; }
  invalidarVista(); invalidarRemitos();   // los pedidos volvieron a estar libres
  res.json({ ok: true });
}

/** DELETE /api/hojas-ruta/pedidos/:comprobanteId — lo saca de la hoja y vuelve a pendientes. */
export async function quitarPedido(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  const comprobanteId = String(req.params.comprobanteId);
  // Sólo se frena si la hoja está cerrada: sacar un pedido de una hoja abierta es normal, y el
  // registro de lo facturado vive en otra tabla que no se toca.
  const { data: fila, error: errFila } = await sb().from('hojas_ruta_pedidos')
    .select('hoja_id, im_numero, hojas_ruta(numero, estado)')
    .eq('im_comprobante_id', comprobanteId).maybeSingle();
  // 🪤 Sin esto el guard fallaba ABIERTO: si la consulta se caía, `fila` venía null, la hoja
  // parecía abierta y se borraba el pedido de una hoja ya liquidada.
  if (errFila) { res.status(502).json({ error: `No pude verificar el estado de la hoja: ${errFila.message}` }); return; }
  if (estaCerrada((fila as any)?.hojas_ruta)) {
    res.status(409).json({
      error: `La hoja ${(fila as any)?.hojas_ruta?.numero ?? ''} está cerrada: ya se liquidó. Reabrila antes de sacarle pedidos.`,
    });
    return;
  }
  // Con una nota de crédito emitida, sacarlo dejaría el descuento colgado de una hoja que ya no
  // lo lleva.
  const { data: ajuste, error: errAjuste } = await sb().from('hojas_ruta_ajustes')
    .select('im_ajuste_numero').eq('tenant_id', TENANT_ID).eq('im_comprobante_id', comprobanteId)
    .not('emitido_at', 'is', null).limit(1);
  if (errAjuste) { res.status(502).json({ error: `No pude verificar si tiene notas de crédito: ${errAjuste.message}` }); return; }
  if ((ajuste ?? []).length) {
    res.status(409).json({
      error: `Este pedido tiene una nota de crédito emitida (${(ajuste ?? [])[0]?.im_ajuste_numero ?? '—'}) cargada en esta hoja. Borrá el ajuste antes de sacarlo, o anulá la NC en InfoManager.`,
    });
    return;
  }
  const { error } = await sb().from('hojas_ruta_pedidos')
    .delete().eq('im_comprobante_id', comprobanteId);
  if (error) { res.status(500).json({ error: error.message }); return; }
  invalidarVista(); invalidarRemitos();   // el pedido volvió a estar libre y la lista quedó vieja
  res.json({ ok: true });
}
