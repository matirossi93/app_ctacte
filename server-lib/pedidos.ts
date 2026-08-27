import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { sb, TENANT_ID } from './supabase.js';
import {
  crearPresupuesto, anularComprobante, getPrecioLista, getDisponibleCliente,
  fetchClientesIMCached, fetchArticulosCatalogo, fetchArticulosDeDeposito,
} from './infomanager.js';
import type { JwtPayload } from './auth.js';
import {
  clasificarArticulo, evaluarPedido,
  type ArticuloInfo, type ReglaLista, type ResultadoPedido,
} from './listas.js';

const { env } = process;
// usuario REAL de IM con punto de venta vinculado para presupuestos (PR/destino1).
// Puede diferir del usuario de recibos: se setea aparte por si el de recibos no
// tiene punto de venta de presupuestos. Fallback al de recibos.
const IM_USUARIO_PEDIDOS = env.IM_USUARIO_PEDIDOS || env.INFOMANAGER_USUARIO || '';
if (!IM_USUARIO_PEDIDOS) {
  // Sin usuario NO se puede postear el presupuesto a IM, pero el resto de la app (cuenta
  // corriente, recibos, objetivos) no tiene nada que ver. Antes esto hacía process.exit(1)
  // y una variable faltante habría tumbado TODA la app al deployar el módulo por primera vez.
  console.error('[pedidos] IM_USUARIO_PEDIDOS / INFOMANAGER_USUARIO sin definir: no se van a poder enviar pedidos a InfoManager. El resto de la app sigue funcionando.');
}
const PEDIDO_EMPRESA_DEFAULT = Number(env.PEDIDO_EMPRESA_DEFAULT || 1);
const PEDIDO_PUNTO_DE_VENTA = Number(env.PEDIDO_PUNTO_DE_VENTA || 1);
const PEDIDO_LISTA_FALLBACK = Number(env.PEDIDO_LISTA_FALLBACK || 12); // LISTA 1
// Deposito cuyo stock define que productos ve el buscador. 1 = Deposito General (casa
// central, empresa 1). Los otros son 2=BRS, 3=San Juan, 6=Jujuy.
const PEDIDO_DEPOSITO = Number(env.PEDIDO_DEPOSITO || 1);
// Dry-run: NO postea a IM, solo guarda el borrador en Supabase y loguea el payload.
// Útil para probar el flujo sin ensuciar InfoManager. Apagar (borrar/0) para producción.
const PEDIDOS_DRY_RUN = String(env.PEDIDOS_DRY_RUN || '').toLowerCase() === 'true' || env.PEDIDOS_DRY_RUN === '1';

interface ItemInput { cod_articulo: number; cantidad: number; cod_lista?: number }

/**
 * Listas mayoristas validas (IM): 12=L1 13=L2 14=L3 15=L4, 9=MINORISTA, 11=SUCURSALES.
 * El vendedor elige la lista RENGLON POR RENGLON segun la cantidad — asi trabajan
 * hoy en IM. Si no manda ninguna, se usa la del cliente.
 */
const LISTAS_VALIDAS = new Set([9, 11, 12, 13, 14, 15]);

// ── Control de listas ─────────────────────────────────────────────────────────
// Las reglas son datos de negocio que Mati cambia sin que cambie el código, así que
// viven en Supabase (tabla listas_reglas) y se recargan solas cada 5 minutos.
const REGLAS_TTL_MS = 5 * 60 * 1000;
let _reglasCache: { reglas: ReglaLista[]; fetchedAt: number } | null = null;

async function reglasActivas(): Promise<ReglaLista[]> {
  if (_reglasCache && Date.now() - _reglasCache.fetchedAt < REGLAS_TTL_MS) return _reglasCache.reglas;
  const { data, error } = await sb().from('listas_reglas')
    .select('nombre, match_tipo, match_valor, cod_lista, condicion, umbral, unidad, ambito')
    .eq('tenant_id', TENANT_ID).eq('activo', true);
  if (error) throw new Error(`listas_reglas: ${error.message}`);
  const reglas = (data ?? []) as ReglaLista[];
  _reglasCache = { reglas, fetchedAt: Date.now() };
  return reglas;
}

/** Catálogo de IM ya clasificado en bulto/granel, que es lo que necesita el evaluador. */
async function catalogoParaListas(): Promise<Map<number, ArticuloInfo>> {
  const crudo = await fetchArticulosCatalogo();
  const out = new Map<number, ArticuloInfo>();
  for (const [cod, a] of crudo) out.set(cod, clasificarArticulo({ cod_articulo: cod, ...a }));
  return out;
}

/**
 * Corre el control de listas sobre un pedido. NUNCA tira: si las reglas o el catálogo no
 * están disponibles, devuelve null y el pedido sigue su curso. El control avisa, no frena
 * — mismo criterio que las guardas de cupo y stock que eligió Mati en julio.
 */
async function controlarListas(items: Array<{ cod_articulo: number; cantidad: number; cod_lista: number }>): Promise<ResultadoPedido | null> {
  try {
    const [reglas, catalogo] = [await reglasActivas(), await catalogoParaListas()];
    return evaluarPedido(items, catalogo, reglas);
  } catch (e: any) {
    console.warn('[controlarListas] no se pudo evaluar, sigo sin control:', e?.message);
    return null;
  }
}

/**
 * POST /api/pedidos/validar — control de listas EN VIVO, mientras el vendedor arma el carrito.
 * Es el que le ahorra el trabajo a facturación: avisar al confirmar llega tarde, ahí ya cargó todo.
 * Body: { items: [{cod_articulo, cantidad, cod_lista}] }
 */
export async function validarListasPedido(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const items = (Array.isArray(req.body?.items) ? req.body.items : [])
      .map((it: any) => ({ cod_articulo: Number(it.cod_articulo), cantidad: Number(it.cantidad), cod_lista: Number(it.cod_lista) }))
      .filter((it: any) => it.cod_articulo > 0 && it.cantidad > 0);
    if (!items.length) { res.json({ ok: true, bultos: 0, promo_general: false, avisos: [] }); return; }
    const r = await controlarListas(items);
    if (!r) { res.json({ ok: true, sin_control: true, bultos: 0, promo_general: false, avisos: [] }); return; }
    res.json({ ok: true, ...r });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/** Resuelve cod_vendedor del pedido según rol (vendedor = el suyo; admin/gerente = del body o del cliente). */
async function resolverCodVendedor(user: JwtPayload, codCliente: number, bodyCodVend?: any): Promise<number> {
  if (user.rol === 'vendedor') return user.cod_vendedor ?? 0;
  if (bodyCodVend != null && Number.isFinite(Number(bodyCodVend))) return Number(bodyCodVend);
  try {
    const clientes = await fetchClientesIMCached();
    const hit = clientes.find((c) => Number(c.cod_cliente) === codCliente);
    if (hit?.cod_vendedor != null) return Number(hit.cod_vendedor);
  } catch { /* fallback abajo */ }
  return 0;
}

/**
 * POST /api/pedidos — crea un pedido (presupuesto NC en IM).
 * Body: { cod_cliente, cod_empresa?, items:[{cod_articulo, cantidad}], observaciones?, idempotency_key? }
 */
export async function crearPedido(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const user = req.user;
    if (!user) { res.status(401).json({ error: 'No autorizado' }); return; }
    if (user.rol === 'vendedor' && user.cod_vendedor == null) {
      res.status(400).json({ error: 'Tu usuario no tiene cod_vendedor asignado. Pedile a Matías que lo setee.' }); return;
    }

    if (!IM_USUARIO_PEDIDOS && !PEDIDOS_DRY_RUN) {
      res.status(503).json({ error: 'Falta configurar IM_USUARIO_PEDIDOS: el pedido no se puede enviar a InfoManager. Avisale a Matías.' });
      return;
    }

    const body = req.body ?? {};
    const codCliente = Number(body.cod_cliente);
    if (!codCliente || isNaN(codCliente)) { res.status(400).json({ error: 'cod_cliente inválido' }); return; }
    const itemsInput: ItemInput[] = Array.isArray(body.items) ? body.items : [];
    const itemsValidos = itemsInput
      .map((it) => ({
        cod_articulo: Number(it.cod_articulo),
        cantidad: Number(it.cantidad),
        cod_lista: LISTAS_VALIDAS.has(Number(it.cod_lista)) ? Number(it.cod_lista) : undefined,
      }))
      .filter((it) => it.cod_articulo > 0 && it.cantidad > 0);
    if (!itemsValidos.length) { res.status(400).json({ error: 'El pedido no tiene items válidos' }); return; }

    const codEmpresa = Number(body.cod_empresa) || PEDIDO_EMPRESA_DEFAULT;
    const idempotencyKey = body.idempotency_key ? String(body.idempotency_key) : null;

    // Idempotencia: si ya existe un pedido con esta key, lo devolvemos (no recreamos).
    if (idempotencyKey) {
      const { data: existente } = await sb().from('pedidos_vendedor').select('*')
        .eq('tenant_id', TENANT_ID).eq('idempotency_key', idempotencyKey).maybeSingle();
      if (existente) { res.json({ ok: true, pedido: existente, duplicado: true }); return; }
    }

    // Datos del cliente desde IM (lista de precios + nombre).
    let clienteNombre = ''; let codLista = PEDIDO_LISTA_FALLBACK;
    try {
      const clientes = await fetchClientesIMCached();
      const cli = clientes.find((c) => Number(c.cod_cliente) === codCliente);
      if (cli) {
        clienteNombre = String(cli.razon_social ?? '');
        const l = Number(cli.lista_precio);
        if (Number.isFinite(l) && l > 0) codLista = l;
      }
    } catch (e: any) {
      console.warn('[crearPedido] IM clientes falló, uso lista fallback:', e?.message);
    }

    const codVendedor = await resolverCodVendedor(user, codCliente, body.cod_vendedor);

    // Resolver precio de cada item en la lista del cliente (secuencial: IM se satura en paralelo).
    const itemsConPrecio: Array<{ cod_articulo: number; cantidad: number; descripcion: string; precio: number; iva: number; subtotal: number; cod_lista: number }> = [];
    let totalEstimado = 0;
    for (const it of itemsValidos) {
      // La lista del RENGLON manda; si el vendedor no eligió una, va la del cliente.
      const listaItem = it.cod_lista ?? codLista;
      let precio = 0, iva = 21, descripcion = '';
      try {
        const p = await getPrecioLista(it.cod_articulo, listaItem);
        if (p) { precio = p.precio_vta; iva = p.iva; descripcion = p.descripcion; }
      } catch (e: any) {
        console.warn(`[crearPedido] precio-ldp falló art=${it.cod_articulo} lista=${listaItem}:`, e?.message);
      }
      const subtotal = Math.round(precio * it.cantidad * 100) / 100;
      totalEstimado += subtotal;
      itemsConPrecio.push({ ...it, descripcion, precio, iva, subtotal, cod_lista: listaItem });
    }

    // 🪤 Sin precio no se vende. IM contesta 200 con el error en el body cuando el artículo
    // no está en esa lista de precios, y eso pasaba como precio 0: el renglón se guardaba
    // en cero y se mandaba así. Pasó con el art 918 COLLAR AHORQUE CHICO en Lista 3.
    const sinPrecio = itemsConPrecio.filter((it) => !(it.precio > 0));
    if (sinPrecio.length) {
      const nombres = sinPrecio.map((it) => it.descripcion || `artículo ${it.cod_articulo}`).join(', ');
      res.status(422).json({
        ok: false, bloqueado: true,
        error: `${nombres}: no tiene precio cargado en la lista elegida. Probá con otra lista o avisá a la oficina.`,
        sin_precio: sinPrecio.map((it) => ({ cod_articulo: it.cod_articulo, cod_lista: it.cod_lista })),
      });
      return;
    }
    totalEstimado = Math.round(totalEstimado * 100) / 100;

    // Control de listas ANTES de escribir nada: si hay que frenar el pedido, no queremos
    // haber dejado una cabecera huérfana en Supabase.
    //
    // 🔒 Vender MÁS BARATO de lo que corresponde se FRENA (Mati, 26/08: "no le deje
    // presupuestar un producto a un precio más bajo del que le corresponde, sino pierde
    // el sentido de ese control"). Es plata que se pierde y nadie la recupera después.
    //
    // Al revés NO se frena: cobrarle de más a un cliente que tenía derecho a mejor precio
    // se avisa, pero el vendedor puede tener un motivo. Y si el control no pudo correr
    // (IM caído, Supabase sin responder) tampoco se frena: no se pierde una venta por un
    // problema nuestro.
    const control = await controlarListas(itemsConPrecio.map((it) => ({
      cod_articulo: it.cod_articulo, cantidad: it.cantidad, cod_lista: it.cod_lista,
    })));
    const avisoPorArt = new Map(control?.avisos.map((a) => [a.cod_articulo, a]) ?? []);
    const bloqueos = (control?.avisos ?? []).filter((a) => a.severidad === 'margen');
    if (bloqueos.length) {
      res.status(422).json({
        ok: false, bloqueado: true,
        error: bloqueos.length === 1
          ? bloqueos[0].mensaje
          : `Hay ${bloqueos.length} renglones con la lista mal elegida. Corregilos antes de enviar el pedido.`,
        avisos: bloqueos,
      });
      return;
    }

    // 1. Guardar el pedido en Supabase (estado borrador).
    const pedidoId = randomUUID();
    const { error: insErr } = await sb().from('pedidos_vendedor').insert({
      id: pedidoId,
      tenant_id: TENANT_ID,
      cod_vendedor: codVendedor,
      cod_cliente: codCliente,
      cliente_nombre: clienteNombre || null,
      cod_empresa: codEmpresa,
      cod_lista_precios: codLista,
      estado: 'borrador',
      total_estimado: totalEstimado,
      observaciones: body.observaciones ? String(body.observaciones) : null,
      idempotency_key: idempotencyKey,
      im_punto_de_venta: PEDIDO_PUNTO_DE_VENTA,
      created_by: user.sub,
    });
    if (insErr) {
      // Colisión de idempotency_key (índice único): otro request lo creó recién.
      if (insErr.code === '23505' && idempotencyKey) {
        const { data: existente } = await sb().from('pedidos_vendedor').select('*')
          .eq('tenant_id', TENANT_ID).eq('idempotency_key', idempotencyKey).maybeSingle();
        if (existente) { res.json({ ok: true, pedido: existente, duplicado: true }); return; }
      }
      res.status(500).json({ error: `insert pedido: ${insErr.message}` }); return;
    }
    await sb().from('pedidos_vendedor_items').insert(itemsConPrecio.map((it, i) => {
      const av = avisoPorArt.get(it.cod_articulo);
      return {
        pedido_id: pedidoId,
        cod_articulo: it.cod_articulo,
        descripcion: it.descripcion || null,
        cantidad: it.cantidad,
        precio_unit: it.precio,
        cod_lista_precios: it.cod_lista,
        lista_sugerida: av?.lista_sugerida ?? null,
        aviso_lista: av?.mensaje ?? null,
        iva_por: it.iva,
        subtotal: it.subtotal,
        orden: i,
      };
    }));

    // 2. Empujar a InfoManager como presupuesto NC (salvo dry-run).
    if (PEDIDOS_DRY_RUN) {
      console.log('[crearPedido] DRY_RUN — NO se postea a IM. Pedido', pedidoId, 'items:', JSON.stringify(itemsConPrecio));
      const { data } = await sb().from('pedidos_vendedor').select('*').eq('id', pedidoId).maybeSingle();
      res.json({ ok: true, pedido: data, dry_run: true });
      return;
    }

    const imRes = await crearPresupuesto({
      cod_empresa: codEmpresa,
      cod_cliente: codCliente,
      cod_vendedor: codVendedor,
      cod_lista_precios: codLista,
      usuario: IM_USUARIO_PEDIDOS,
      punto_de_venta: PEDIDO_PUNTO_DE_VENTA,
      observaciones: (body.observaciones ? String(body.observaciones) : `Pedido app · vend ${codVendedor}`).slice(0, 500),
      cod_compatibilidad: pedidoId.slice(0, 8),
      items: itemsConPrecio.map((it) => ({
        cod_articulo: it.cod_articulo,
        cantidad: it.cantidad,
        precio: it.precio > 0 ? String(it.precio) : undefined,
        iva_por: it.iva,
      })),
    });

    // 3. Actualizar estado según el resultado.
    let update: Record<string, any>;
    if (imRes.ok) {
      update = { estado: 'enviado', im_presupuesto_id: imRes.id, im_numero: imRes.numero, im_error: null };
    } else if (imRes.sinRespuesta) {
      // Timeout: resultado DESCONOCIDO (patrón HASAN). NO reintentar a ciegas.
      update = { estado: 'sin_respuesta', im_error: imRes.error };
    } else {
      update = { estado: 'error', im_error: imRes.error };
    }
    const { data: pedidoFinal } = await sb().from('pedidos_vendedor').update(update).eq('id', pedidoId).select().maybeSingle();

    if (imRes.ok) {
      res.json({ ok: true, pedido: pedidoFinal });
    } else if (imRes.sinRespuesta) {
      res.status(202).json({ ok: false, sin_respuesta: true, pedido: pedidoFinal,
        error: `IM no respondió — NO se sabe si el pedido entró. Revisá en IM antes de reintentar. (${imRes.error})` });
    } else {
      res.status(400).json({ ok: false, pedido: pedidoFinal, error: imRes.error, raw: imRes.raw });
    }
  } catch (err: any) {
    console.error('crearPedido error:', err);
    res.status(500).json({ error: err?.message ?? 'error interno' });
  }
}

/** GET /api/pedidos — lista (vendedor ve los suyos; admin/gerente todos). Query: estado?, dias?=30, limit?=200 */
export async function listPedidos(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const user = req.user!;
    let q = sb().from('pedidos_vendedor').select('*').eq('tenant_id', TENANT_ID);
    if (user.rol === 'vendedor') q = q.eq('cod_vendedor', user.cod_vendedor ?? -1);
    if (req.query.estado) q = q.eq('estado', String(req.query.estado));
    if (req.query.cod_cliente) q = q.eq('cod_cliente', Number(req.query.cod_cliente));
    const dias = Math.min(Math.max(Number(req.query.dias) || 30, 1), 120);
    q = q.gte('created_at', new Date(Date.now() - dias * 864e5).toISOString());
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    q = q.order('created_at', { ascending: false }).limit(limit);
    const { data, error } = await q;
    if (error) { res.status(500).json({ error: error.message }); return; }
    res.json({ ok: true, pedidos: data ?? [] });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/** GET /api/pedidos/:id — detalle con items. */
export async function getPedidoById(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const user = req.user!;
    let q = sb().from('pedidos_vendedor').select('*').eq('id', req.params.id).eq('tenant_id', TENANT_ID);
    if (user.rol === 'vendedor') q = q.eq('cod_vendedor', user.cod_vendedor ?? -1);
    const { data: pedido, error } = await q.maybeSingle();
    if (error) { res.status(500).json({ error: error.message }); return; }
    if (!pedido) { res.status(404).json({ error: 'Pedido no encontrado' }); return; }
    const { data: items } = await sb().from('pedidos_vendedor_items').select('*').eq('pedido_id', pedido.id).order('orden');
    res.json({ ok: true, pedido, items: items ?? [] });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/** POST /api/pedidos/:id/anular — anula el presupuesto en IM y marca el pedido. */
export async function anularPedido(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const user = req.user!;
    let q = sb().from('pedidos_vendedor').select('*').eq('id', req.params.id).eq('tenant_id', TENANT_ID);
    if (user.rol === 'vendedor') q = q.eq('cod_vendedor', user.cod_vendedor ?? -1);
    const { data: pedido, error } = await q.maybeSingle();
    if (error) { res.status(500).json({ error: error.message }); return; }
    if (!pedido) { res.status(404).json({ error: 'Pedido no encontrado' }); return; }
    if (pedido.estado === 'anulado') { res.status(409).json({ error: 'El pedido ya está anulado' }); return; }
    if (!pedido.im_presupuesto_id || !pedido.im_numero) {
      // Nunca llegó a IM: se anula solo local.
      await sb().from('pedidos_vendedor').update({ estado: 'anulado' }).eq('id', pedido.id);
      res.json({ ok: true, solo_local: true }); return;
    }
    const imRes = await anularComprobante({
      id: pedido.im_presupuesto_id,
      numero: pedido.im_numero,
      punto_de_venta: pedido.im_punto_de_venta ?? PEDIDO_PUNTO_DE_VENTA,
      fecha: new Date(pedido.created_at).toISOString().slice(0, 10),
      observaciones: `Anulado desde app · pedido ${pedido.id.slice(0, 8)}`,
    });
    if (!imRes.ok) {
      res.status(400).json({ ok: false, error: `IM no pudo anular: ${imRes.error}`, raw: imRes.raw }); return;
    }
    const { data } = await sb().from('pedidos_vendedor').update({ estado: 'anulado' }).eq('id', pedido.id).select().maybeSingle();
    res.json({ ok: true, pedido: data });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/** GET /api/pedidos-credito/:cod — saldo + cupo del cliente (semáforo). */
export async function creditoCliente(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const codCliente = Number(req.params.cod);
    if (!codCliente) { res.status(400).json({ error: 'cod_cliente inválido' }); return; }
    const info = await getDisponibleCliente(codCliente);
    res.json({ ok: true, credito: info });
  } catch (err: any) {
    res.status(502).json({ error: `No se pudo consultar el crédito en IM: ${err?.message ?? 'sin respuesta'}` });
  }
}

/**
 * GET /api/pedidos-precio?cod_articulo=&cod_cliente= — precio de un artículo en
 * la lista del cliente (para mostrarlo al agregar al carrito).
 */
export async function precioArticulo(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const codArticulo = Number(req.query.cod_articulo);
    const codCliente = Number(req.query.cod_cliente);
    if (!codArticulo) { res.status(400).json({ error: 'cod_articulo inválido' }); return; }
    // cod_lista explicito manda (el vendedor cambio la lista de ese renglon);
    // si no viene, se usa la del cliente.
    const listaPedida = Number(req.query.cod_lista);
    let codLista = PEDIDO_LISTA_FALLBACK;
    if (Number.isFinite(listaPedida) && listaPedida > 0) {
      codLista = listaPedida;
    } else if (codCliente) {
      try {
        const clientes = await fetchClientesIMCached();
        const cli = clientes.find((c) => Number(c.cod_cliente) === codCliente);
        const l = Number(cli?.lista_precio);
        if (Number.isFinite(l) && l > 0) codLista = l;
      } catch { /* fallback */ }
    }
    const precio = await getPrecioLista(codArticulo, codLista);
    res.json({ ok: true, cod_lista: codLista, precio });
  } catch (err: any) {
    res.status(502).json({ error: `No se pudo consultar el precio en IM: ${err?.message ?? 'sin respuesta'}` });
  }
}

/**
 * GET /api/pedidos-catalogo?q=&todos=1 — catálogo de artículos (para el buscador).
 *
 * Por defecto muestra SOLO lo que hay en el depósito de casa central: el catálogo completo
 * de IM son 1.390 artículos y 804 de ellos existen únicamente en las minoristas, así que el
 * vendedor buscaba entre el doble de cosas de las que puede vender.
 *
 * `todos=1` levanta el filtro. Lo usa el frontend cuando una búsqueda no da resultados, para
 * no bloquear una venta: hay un puñado de artículos que se facturan desde casa central sin
 * figurar en su depósito.
 */
export async function catalogoPedido(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const term = String(req.query.q ?? '').trim().toLowerCase();
    const todos = req.query.todos === '1' || req.query.todos === 'true';
    const map = await fetchArticulosCatalogo();

    let deDeposito: Set<number> | null = null;
    if (!todos) {
      try {
        deDeposito = await fetchArticulosDeDeposito(PEDIDO_DEPOSITO);
      } catch (e: any) {
        // Si IM no responde el stock por depósito, se muestra el catálogo entero: es
        // preferible que sobren productos a que el vendedor no pueda cargar el pedido.
        console.warn('[catalogoPedido] no se pudo filtrar por depósito, muestro todo:', e?.message);
      }
    }

    const all = Array.from(map.entries())
      .filter(([cod]) => !deDeposito || deDeposito.has(cod))
      .map(([cod, a]) => ({
        cod_articulo: cod, descripcion: a.descripcion, precio_venta: a.precio_venta, cod_rubro: a.cod_rubro,
      }));
    const filtered = term
      ? all.filter((a) => a.descripcion.toLowerCase().includes(term) || String(a.cod_articulo).includes(term))
      : all;
    res.json({ ok: true, articulos: filtered.slice(0, 80), solo_casa_central: !todos && !!deDeposito });
  } catch (err: any) {
    res.status(502).json({ error: `No se pudo cargar el catálogo desde IM: ${err?.message ?? 'sin respuesta'}` });
  }
}
