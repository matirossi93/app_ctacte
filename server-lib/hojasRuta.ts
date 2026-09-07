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
  fechaArgentina, getDisponibleCliente, desconfirmarPresupuesto,
} from './infomanager.js';
import { pesoDeRenglones, cargaDelCamion } from './pesoComprobante.js';
import { zonaDeCliente } from './zonaCliente.js';
import { emitirFactura, emitirRemito, letraDeFactura, proximoNumeroFactura } from './facturarIM.js';
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
    const armado = await armarVistaDelDia(fecha, dias);
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
async function armarVistaDelDia(fecha: string, dias = 0) {
  {
    // 🪤 Esto miraba SÓLO la fecha exacta y se perdía la mayoría de los pedidos. Medido el
    // 07/09/2026: había 225 presupuestos vigentes y el panel mostraba 59. Los otros 166 eran
    // de días anteriores sin facturar y de días futuros — porque la oficina MUEVE la fecha del
    // comprobante para reordenar los despachos, así que un pedido fechado para el 10 existe
    // desde antes. Un pedido que no aparece en la pantalla no entra en ninguna hoja y nadie
    // se entera hasta que llama el cliente.
    const desde = dias > 0
      ? fechaArgentina(new Date(fecha + 'T12:00:00Z').getTime() - dias * 864e5)
      : fecha;
    const [ventas, cat, clientes] = await Promise.all([
      fetchVentas(desde, fecha),
      fetchArticulosCatalogo(),
      fetchClientesIMCached().catch(() => []),
    ]);

    const porCliente = new Map(clientes.map((c: any) => [Number(c.cod_cliente), c]));

    const presupuestos = ventas.filter((v: any) =>
      String(v.tipo_comprobante ?? '').trim() === 'PR' &&
      String(v.anulada ?? '').trim().toUpperCase() !== 'S');

    // 🪤 Los renglones NO se piden por toda la ventana. Medido contra IM el 07/09/2026:
    //   `/ventas/items` de 15 días -> 57.385 items en 23,7 s
    //   `/ventas/items` de 1 día   ->  4.132 items en  1,2 s
    // Con 23,7 s la request se pasa del timeout del proxy y el panel abría VACÍO. Se piden
    // sólo los días que de verdad tienen presupuestos vigentes (suelen ser un puñado), y de
    // a cuatro en paralelo para no golpear a IM.
    const fechasConPedidos = [...new Set(presupuestos
      .map((p: any) => String(p.fecha ?? '').slice(0, 10))
      .filter(Boolean))].sort().slice(-MAX_DIAS_ITEMS);
    const renglones = new Map<string, Array<{ cantidad: any; equivalencia_um: number | null | undefined }>>();
    for (let i = 0; i < fechasConPedidos.length; i += 4) {
      const tanda = fechasConPedidos.slice(i, i + 4);
      const resultados = await Promise.all(tanda.map(f =>
        fetchVentasItems(f, f).catch((e: any) => {
          // Sin los renglones de un día, esos pedidos salen con 0 kg. Es mejor que no abrir.
          console.warn(`[hojasRuta] sin items del ${f}:`, e?.message);
          return [] as any[];
        })));
      for (const items of resultados) {
        for (const it of items) {
          const k = String((it as any).id_comprobante);
          if (!renglones.has(k)) renglones.set(k, []);
          renglones.get(k)!.push({
            cantidad: (it as any).cantidad,
            equivalencia_um: cat.get(Number((it as any).cod_articulo))?.equivalencia_um,
          });
        }
      }
    }

    // Lo que aporta la app sobre los pedidos que salieron de ella: los avisos del control de
    // listas, que es lo que le dice a la oficina DÓNDE mirar en vez de revisar todo.
    const ids = presupuestos.map((p: any) => String(p.id));
    const { data: nuestros } = await sb().from('pedidos_vendedor')
      .select('id, im_presupuesto_id, cod_vendedor, estado, im_error')
      .eq('tenant_id', TENANT_ID).in('im_presupuesto_id', ids);
    const mio = new Map((nuestros ?? []).map((p: any) => [String(p.im_presupuesto_id), p]));
    const { data: avisos } = await sb().from('pedidos_vendedor_items')
      .select('pedido_id, aviso_lista, lista_sugerida, cod_lista_precios')
      .in('pedido_id', (nuestros ?? []).map((p: any) => p.id))
      .not('aviso_lista', 'is', null);
    const avisosPorPedido = new Map<string, string[]>();
    // 🔑 Los avisos NO son todos iguales y mezclarlos hace que no se mire ninguno: el 07/09
    // había 36 pedidos marcados sobre 59, y así "revisar" deja de querer decir algo.
    // Las listas de IM van de más cara a más barata según el número (12=L1 … 15=L4), así que
    // comparando la lista puesta contra la sugerida se sabe para qué lado está el error:
    //   puesta > sugerida  -> más barata de lo que corresponde  -> PIERDE MARGEN la empresa
    //   puesta < sugerida  -> más cara                          -> le cobran de más al cliente
    // Se clasifica con los CÓDIGOS y no leyendo el texto del aviso, que puede cambiar.
    const gravedadPorPedido = new Map<string, { pierde_margen: number; cobra_de_mas: number }>();
    for (const a of avisos ?? []) {
      const k = String((a as any).pedido_id);
      if (!avisosPorPedido.has(k)) avisosPorPedido.set(k, []);
      avisosPorPedido.get(k)!.push(String((a as any).aviso_lista));
      const g = gravedadPorPedido.get(k) ?? { pierde_margen: 0, cobra_de_mas: 0 };
      const puesta = Number((a as any).cod_lista_precios);
      const sugerida = Number((a as any).lista_sugerida);
      if (Number.isFinite(puesta) && Number.isFinite(sugerida) && sugerida > 0) {
        if (puesta > sugerida) g.pierde_margen += 1;
        else if (puesta < sugerida) g.cobra_de_mas += 1;
      }
      gravedadPorPedido.set(k, g);
    }

    // Dónde está ya asignado cada comprobante.
    const { data: asignados } = await sb().from('hojas_ruta_pedidos')
      .select('im_comprobante_id, hoja_id').in('im_comprobante_id', ids);
    const enHoja = new Map((asignados ?? []).map((a: any) => [String(a.im_comprobante_id), String(a.hoja_id)]));

    const filas = presupuestos.map((p: any) => {
      const c = porCliente.get(Number(p.cod_cliente));
      const z = zonaDeCliente(c);
      const peso = pesoDeRenglones(renglones.get(String(p.id)) ?? []);
      const propio = mio.get(String(p.id));
      return {
        im_comprobante_id: String(p.id),
        im_numero: p.numero ?? null,
        fecha: p.fecha ?? null,
        // Un pedido de un día anterior que sigue vigente es arrastre: se quedó sin salir.
        // Se marca para que salte a la vista y no se mezcle con los del día.
        de_otro_dia: String(p.fecha ?? '').slice(0, 10) !== fecha,
        cod_cliente: Number(p.cod_cliente),
        cliente_nombre: c?.razon_social ?? c?.nombre ?? `Cliente ${p.cod_cliente}`,
        cod_zona: z.cod_zona,
        zona: z.nombre,
        zona_origen: z.origen,
        total: Number(p.total ?? 0),
        bultos: peso.bultos,
        kg: peso.kg,
        // Si son muchos, el total de kilos miente POR ABAJO y la hoja puede sobrecargar.
        renglones_sin_peso: peso.renglones_sin_peso,
        de_la_app: !!propio,
        pedido_id: propio?.id ?? null,
        cod_vendedor: propio?.cod_vendedor ?? p.cod_vendedor ?? null,
        avisos: propio ? (avisosPorPedido.get(String(propio.id)) ?? []) : [],
        // Para qué lado está el error de lista, que es lo que decide si urge mirarlo.
        gravedad: propio ? (gravedadPorPedido.get(String(propio.id)) ?? { pierde_margen: 0, cobra_de_mas: 0 }) : { pierde_margen: 0, cobra_de_mas: 0 },
        im_error: propio?.im_error ?? null,
        hoja_id: enHoja.get(String(p.id)) ?? null,
      };
    });

    return {
      pendientes: filas.filter(f => !f.hoja_id),
      asignados: filas.filter(f => f.hoja_id),
      // Para que la pantalla pueda mostrar "3 pedidos para revisar" sin recorrer todo.
      con_avisos: filas.filter(f => f.avisos.length > 0).length,
      // Los dos números que de verdad importan, separados: uno es plata que se pierde, el
      // otro es un cliente al que le están cobrando de más.
      pierde_margen: filas.filter(f => f.gravedad.pierde_margen > 0).length,
      cobra_de_mas: filas.filter(f => f.gravedad.cobra_de_mas > 0).length,
      sin_zona: filas.filter(f => f.cod_zona == null).length,
      de_otros_dias: filas.filter(f => f.de_otro_dia && !f.hoja_id).length,
    };
  }
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
    const esKilo = (u: unknown) => /^(kg|kilo|kilos|kilogramo|kilogramos)$/i.test(String(u ?? '').trim());
    const fraccionado: Array<{ descripcion: string; cantidades: number[]; paquetes: number; kg: number }> = [];
    try {
      const cat = await fetchArticulosCatalogo();
      const ids = new Set(pedidos.map((p: any) => String(p.im_comprobante_id)));
      const dias = [...new Set(pedidos.map((p: any) => String((hoja as any).fecha).slice(0, 10)))];
      const porProducto = new Map<string, number[]>();
      for (const f of dias.slice(0, 6)) {
        for (const it of await fetchVentasItems(f, f).catch(() => [] as any[])) {
          if (!ids.has(String((it as any).id_comprobante))) continue;
          const a = cat.get(Number((it as any).cod_articulo));
          const cant = Number((it as any).cantidad);
          if (!a || !esKilo(a.unidad_de_medida) || !(cant > 0)) continue;
          if (!porProducto.has(a.descripcion)) porProducto.set(a.descripcion, []);
          porProducto.get(a.descripcion)!.push(cant);
        }
      }
      for (const [descripcion, cantidades] of [...porProducto.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const l = cantidades.slice().sort((a, b) => b - a);
        fraccionado.push({
          descripcion, cantidades: l, paquetes: l.length,
          kg: Math.round(l.reduce((s, x) => s + x, 0) * 100) / 100,
        });
      }
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
      fraccionado_totales: {
        productos: fraccionado.length,
        paquetes: fraccionado.reduce((s, f) => s + f.paquetes, 0),
        kg: Math.round(fraccionado.reduce((s, f) => s + f.kg, 0) * 100) / 100,
      },
      sin_saldo: [...porCliente.values()].filter((c: any) => c.saldo_anterior == null).length,
    });
  } catch (err: any) {
    console.error('[impresionHoja]', err?.message);
    res.status(500).json({ error: err?.message ?? 'error' });
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
 *  · **Lo ya facturado se saltea**, aunque venga en el pedido.
 *
 * 🪤 Facturar por API NO vincula el comprobante con el presupuesto (probado el 07/09/2026):
 * la relación la guardamos nosotros, y al final se **desconfirma el presupuesto** para que no
 * quede en la ventana de facturación de la oficina y alguien lo facture de nuevo.
 */
export async function facturarHoja(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  try {
    const hojaId = String(req.params.id);
    const { data: hoja } = await sb().from('hojas_ruta')
      .select('*, hojas_ruta_pedidos(*)').eq('id', hojaId).eq('tenant_id', TENANT_ID).maybeSingle();
    if (!hoja) { res.status(404).json({ error: 'Hoja de ruta no encontrada' }); return; }

    const todos = (hoja as any).hojas_ruta_pedidos ?? [];
    // Se puede facturar la hoja entera o sólo algunos comprobantes.
    const pedidos = Array.isArray(req.body?.im_comprobante_ids) && req.body.im_comprobante_ids.length
      ? todos.filter((p: any) => req.body.im_comprobante_ids.includes(String(p.im_comprobante_id)))
      : todos;
    const pendientes = pedidos.filter((p: any) => !p.facturado_at);
    if (!pendientes.length) { res.status(409).json({ error: 'No hay pedidos sin facturar en esta hoja.' }); return; }

    const [cat, clientes] = await Promise.all([
      fetchArticulosCatalogo(),
      fetchClientesIMCached().catch(() => [] as any[]),
    ]);
    const porCliente = new Map(clientes.map((c: any) => [Number(c.cod_cliente), c]));
    const usuario = await usuarioIM(req.user);

    // Los renglones de cada comprobante, para poder facturarlos.
    const dia = String((hoja as any).fecha).slice(0, 10);
    const renglonesPorComp = new Map<string, any[]>();
    for (const it of await fetchVentasItems(dia, dia).catch(() => [] as any[])) {
      const k = String((it as any).id_comprobante);
      if (!renglonesPorComp.has(k)) renglonesPorComp.set(k, []);
      renglonesPorComp.get(k)!.push(it);
    }

    const hechos: any[] = [];
    const fallados: any[] = [];
    let cortado: string | null = null;

    // 🔑 El número de factura se calcula UNA vez por hoja y después se incrementa: IM no lo
    // asigna, y averiguarlo cuesta ~6 s de consulta a IM cada vez. Si otro lo tomó mientras
    // tanto, `emitirFactura` reintenta con el siguiente.
    const numeros: Record<string, number | null> = { A: null, B: null };
    for (const letra of ['A', 'B'] as const) {
      const loNecesita = pendientes.some((p: any) => letraDeFactura(porCliente.get(Number(p.cod_cliente))?.categoria_iva) === letra);
      if (loNecesita) numeros[letra] = await proximoNumeroFactura(letra, Number(process.env.IM_PTO_VENTA_FACTURA || 777));
    }

    for (const p of pendientes) {
      if (cortado) break;
      const cliente = porCliente.get(Number(p.cod_cliente));
      const items = renglonesPorComp.get(String(p.im_comprobante_id)) ?? [];
      const quien = `${p.cliente_nombre ?? 'cliente ' + p.cod_cliente} (PR ${p.im_numero ?? p.im_comprobante_id})`;

      if (!items.length) { fallados.push({ ...p, motivo: `No pude traer los renglones del ${quien}.` }); continue; }
      if (!letraDeFactura(cliente?.categoria_iva)) {
        fallados.push({ ...p, motivo: `${quien}: no se sabe qué letra de factura le corresponde (condición de IVA: ${cliente?.categoria_iva ?? 'sin cargar'}). Facturalo a mano.` });
        continue;
      }

      const datos = {
        cod_empresa: Number((hoja as any).cod_empresa) || PEDIDO_EMPRESA_DEFAULT,
        cod_cliente: Number(p.cod_cliente),
        cod_vendedor: Number(items[0]?.cod_vendedor ?? 0) || 1,
        categoria_iva: cliente?.categoria_iva,
        cod_lista_precios: Number(items[0]?.cod_lista_precios) || PEDIDO_LISTA_FALLBACK,
        usuario,
        observaciones: `Pedido ${p.im_numero ?? ''} · hoja ${(hoja as any).numero}`,
        origen_id: p.im_comprobante_id,
        total: Number(p.total ?? 0),
        cod_deposito: 1,
        items: items.map((it: any) => ({
          cod_articulo: Number(it.cod_articulo), cantidad: Number(it.cantidad),
          precio: Number(it.precio ?? 0), iva_por: Number(it.iva_por ?? 0),
          cod_lista_precios: it.cod_lista_precios != null ? Number(it.cod_lista_precios) : null,
          descuento_porc: it.descuento_porc ? Number(it.descuento_porc) : null,
        })),
      };

      // 1) FACTURA
      const letra = letraDeFactura(cliente?.categoria_iva)!;
      const fa = await emitirFactura({ ...datos, numero: numeros[letra] } as any);
      // El siguiente de este talonario, para no volver a consultarlo.
      if (fa.ok && fa.numero != null) numeros[letra] = Number(fa.numero) + 1;
      if (!fa.ok) {
        fallados.push({ ...p, motivo: `${quien}: ${fa.error}` });
        // 🔴 Sin respuesta = NO se sabe si la factura salió. Se corta acá: seguir sería
        // arriesgarse a facturar dos veces al resto si IM está a medio camino.
        if (fa.sinRespuesta) cortado = `InfoManager no contestó al facturar ${quien}. NO se sabe si la factura se emitió: verificalo en IM antes de volver a intentar. Se frenó el resto de la hoja.`;
        continue;
      }
      // Se guarda ANTES de seguir: un comprobante emitido sin registrar se vuelve a emitir.
      await sb().from('hojas_ruta_pedidos')
        .update({ im_factura_id: fa.id, im_factura_numero: fa.numero }).eq('id', p.id);

      // 2) REMITO
      const re = await emitirRemito(datos as any);
      if (!re.ok) {
        fallados.push({ ...p, motivo: `${quien}: la FACTURA ${fa.numero} se emitió, pero el remito falló (${re.error}). Hacé el remito a mano.` });
        if (re.sinRespuesta) cortado = `InfoManager no contestó al emitir el remito de ${quien}. La factura ${fa.numero} SÍ se emitió. Revisalo en IM. Se frenó el resto.`;
        continue;
      }
      await sb().from('hojas_ruta_pedidos').update({
        im_remito_id: re.id, im_remito_numero: re.numero, facturado_at: new Date().toISOString(),
      }).eq('id', p.id);

      // 3) El presupuesto sale de la ventana de facturación de la oficina.
      const desc = await desconfirmarPresupuesto(p.im_comprobante_id);
      if (!desc.ok) console.warn(`[facturarHoja] no pude desconfirmar el PR ${p.im_numero}:`, desc.error);

      // 4) Si el pedido vino de la app, queda marcado también ahí.
      if (p.pedido_id) {
        await sb().from('pedidos_vendedor').update({ estado: 'facturado' }).eq('id', p.pedido_id);
      }
      hechos.push({ cliente: p.cliente_nombre, factura: fa.numero, remito: re.numero, tipo: fa.tipo });
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
      fallados: fallados.map((f: any) => f.motivo),
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

/** DELETE /api/hojas-ruta/:id — borra una hoja vacía. Los pedidos vuelven a pendientes. */
export async function borrarHoja(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  const id = String(req.params.id);
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
  const { error } = await sb().from('hojas_ruta_pedidos')
    .delete().eq('im_comprobante_id', String(req.params.comprobanteId));
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ ok: true });
}
