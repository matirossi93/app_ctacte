import { itemsPorFechas } from './itemsRango.js';
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
  fechaArgentina, comprobantesPendientesCliente,
} from './infomanager.js';
import { pesoDeRenglones, cargaDelCamion } from './pesoComprobante.js';
import { vistaDeRango, invalidarVista } from './vistaPresupuestos.js';
import { vistaRemitos, invalidarRemitos } from './vistaRemitos.js';
import { armarFraccionado, totalesFraccionado } from './fraccionado.js';
import { formatosDeBolsa } from './formatosBolsa.js';
import { sugerirRepartos } from './sugerirRepartos.js';
import { saldoAnteriorDeLaHoja, ajusteDeNotas } from './saldoCliente.js';
import { ErrorReparto, emitidosDe, mutarReparto, verificarEntregas, enriquecerEntregas, enriquecerHojas, aplicarImportesCierre, notasDeHoja, notasUnicas } from './repartoDatos.js';
import { proximoNumeroHoja } from './numeroHojaRuta.js';

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
 * Tope del rango de la hoja de ruta. Mismo criterio que la etapa 1: cada día que se agrega es
 * una consulta más de renglones contra IM, así que un rango sin techo cuelga la pantalla.
 */
const MAX_RANGO_DIAS = 31;
/** Cuántas hojas trae el histórico. Cada una viene con todos sus pedidos: no puede ser infinito. */
const MAX_HOJAS_HISTORICO = 200;

/**
 * `?desde=&hasta=` — el rango que se está mirando.
 *
 * 🔑 Mati (09/09/2026): *"en la parte de hoja de ruta también el selector de fecha tiene que ser
 * por rango"*. Antes esta pantalla trabajaba por DÍA (`?fecha=`) con un `?dias=N` para estirar
 * hacia atrás; las otras tres etapas ya iban por rango y el rango del header no llegaba acá.
 *
 * 🪤 Se siguen aceptando `fecha` y `dias`: los usa el sugeridor y cualquier pantalla vieja que
 * haya quedado abierta. Si vienen los dos, gana el rango explícito.
 */
export function rangoPedido(req: Request): { desde: string; hasta: string } {
  const ok = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : null);
  const q: any = req.query ?? {};
  const hasta = ok(q.hasta) ?? ok(q.fecha) ?? fechaArgentina();
  // Sin `desde`, se respeta el `?dias=N` de siempre (0 = sólo ese día).
  const dias = Math.min(Math.max(Number(q.dias) || 0, 0), VENTANA_DIAS);
  let desde = ok(q.desde)
    ?? (dias > 0 ? fechaArgentina(new Date(hasta + 'T12:00:00Z').getTime() - dias * 864e5) : hasta);
  if (desde > hasta) desde = hasta;
  // El tope se aplica RECORTANDO POR ATRÁS: lo más nuevo es lo que se está por despachar.
  const piso = fechaArgentina(new Date(hasta + 'T12:00:00Z').getTime() - MAX_RANGO_DIAS * 864e5);
  if (desde < piso) desde = piso;
  return { desde, hasta };
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
    const { desde, hasta } = rangoPedido(req);
    const armado = await vistaRemitos(desde, hasta, req.query.refrescar === '1');
    // `fecha` y `dias` siguen saliendo para no romper una pantalla vieja que los lea.
    const dias = Math.round((Date.parse(hasta) - Date.parse(desde)) / 864e5);
    res.json({ ok: true, desde, hasta, fecha: hasta, dias, ...armado });
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
    const rango = rangoPedido(req);
    const fecha = rango.hasta;
    const [{ pendientes }, { data: camiones, error: errorCamiones }] = await Promise.all([
      vistaRemitos(rango.desde, rango.hasta),
      sb().from('hojas_ruta_camiones').select('id, nombre, capacidad_kg')
        .eq('tenant_id', TENANT_ID).eq('activo', true),
    ]);
    if (errorCamiones) throw new Error(errorCamiones.message);
    const flota = (camiones ?? []).map((c: any) => ({
      id: String(c.id), nombre: String(c.nombre), capacidad_kg: Number(c.capacidad_kg),
    }));
    res.json({ ok: true, fecha, sin_peso: pendientes.filter((p: any) => !p.peso_completo), ...sugerirRepartos(pendientes.filter((p: any) => p.peso_completo) as any, flota) });
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
    // 🔑 "Anterior" es anterior al INICIO del rango que se está mirando, no al día de hoy: con un
    // rango de tres días, los remitos de esos tres días ya están en pantalla y no son arrastre.
    const { desde: inicio, hasta: fecha } = rangoPedido(req);
    const desde = fechaArgentina(new Date(inicio + 'T12:00:00Z').getTime() - VENTANA_DIAS * 864e5);
    const corte = String(process.env.HOJAS_RUTA_DESDE ?? '2026-09-09');
    const piso = corte === 'todo' ? desde : desde < corte ? corte : desde;
    const anterior = fechaArgentina(new Date(inicio + 'T12:00:00Z').getTime() - 864e5);
    if (piso > anterior) { res.json({ ok: true, fecha, cantidad: 0, desde: piso, por_fecha: {} }); return; }
    const ventas = await fetchVentas(piso, anterior);
    // 🔄 Cuenta REMITOS, igual que la pantalla: un remito de la semana pasada que no salió es
    // mercadería facturada esperando el camión, y ése es el aviso que importa.
    const previos = ventas.filter((v: any) =>
      Number(v.cod_empresa) === PEDIDO_EMPRESA_DEFAULT && String(v.tipo_comprobante ?? '').trim() === 'RE' &&
      String(v.anulada ?? '').trim().toUpperCase() !== 'S' &&
      String(v.fecha ?? '').slice(0, 10) < inicio);
    const emitidos = await emitidosDe(previos.map((p: any) => String(p.id)));
    const alias = new Map<string, string[]>();
    for (const p of previos) alias.set(String(p.id), [String(p.id), ...emitidos.filter(e => String(e.im_remito_id) === String(p.id)).map(e => String(e.im_comprobante_id))]);
    const ids = [...new Set([...alias.values()].flat())];
    /**
     * 🪤 Esto truncaba en 400 ids. Con remitos son ~55-67 por día contra ~39 presupuestos, así
     * que sobre 15 días son ~800: los 400 restantes no se chequeaban contra nada y se contaban
     * TODOS como arrastre — el aviso mostraba un número inflado. Se pide en tandas.
     * Auditoría del 08/09/2026.
     */
    const yaEn = new Set<string>();
    for (let i = 0; i < ids.length; i += 200) {
      const tanda = ids.slice(i, i + 200);
      // Los que ya están en una hoja no son arrastre: alguien se ocupó.
      const { data: asignados, error: errAsignados } = await sb().from('hojas_ruta_pedidos')
        .select('im_comprobante_id,hojas_ruta!inner(tenant_id)').eq('hojas_ruta.tenant_id', TENANT_ID).in('im_comprobante_id', tanda);
      if (errAsignados) throw new Error(errAsignados.message);
      for (const a of asignados ?? []) yaEn.add(String((a as any).im_comprobante_id));
      // Ni los que el cliente pasa a buscar: ésos tampoco esperan un camión.
      const { data: retiros, error: errRetiros } = await sb().from('retiros_sucursal')
        .select('im_comprobante_id').eq('tenant_id', TENANT_ID).in('im_comprobante_id', tanda);
      if (errRetiros) throw new Error(errRetiros.message);
      for (const r of retiros ?? []) yaEn.add(String((r as any).im_comprobante_id));
    }
    const sueltos = previos.filter((p: any) => !alias.get(String(p.id))!.some(id => yaEn.has(id)));
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
    /**
     * 🔑 EL HISTÓRICO. Mati (10/09/2026): *"estaría bueno tener una sección donde podamos ver el
     * histórico de todas las hojas de ruta para poder controlar que estén todas bien, si no ahora
     * desaparecen con el filtro de fecha y es difícil encontrarlas"*.
     *
     * Con `?todas=1` se ignora el rango y salen las últimas, de la más nueva a la más vieja. El
     * tope existe porque cada hoja viene con todos sus pedidos: sin límite, dentro de un año esto
     * sería una consulta enorme para mirar las diez de arriba.
     */
    const todas = String(req.query.todas ?? '') === '1';
    // 🔑 Por RANGO, igual que los pendientes: si la pantalla muestra tres días de pedidos y las
    // hojas de un solo día, los pedidos ya asignados aparecen como si nadie los hubiera tocado.
    const { desde, hasta } = rangoPedido(req);
    const base = sb().from('hojas_ruta')
      .select('*, hojas_ruta_camiones(nombre, capacidad_kg), choferes(nombre), hojas_ruta_pedidos(*)')
      .eq('tenant_id', TENANT_ID);
    if (todas && req.query.antes && /^\d+$/.test(String(req.query.antes))) base.lt('numero', Number(req.query.antes));
    const { data: hojasLeidas, error } = todas
      ? await base.order('numero', { ascending: false }).limit(51)
      : await base.gte('fecha', desde).lte('fecha', hasta).order('fecha').order('numero');
    if (error) { res.status(500).json({ error: error.message }); return; }
    const hojas = todas ? (hojasLeidas ?? []).slice(0, 50) : hojasLeidas;
    const siguiente = todas && (hojasLeidas ?? []).length > 50 ? hojas?.at(-1)?.numero : null;
    // 🔑 Lo emitido se cruza contra `presupuestos_facturados`, que es la fuente viva: los campos
    // copiados en `hojas_ruta_pedidos` son de cuando se armó la hoja, y si el pedido se facturó
    // DESPUÉS quedaban vacíos (auditoría del 08/09/2026).
    const todosEnriquecidos = await enriquecerHojas(hojas ?? [], req.query.refrescar === '1');
    const emitidoPor = new Map(todosEnriquecidos.map((p: any) => [String(p.im_comprobante_id), p]));
    const conCarga = (hojas ?? []).map((h: any) => {
      const ps = (h.hojas_ruta_pedidos ?? []).map((p: any) => {
        const e = emitidoPor.get(String(p.im_comprobante_id));
        return e ?? p;
      });
      const kg = ps.reduce((s: number, p: any) => s + Number(p.kg ?? 0), 0);
      const bultos = ps.reduce((s: number, p: any) => s + Number(p.bultos ?? 0), 0);
      const cap = h.hojas_ruta_camiones?.capacidad_kg;
      return {
        ...h,
        camion: h.hojas_ruta_camiones?.nombre ?? null,
        // El día en que sale el camión: la pantalla lo muestra y lo deja cambiar.
        fecha: h.fecha,
        chofer: h.choferes?.nombre ?? null,
        // Se deriva de los pedidos: `hojas_ruta.facturada_at` quedó sin escritor cuando la
        // facturación se mudó de etapa.
        facturada: !!ps.length && ps.every((p: any) => p.facturado_at),
        capacidad_kg: cap ?? null,
        pedidos: ps.sort((a: any, b: any) => a.orden - b.orden),
        totales: { pedidos: ps.length, bultos: Math.round(bultos * 100) / 100, kg: Math.round(kg * 100) / 100 },
        carga: { ...cargaDelCamion(kg, cap), completa: ps.every((p: any) => p.peso_completo === true) },
      };
    });
    res.json({ ok: true, desde, hasta, fecha: hasta, hojas: conCarga, siguiente });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err?.message ?? 'error' });
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
 * Las hojas abiertas usan el importe vigente de su factura; las cerradas conservan su base
 * histórica. Bultos y kilos conservan el respaldo de la entrega. Los renglones del fraccionado
 * se consultan a IM para reflejar qué preparar ahora.
 */
export async function impresionHoja(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  try {
    const { data: hoja, error } = await sb().from('hojas_ruta')
      .select('*, hojas_ruta_camiones(nombre, capacidad_kg), choferes(nombre), hojas_ruta_pedidos(*)')
      .eq('id', String(req.params.id)).eq('tenant_id', TENANT_ID).maybeSingle();
    if (error) { res.status(500).json({ error: error.message }); return; }
    if (!hoja) { res.status(404).json({ error: 'Hoja de ruta no encontrada' }); return; }

    const pedidosCrudos = [...((hoja as any).hojas_ruta_pedidos ?? [])].sort((a: any, b: any) => a.orden - b.orden);

    /**
     * 🪤 El mismo cruce vivo que hace `listarHojas`: los comprobantes copiados en la fila son de
     * cuando se armó la hoja, y si se facturó DESPUÉS quedaron vacíos. Sin esto, una hoja armada
     * antes del cambio a remitos se imprimía con el número de PRESUPUESTO y el repartidor llevaba
     * un papel que no coincide con el remito. Auditoría del 08/09/2026.
     */
    const pedidos = await notasDeHoja(String(req.params.id), aplicarImportesCierre(hoja, await enriquecerEntregas(pedidosCrudos, true, hoja.estado !== 'cerrada')));
    const { data: respaldos, error: errorRespaldos } = await sb().from('hojas_ruta_saldos').select('*').eq('hoja_id', String(req.params.id));
    if (errorRespaldos) throw new Error(`No pude leer los respaldos de saldo: ${errorRespaldos.message}`);
    const nuevosSaldos: any[] = [];
    // Agrupado por cliente, como la hoja impresa: un cliente puede tener varios comprobantes
    // y abajo el "Total por cliente".
    const porCliente = new Map<string, any>();
    for (const p of pedidos) {
      const k = `${p.cod_empresa ?? 'desconocida'}|${p.cod_cliente}`;
      if (!porCliente.has(k)) {
        porCliente.set(k, {
          cod_cliente: Number(p.cod_cliente), cod_empresa: p.cod_empresa, cliente_nombre: p.cliente_nombre, saldo_anterior: null,
          comprobantes: [], total: 0, bultos: 0, kg: 0,
        });
      }
      const c = porCliente.get(k);
      c.comprobantes.push({
        im_comprobante_id: p.im_comprobante_id, im_numero: p.im_numero,
        bultos: Number(p.bultos ?? 0), kg: Number(p.kg ?? 0), total: Number(p.total ?? 0),
        im_remito_numero: p.im_remito_numero ?? null,
        im_factura_id: p.im_factura_id ?? null,
        facturado: !!p.facturado_at, factura_origen: p.factura_origen, notas: p.notas,
      });
      c.total += Number(p.total ?? 0);
      c.bultos += Number(p.bultos ?? 0);
      c.kg += Number(p.kg ?? 0);
      // 🪤 El saldo es del CLIENTE, no del comprobante: si tiene dos pedidos no se suma dos
      // veces. Se queda con el primero que tenga uno cargado.

    }

    /**
     * 🔴 LAS NOTAS DE CRÉDITO Y DÉBITO DE ESTA ENTREGA.
     *
     * Mati (10/09/2026): *"la NC de Baca tiene que impactar en el importe total que se le va a
     * entregar en ese pedido"*. Sin esto el repartidor le cobra la factura entera y el cliente
     * paga de más algo que ya se le acreditó.
     *
     * El vínculo nota→factura vive de nuestro lado (`facturas_correcciones`): la API de IM no
     * tiene ningún campo que lo guarde.
     */
    /**
     * 🔴 EL SALDO ANTERIOR SALE DE LOS COMPROBANTES IMPAGOS, NO DEL CRÉDITO DISPONIBLE.
     *
     * Mati (10/09/2026): *"siguen mal los saldos de las facturas adeudadas anteriores: tiene que
     * ir únicamente el saldo anterior a la factura que está yendo en esa hoja de ruta"*.
     *
     * Se usaba `/reportes/disponible_por_cliente`, que devuelve otra cosa y se saltea los
     * comprobantes más nuevos: para BUSTOS daba $1.560.303,87 cuando debía $2.788.891,38 y para
     * BACA daba 0 cuando tenía $47.436 a favor. Ahora se suman los comprobantes que le quedan
     * impagos —la fuente que cierra al centavo contra `/reportes/saldos_clientes`— y se sacan
     * los de esta entrega: su factura y las notas que la corrigen.
     *
     * Si InfoManager no contesta queda el guardado: es viejo, pero es lo que había.
     */
    await Promise.all([...porCliente.values()].map(async (c: any) => {
      const notas = notasUnicas(c.comprobantes.flatMap((x: any) => x.notas ?? []));
      c.ajuste_notas = ajusteDeNotas(notas);
      c.notas = notas.map(n => ({ tipo: n.tipo, numero: n.numero, total: n.total }));
      c.total = Math.round((Number(c.total ?? 0) + c.ajuste_notas) * 100) / 100;
      const excluir = [...c.comprobantes.map((x: any) => x.im_factura_id).filter(Boolean), ...notas.map(n => n.id)];
      c.saldo_fuente = 'desconocido'; c.saldo_actualizado = false;
      if (!c.cod_empresa || c.comprobantes.some((x: any) => !x.im_factura_id)) return;
      const consultado_at = new Date().toISOString();
      try {
        const pendientes = await comprobantesPendientesCliente(c.cod_cliente, c.cod_empresa);
        c.saldo_anterior = saldoAnteriorDeLaHoja(pendientes, excluir);
        c.saldo_fuente = 'en_vivo'; c.saldo_actualizado = true; c.saldo_consultado_at = consultado_at;
        nuevosSaldos.push({ cod_empresa: c.cod_empresa, cod_cliente: c.cod_cliente, consultado_at, pendientes: pendientes.map(p => ({ id: p.id, saldo: p.saldo })) });
      } catch {
        const respaldo = (respaldos ?? []).find((r: any) => Number(r.cod_empresa) === c.cod_empresa && Number(r.cod_cliente) === c.cod_cliente);
        if (respaldo) {
          c.saldo_anterior = saldoAnteriorDeLaHoja(respaldo.pendientes, excluir);
          c.saldo_fuente = 'respaldo'; c.saldo_consultado_at = respaldo.consultado_at;
        }
      }
    }));
    if (nuevosSaldos.length) await mutarReparto(req.user?.sub, 'saldo_guardar', { hoja_id: String(req.params.id), saldos: nuevosSaldos });

    // ── Fraccionado: lo que se vende por kilo, producto por producto ──────────
    // 🔑 El armado vive en `fraccionado.ts` y lo comparte con la etapa de presupuestos, que es
    // donde la oficina lo prepara ahora (antes del armado de la hoja).
    const cat = await fetchArticulosCatalogo();
    const idsFraccionado = new Set(pedidos.map(p => String(p.im_comprobante_id)));
    const diasFraccionado = [...new Set(pedidos.map(p => String(p.fecha ?? '').slice(0, 10)).filter(Boolean))];
    const detalleFraccionado = await itemsPorFechas(diasFraccionado);
    const sinItemsFraccionado = pedidos.filter(p => !detalleFraccionado.items.some(it => String(it.id_comprobante) === String(p.im_comprobante_id)));
    const fraccionado = armarFraccionado(detalleFraccionado.items.filter(it => idsFraccionado.has(String(it.id_comprobante))).map(it => ({ cod_articulo: Number(it.cod_articulo), cantidad: Number(it.cantidad) })), cat, formatosDeBolsa());

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
      /**
       * 🔑 POR ORDEN ALFABÉTICO. Mati (10/09/2026): *"a la hora de imprimir las hojas de ruta
       * deberían ordenarse por orden alfabético también"*. En la lista se busca por apellido —el
       * repartidor tiene que encontrar al cliente en el papel— y el orden en que se cargaron los
       * pedidos no ayuda a eso.
       *
       * 🪤 Con `localeCompare` en español: si no, "ÁVILA" se va después de "ZARATE" y "Ñ" queda
       * fuera de lugar.
       */
      clientes: [...porCliente.values()].sort((a: any, b: any) =>
        String(a.cliente_nombre ?? '').localeCompare(String(b.cliente_nombre ?? ''), 'es', { sensitivity: 'base' })),
      totales: {
        clientes: porCliente.size, comprobantes: pedidos.length,
        bultos: Math.round(totales.bultos * 100) / 100,
        kg: Math.round(totales.kg * 100) / 100,
        total: Math.round([...porCliente.values()].reduce((s, c) => s + c.total, 0) * 100) / 100,
      },
      fraccionado, fraccionado_completo: detalleFraccionado.completo && sinItemsFraccionado.length === 0, dias_faltantes: detalleFraccionado.dias_faltantes,
      fraccionado_totales: totalesFraccionado(fraccionado),
      sin_saldo: [...porCliente.values()].filter((c: any) => c.saldo_anterior == null).length,
      sin_actualizar_saldo: [...porCliente.values()].filter((c: any) => !c.saldo_actualizado).length,
    });
  } catch (err: any) {
    console.error('[impresionHoja]', err?.message);
    res.status(err.status ?? 500).json({ error: err?.message ?? 'error' });
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
    // El número sigue al último y comparte serie con las hojas que la oficina hace en IM, para
    // que puedan hablar de "la 3402" sin traducir entre dos numeraciones (ver numeroHojaRuta).
    const numero = Number(b.numero) || null; // La asignación automática ocurre bajo el lock SQL.
    const data = await mutarReparto(req.user?.sub, 'hoja_crear', {
      tenant_id: TENANT_ID, fecha, numero, numero_minimo: proximoNumeroHoja(null),
      turno: b.turno ? String(b.turno) : null,
      transporte: b.transporte ? String(b.transporte) : null,
      camion_id: b.camion_id ? String(b.camion_id) : null,
      cod_zona: Number.isFinite(Number(b.cod_zona)) && Number(b.cod_zona) > 0 ? Number(b.cod_zona) : null,
      observaciones: b.observaciones ? String(b.observaciones) : null,
      created_by: req.user?.sub ?? null,
    });
    res.json({ ok: true, hoja: data });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err?.message ?? 'error' });
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

    let entrada: any[] = Array.isArray(req.body?.pedidos) ? req.body.pedidos : [];
    if (!entrada.length) { res.status(400).json({ error: 'No mandaste ningún pedido' }); return; }

    // ¿Alguno ya está en otra hoja? Se avisa antes de tocar nada: un comprobante en dos hojas
    // se carga en dos camiones.
    entrada = await verificarEntregas(entrada, req.body?.rango);
    if (entrada.some(p => p.tipo !== 'RE')) { res.status(409).json({ error: 'Las nuevas hojas se arman con remitos.' }); return; }
    entrada = await enriquecerEntregas(entrada);
    const ids = entrada.map(p => String(p.im_comprobante_id));
    if (ids.some(id => !/^[0-9]+$/.test(id))) {
      // 🪤 Los ids van interpolados en el `.or()` de más abajo, y `.or()` NO escapa como `.in()`:
      // una coma o un paréntesis rompen el filtro entero de PostgREST. Los ids de IM son enteros.
      res.status(400).json({ error: 'Hay un comprobante con un identificador inválido.' }); return;
    }
    if (ids.length > 300) { res.status(400).json({ error: 'Máximo 300 comprobantes por vez.' }); return; }

    /**
     * 🔴 El presupuesto del que salió cada remito (y al revés). La hoja se armaba con
     * presupuestos hasta el 08/09/2026 y ahora con remitos, así que la MISMA entrega puede
     * existir con dos identificadores distintos. El índice único es sobre `im_comprobante_id`:
     * son dos filas para la base, y sin este cruce la mercadería termina en dos camiones y el
     * chofer cobra dos veces. Auditoría del 08/09/2026.
     */
    const { data: paresRaw, error: errPares } = await sb().from('presupuestos_facturados')
      .select('im_comprobante_id, im_remito_id').eq('tenant_id', TENANT_ID)
      .or(`im_comprobante_id.in.(${ids.join(',')}),im_remito_id.in.(${ids.join(',')})`);
    if (errPares) { res.status(502).json({ error: `No pude verificar el otro comprobante de estos pedidos: ${errPares.message}` }); return; }
    /** El "gemelo" de cada id: el remito de un presupuesto, o el presupuesto de un remito. */
    const gemelo = new Map<string, string>();
    for (const f of paresRaw ?? []) {
      const pr = (f as any).im_comprobante_id ? String((f as any).im_comprobante_id) : null;
      const re = (f as any).im_remito_id ? String((f as any).im_remito_id) : null;
      if (pr && re) { gemelo.set(pr, re); gemelo.set(re, pr); }
    }
    const idsYGemelos = [...new Set([...ids, ...ids.map(i => gemelo.get(i)).filter(Boolean) as string[]])];

    const { data: yaAsignados, error: errAsig } = await sb().from('hojas_ruta_pedidos')
      .select('im_comprobante_id, hoja_id, im_numero, hojas_ruta!inner(numero, estado, version,tenant_id)').eq('hojas_ruta.tenant_id', TENANT_ID).in('im_comprobante_id', idsYGemelos);
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
      .select('im_comprobante_id, im_numero').eq('tenant_id', TENANT_ID).in('im_comprobante_id', idsYGemelos);
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
        origenes: Object.fromEntries(enOtra.map((a: any) => [String(a.im_comprobante_id), { hoja_id: a.hoja_id, version: a.hojas_ruta?.version }])),
        en_otra_hoja: enOtra.map((a: any) => String(a.im_comprobante_id)),
      });
      return;
    }

    // El saldo del cliente: es JUSTO lo que hoy escriben a mano en la hoja impresa. Se consulta
    // de a uno porque IM no tiene un endpoint masivo; son pocos por hoja y se guarda el número.
    // 🪤 De la MISMA fuente que la impresión: este número es el respaldo para cuando IM no
    // conteste al imprimir, y guardar acá uno de otro reporte dejaba dos verdades distintas.
    const saldos = new Map<number, number | null>();
    const snapshots: any[] = [];
    const { data: previos, error: errPrevios } = await sb().from('hojas_ruta_pedidos').select('*').eq('hoja_id', hojaId);
    if (errPrevios) throw new Error(errPrevios.message);
    const previstas = await notasDeHoja(hojaId, await enriquecerEntregas([...(previos ?? []).filter((p: any) => !ids.includes(String(p.im_comprobante_id))), ...entrada]));
    await Promise.all([...new Set(entrada.map(p => Number(p.cod_cliente)))].map(async cod => {
      const empresa = entrada.find(p => Number(p.cod_cliente) === cod)!.cod_empresa;
      const consultado_at = new Date().toISOString();
      try {
        const pendientes = await comprobantesPendientesCliente(cod, empresa);
        const delCliente = previstas.filter(p => Number(p.cod_cliente) === cod && Number(p.cod_empresa) === empresa);
        const excluir = [...delCliente.map(p => p.im_factura_id).filter(Boolean), ...delCliente.flatMap(p => p.notas.map((n: any) => n.id))];
        saldos.set(cod, delCliente.every(p => p.im_factura_id) ? saldoAnteriorDeLaHoja(pendientes, excluir) : null);
        snapshots.push({ cod_empresa: empresa, cod_cliente: cod, consultado_at, pendientes: pendientes.map(p => ({ id: p.id, saldo: p.saldo })) });
      } catch { saldos.set(cod, null); }
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
      .eq('tenant_id', TENANT_ID).or(`im_comprobante_id.in.(${ids.join(',')}),im_remito_id.in.(${ids.join(',')})`);   // ids validados como numéricos arriba
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
    const pesos = new Map<string, { bultos: number; kg: number; renglones_sin_peso: number }>();
    try {
      const cat = await fetchArticulosCatalogo();
      const porComprobante = new Map<string, any[]>();
      // Sólo los días de los comprobantes que se están asignando: pedir la ventana entera
      // tarda 23 s y esto corre con el usuario esperando.
      const dias = [...new Set(entrada.map((p: any) => String(p.fecha ?? hoja.fecha).slice(0, 10)).filter(Boolean))];
      const tandas = await Promise.all(dias.map(f => fetchVentasItems(f, f).catch(() => [] as any[])));
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
        hoja_id: hojaId, cod_empresa: p.cod_empresa, factura_origen: p.factura_origen, tipo_comprobante: p.tipo_comprobante, datos_consultados_at: p.datos_consultados_at,
        peso_completo: !!peso && peso.renglones_sin_peso === 0, renglones_sin_peso: peso?.renglones_sin_peso ?? null,
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
        // 🔑 La fecha del comprobante, no la de la hoja: una hoja puede llevar arrastre de días
        // anteriores y el fraccionado necesita saber a qué día pedirle los renglones a IM.
        fecha: /^\d{4}-\d{2}-\d{2}/.test(String(p.fecha ?? '')) ? String(p.fecha).slice(0, 10) : null,
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
    await mutarReparto(req.user?.sub, 'asignar', { hoja_id: hojaId, version_esperada: req.body?.version_esperada, pedidos: filas, saldos: snapshots, mover: req.body?.mover === true, origenes: req.body?.origenes ?? {} });
    invalidarVista(); invalidarRemitos();
    res.json({
      ok: true, agregados: filas.length,
      sin_saldo: filas.filter(f => f.saldo_anterior == null).length,
      peso_recalculado: filas.every(f => f.peso_completo),
    });
  } catch (err: any) {
    console.error('[asignarPedidos]', err?.message);
    res.status(err.status ?? 500).json({ error: err?.message ?? 'error' });
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
    /**
     * 🔑 LA FECHA DE LA HOJA: el día en que sale el camión. Mati (10/09/2026): *"las hojas de ruta
     * tienen que poder relacionarse a una fecha, porque muchas veces armamos hojas para días
     * siguientes"*. Se arma hoy la hoja de mañana, y a veces hay que correrla un día.
     *
     * 🪤 Se valida el formato acá: una fecha inventada sale impresa en el papel que va al camión
     * y además decide en qué día del rango aparece la hoja.
     */
    if ('fecha' in b) {
      const f = String(b.fecha ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) { res.status(400).json({ error: 'La fecha de la hoja no es válida.' }); return; }
      cambios.fecha = f;
    }
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

    delete cambios.cerrada_at; delete cambios.cerrada_por;
    const datos: any = { hoja_id: String(req.params.id), version_esperada: req.body?.version_esperada, cambios };
    if (cambios.estado === 'cerrada') {
      const { data: hoja, error } = await sb().from('hojas_ruta').select('*, hojas_ruta_pedidos(*)')
        .eq('id', String(req.params.id)).eq('tenant_id', TENANT_ID).maybeSingle();
      if (error) throw new ErrorReparto(`No pude consultar las entregas al cerrar: ${error.message}`, 502);
      if (!hoja || hoja.estado !== 'abierta' || hoja.version !== req.body?.version_esperada) throw new ErrorReparto('La hoja cambió. Actualizá antes de cerrar.');
      const pedidos = await enriquecerEntregas(hoja.hojas_ruta_pedidos ?? [], true);
      datos.importes = pedidos.map(p => ({ im_comprobante_id: p.im_comprobante_id, im_factura_id: p.im_factura_id ?? null,
        cod_cliente: p.cod_cliente, cod_empresa: p.cod_empresa, total: Number(p.total), importe_fuente: p.importe_fuente }));
    }
    const data = await mutarReparto(req.user?.sub, cambios.estado === 'cerrada' ? 'hoja_cerrar' : 'hoja_editar', datos);
    res.json({ ok: true, hoja: data });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err?.message ?? 'error' });
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
  try { await mutarReparto(req.user?.sub, 'hoja_borrar', { hoja_id: id, version_esperada: req.query.version_esperada }); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); return; }
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
    .select('hoja_id, im_numero, hojas_ruta!inner(numero, estado, version,tenant_id)')
    .eq('hojas_ruta.tenant_id', TENANT_ID).eq('im_comprobante_id', comprobanteId).maybeSingle();
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
  try { await mutarReparto(req.user?.sub, 'quitar', { hoja_id: req.query.hoja_id, im_comprobante_id: comprobanteId, version_esperada: req.query.version_esperada }); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); return; }
  invalidarVista(); invalidarRemitos();   // el pedido volvió a estar libre y la lista quedó vieja
  res.json({ ok: true });
}
