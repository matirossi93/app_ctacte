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
import { zonaDeCliente } from './zonaCliente.js';
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
    const armado = await armarVistaDelDia(fecha);
    res.json({ ok: true, fecha, ...armado });
  } catch (err: any) {
    console.error('[pendientesDelDia]', err?.message);
    res.status(502).json({ error: `No se pudieron traer los pedidos del día: ${err?.message ?? 'sin respuesta de IM'}` });
  }
}

/** Lo que se muestra del día. Separado del handler para que el sugeridor lo reuse. */
async function armarVistaDelDia(fecha: string) {
  {
    // 🪤 Esto miraba SÓLO la fecha exacta y se perdía la mayoría de los pedidos. Medido el
    // 07/09/2026: había 225 presupuestos vigentes y el panel mostraba 59. Los otros 166 eran
    // de días anteriores sin facturar y de días futuros — porque la oficina MUEVE la fecha del
    // comprobante para reordenar los despachos, así que un pedido fechado para el 10 existe
    // desde antes. Un pedido que no aparece en la pantalla no entra en ninguna hoja y nadie
    // se entera hasta que llama el cliente.
    // Se mira una ventana: desde 15 días atrás (lo viejo vigente) hasta la fecha elegida.
    const desde = fechaArgentina(new Date(fecha + 'T12:00:00Z').getTime() - VENTANA_DIAS * 864e5);
    const [ventas, items, cat, clientes] = await Promise.all([
      fetchVentas(desde, fecha),
      fetchVentasItems(desde, fecha),
      fetchArticulosCatalogo(),
      fetchClientesIMCached().catch(() => []),
    ]);

    const porCliente = new Map(clientes.map((c: any) => [Number(c.cod_cliente), c]));
    // Renglones agrupados por comprobante, para pesar sin más llamadas.
    const renglones = new Map<string, Array<{ cantidad: any; equivalencia_um: number | null | undefined }>>();
    for (const it of items) {
      const k = String((it as any).id_comprobante);
      if (!renglones.has(k)) renglones.set(k, []);
      renglones.get(k)!.push({
        cantidad: (it as any).cantidad,
        equivalencia_um: cat.get(Number((it as any).cod_articulo))?.equivalencia_um,
      });
    }

    const presupuestos = ventas.filter((v: any) =>
      String(v.tipo_comprobante ?? '').trim() === 'PR' &&
      String(v.anulada ?? '').trim().toUpperCase() !== 'S');

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
      armarVistaDelDia(fecha),
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
      const desde = fechaArgentina(new Date(String(hoja.fecha) + 'T12:00:00Z').getTime() - VENTANA_DIAS * 864e5);
      for (const it of await fetchVentasItems(desde, String(hoja.fecha))) {
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
      };
    });
    const { error } = await sb().from('hojas_ruta_pedidos').upsert(filas, { onConflict: 'im_comprobante_id' });
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
