import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { sb, TENANT_ID } from './supabase.js';
import {
  crearPresupuesto, anularComprobante, getPrecioLista, getDisponibleCliente,
  fetchClientesIMCached, fetchArticulosCatalogo, fetchArticulosDeDeposito,
  getItemsComprobante, presupuestoFacturado, actualizarPresupuestoCantidades,
  fechaComprobante, fechaArgentina, fetchVendedores, fetchPreciosDeLista,
} from './infomanager.js';
import type { JwtPayload } from './auth.js';
import {
  clasificarArticulo, evaluarPedido,
  type ArticuloInfo, type ReglaLista, type ReglaDescuento, type ResultadoPedido,
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
/**
 * Con qué usuario de InfoManager se crea el presupuesto.
 *
 * Ojo con qué es este campo: en IM `usuario` no es el vendedor sino el OPERADOR que carga el
 * comprobante — el vendedor viaja aparte, en cod_vendedor. Hasta el 27/08 iba siempre el
 * usuario único de la app, así que en IM todos los pedidos figuraban cargados por la misma
 * persona (verificado: de 1.052 comprobantes de Casa Central, jorgelina cargó 879 y susana
 * 143, cada una para 6 o 7 vendedores distintos).
 *
 * Se resuelve en tres pasos, y el orden importa:
 *   1. `usuarios.im_usuario` — override manual nuestro. Gana siempre, para poder arreglar un
 *      caso puntual sin depender de que alguien toque IM.
 *   2. El campo `usuario` de la ficha del vendedor en IM (GET /vendedores). Es la fuente
 *      natural: se carga una vez allá y no hay nada que mantener sincronizado de este lado.
 *      Al 27/08/2026 viene null en los 12 vendedores — el campo existe, está sin cargar.
 *   3. IM_USUARIO_PEDIDOS, el usuario único de la app. Lo de siempre.
 *
 * 🪤 El paso 1 se lee de la base ACÁ y no del JWT. Es un dato de configuración, no una
 * credencial: si viajara en el token, cambiarlo por SQL no haría efecto hasta que el vendedor
 * cerrara sesión y volviera a entrar (el token dura 8 horas). Una query por pedido no se nota
 * y el cambio toma efecto al instante.
 *
 * El fallback NO es cosmético: un usuario que IM no reconozca puede hacer que rechace el
 * presupuesto entero, y ahí ningún vendedor puede cargar nada. Si IM o Supabase no contestan,
 * o el campo está vacío, se usa el que ya sabemos que funciona.
 */
export async function usuarioIM(
  user?: { sub?: string; cod_vendedor?: number | null } | null,
): Promise<string> {
  if (user?.sub) {
    try {
      const { data } = await sb().from('usuarios')
        .select('im_usuario').eq('tenant_id', TENANT_ID).eq('id', user.sub).maybeSingle();
      const propio = String(data?.im_usuario ?? '').trim();
      if (propio) return propio;
    } catch (e: any) {
      console.warn('[usuarioIM] no pude leer usuarios.im_usuario:', e?.message);
    }
  }

  const cod = Number(user?.cod_vendedor);
  if (Number.isFinite(cod) && cod > 0) {
    try {
      // fetchVendedores cachea, así que esto no agrega requests a IM por pedido.
      const v = (await fetchVendedores()).find((x) => Number(x.cod_vendedor) === cod);
      const deIM = String(v?.usuario ?? '').trim();
      if (deIM) return deIM;
    } catch (e: any) {
      console.warn('[usuarioIM] no pude leer /vendedores, uso el usuario de la app:', e?.message);
    }
  }
  return IM_USUARIO_PEDIDOS;
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
// ¿Frenar el pedido cuando se vende por debajo de la lista que corresponde?
// Mati lo pidió el 26/08 y lo dio de baja el 27/08: mientras la parametrización se sigue
// afinando, un falso positivo le bloquea una venta legítima al vendedor. Queda como flag
// para poder prenderlo sin tocar código cuando las reglas estén maduras. Default: apagado.
const BLOQUEAR_POR_MARGEN = String(env.PEDIDOS_BLOQUEAR_MARGEN || '').toLowerCase() === 'true' || env.PEDIDOS_BLOQUEAR_MARGEN === '1';

interface ItemInput { cod_articulo: number; cantidad: number; cod_lista?: number; descuento_porc?: number }

/**
 * Listas mayoristas validas (IM): 12=L1 13=L2 14=L3 15=L4, 9=MINORISTA, 11=SUCURSALES.
 * El vendedor elige la lista RENGLON POR RENGLON segun la cantidad — asi trabajan
 * hoy en IM. Si no manda ninguna, se usa la del cliente.
 */
const LISTAS_VALIDAS = new Set([9, 11, 12, 13, 14, 15]);
// 1 = Casa Central, 2 = BRS, 3 = San Juan, 6 = Jujuy. Los pedidos de vendedor son de CC,
// pero la lista queda abierta a las otras por si mañana se usa desde una sucursal.
const EMPRESAS_VALIDAS = new Set([1, 2, 3, 6]);

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

// Qué descuento admite cada renglón. Mismo TTL que las reglas de lista.
let _descCache: { reglas: ReglaDescuento[]; fetchedAt: number } | null = null;

async function descuentosActivos(): Promise<ReglaDescuento[]> {
  if (_descCache && Date.now() - _descCache.fetchedAt < REGLAS_TTL_MS) return _descCache.reglas;
  const { data, error } = await sb().from('descuentos_reglas')
    .select('nombre, match_tipo, match_valor, desde_cantidad, ambito, porcentaje_max, requiere_lista, requiere_mejor_lista, aviso')
    .eq('tenant_id', TENANT_ID).eq('activo', true);
  if (error) throw new Error(`descuentos_reglas: ${error.message}`);
  const reglas = (data ?? []).map((g: any) => ({
    ...g,
    desde_cantidad: Number(g.desde_cantidad),
    porcentaje_max: Number(g.porcentaje_max),
    requiere_lista: g.requiere_lista == null ? null : Number(g.requiere_lista),
  })) as ReglaDescuento[];
  _descCache = { reglas, fetchedAt: Date.now() };
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
async function controlarListas(
  items: Array<{ cod_articulo: number; cantidad: number; cod_lista: number; descuento?: number }>,
  opts: { silenciar?: boolean; abortado?: () => boolean } = {},
): Promise<ResultadoPedido | null> {
  try {
    // Las dos salen de Supabase (no de IM), así que en paralelo no rompe la regla de oro.
    const [reglas, descuentos] = await Promise.all([reglasActivas(), descuentosActivos()]);
    const catalogo = await catalogoParaListas();
    const r = evaluarPedido(items, catalogo, reglas, descuentos);
    // Silenciar el falso positivo cuesta hasta 2 GETs a IM por renglón, EN SERIE. Vale la
    // pena mientras el vendedor arma el carrito y va a leer los carteles; no vale nada al
    // confirmar, donde el resultado se guarda pero ya nadie lo mira.
    if (opts.silenciar !== false) await silenciarSiElPrecioYaEstaBien(r, items, opts.abortado);
    return r;
  } catch (e: any) {
    console.warn('[controlarListas] no se pudo evaluar, sigo sin control:', e?.message);
    return null;
  }
}


/**
 * Un descuento y una lista son dos caminos al MISMO precio, y el vendedor elige cuál usar
 * (Mati, 27/08: "conviven las dos"). Se verificó contra los precios reales: en los cereales
 * de desayuno, L1 con 25% da exactamente L2, y con 30% exactamente L3.
 *
 * Entonces el aviso "tiene derecho a L2 y está en L1, le estás cobrando de más" es un FALSO
 * POSITIVO cuando el renglón lleva un descuento que ya lo deja en ese precio o mejor. Acá se
 * compara la PLATA en vez de la etiqueta de la lista, y se silencia el aviso si corresponde.
 *
 * Sólo se consultan precios para los renglones que tienen aviso Y descuento, que son pocos, y
 * getPrecioLista cachea 5 minutos: en el peor caso son dos requests por renglón, la primera vez.
 */
async function silenciarSiElPrecioYaEstaBien(
  r: ResultadoPedido,
  items: Array<{ cod_articulo: number; cod_lista: number; descuento?: number }>,
  abortado?: () => boolean,
): Promise<void> {
  for (const a of r.avisos) {
    // 🪤 El vendedor tipea, se dispara un validar, y antes de que termine tipea otra vez: el
    // navegador aborta el primero pero el server seguía barriendo renglón por renglón contra
    // IM para armar una respuesta que ya nadie iba a leer. Con el carrito grande eso son
    // decenas de round-trips tirados, y encima le comen el turno al request que sí importa.
    if (abortado?.()) return;
    if (a.severidad !== 'cliente' || a.lista_sugerida == null) continue;
    // 🪤 Era items.find(x => x.cod_articulo === a.cod_articulo), que con el mismo articulo en
    // dos renglones agarra SIEMPRE el primero: el descuento de uno decidia si se silenciaba el
    // aviso del otro. El caso caro es el renglon SIN descuento, al que se le tapaba un
    // "le estas cobrando de mas" real. El aviso ya sabe su posicion.
    const it = items[a.idx];
    const desc = Number(it?.descuento) || 0;
    if (!it || desc <= 0) continue;
    try {
      const [elegida, sugerida] = [
        await getPrecioLista(a.cod_articulo, a.lista_elegida),
        await getPrecioLista(a.cod_articulo, a.lista_sugerida),
      ];
      if (!elegida || !sugerida) continue;
      const final = elegida.precio_vta * (1 - desc / 100);
      // Un centavo de tolerancia: los precios de IM vienen con decimales redondeados.
      if (final <= sugerida.precio_vta + 0.01) {
        a.severidad = 'ok';
        a.mensaje = null;
      }
    } catch (e: any) {
      // Si no se puede consultar el precio, se deja el aviso como estaba: avisar de más es
      // mejor que callar un caso real.
      console.warn('[controlarListas] no pude comparar precios:', e?.message);
    }
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
      .map((it: any) => ({ cod_articulo: Number(it.cod_articulo), cantidad: Number(it.cantidad), cod_lista: Number(it.cod_lista), descuento: Number(it.descuento_porc) || 0 }))
      .filter((it: any) => it.cod_articulo > 0 && it.cantidad > 0);
    if (!items.length) { res.json({ ok: true, bultos: 0, promo_general: false, avisos: [] }); return; }
    // El front debounce 400 ms y aborta el pedido anterior, pero eso solo corta el socket: sin
    // esto el server seguia barriendo IM renglon por renglon para una respuesta ya descartada.
    let cortado = false;
    req.on('close', () => { cortado = true; });
    const r = await controlarListas(items, { abortado: () => cortado });
    if (cortado) return;
    if (!r) { res.json({ ok: true, sin_control: true, bultos: 0, promo_general: false, avisos: [] }); return; }
    res.json({ ok: true, ...r });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}


/**
 * Firma de los renglones de un pedido: qué artículo, en qué lista y con qué descuento, EN
 * ORDEN. Si dos pedidos tienen la misma firma, alcanza con mandarle a IM las cantidades
 * nuevas; si no, hay que anular el presupuesto y crearlo de nuevo.
 *
 * 🪤 Esto ordenaba (`.sort()`) y era un agujero de plata. El emparejado con los renglones de
 * IM es POR POSICIÓN, así que la firma también tiene que serlo: si el vendedor borra uno de
 * los dos renglones del mismo artículo y lo vuelve a cargar, el renglón nuevo queda al final,
 * el multiconjunto no cambia, la firma ordenada da igual y se toma el camino barato... con
 * las cantidades cruzadas. Y como cada renglón de IM tiene su precio y su descuento
 * CONGELADOS desde que se creó, la cantidad de uno se factura al precio del otro.
 * Reproducido: $24.320 de diferencia en un pedido de dos renglones, contestando ok:true.
 * Sin el sort, cualquier reordenamiento cae en anular-y-recrear, que siempre da bien.
 */
export function firmaRenglones(
  xs: Array<{ cod_articulo: any; cod_lista: any; descuento_porc?: any }>,
): string {
  return xs.map((x) => `${Number(x.cod_articulo)}:${Number(x.cod_lista)}:${Number(x.descuento_porc) || 0}`).join('|');
}

/**
 * Empareja cada renglón del pedido con el renglón de IM al que le corresponde, consumiendo
 * una cola por artículo: la n-ésima aparición de un código acá es la n-ésima de allá, porque
 * se crearon en este mismo orden. Devuelve null si algún renglón se queda sin pareja — ahí
 * hay que frenar, no adivinar.
 */
export function emparejarRenglonesIM(
  nuevos: Array<{ cod_articulo: number; cantidad: number }>,
  imItems: Array<{ id: number; cod_articulo: number }>,
): Array<{ id: number; cantidad: number }> | null {
  const cola = new Map<number, number[]>();
  for (const it of imItems) {
    const q = cola.get(it.cod_articulo) ?? [];
    q.push(it.id);
    cola.set(it.cod_articulo, q);
  }
  const payload: Array<{ id: number; cantidad: number }> = [];
  for (const it of nuevos) {
    const id = cola.get(it.cod_articulo)?.shift();
    if (!Number.isFinite(id)) return null;
    payload.push({ id: id as number, cantidad: it.cantidad });
  }
  return payload;
}

/** Un renglón ya resuelto: con su precio, su lista y su subtotal. */
export interface ItemResuelto {
  cod_articulo: number; cantidad: number; cod_lista: number;
  descripcion: string; precio: number; iva: number; subtotal: number;
  /** Descuento del renglón, 0 a 100. El subtotal ya lo tiene aplicado. */
  descuento_porc: number;
}

/**
 * Le pone precio a cada renglón y corre el control de listas. Devuelve el motivo del
 * rechazo si el pedido no puede seguir, para que crearPedido y editarPedido respondan igual.
 *
 * Los precios se piden SECUENCIALMENTE: IM se satura con requests en paralelo.
 */
async function resolverYControlar(
  itemsValidos: Array<{ cod_articulo: number; cantidad: number; cod_lista?: number; descuento_porc?: number }>,
  codListaCliente: number,
  etiqueta: string,
): Promise<
  | { ok: true; items: ItemResuelto[]; total: number; control: ResultadoPedido | null }
  | { ok: false; status: number; body: Record<string, any> }
> {
  const items: ItemResuelto[] = [];
  let total = 0;
  for (const it of itemsValidos) {
    // La lista del RENGLON manda; si el vendedor no eligió una, va la del cliente.
    const listaItem = it.cod_lista ?? codListaCliente;
    let precio = 0, iva = 21, descripcion = '';
    try {
      const p = await getPrecioLista(it.cod_articulo, listaItem);
      if (p) { precio = p.precio_vta; iva = p.iva; descripcion = p.descripcion; }
    } catch (e: any) {
      console.warn(`[${etiqueta}] precio-ldp falló art=${it.cod_articulo} lista=${listaItem}:`, e?.message);
    }
    // El descuento se aplica al subtotal que guardamos, pero a IM se le manda aparte
    // (precio + descuento_porc) para que el comprobante lo muestre desglosado.
    const desc = Math.min(Math.max(Number(it.descuento_porc) || 0, 0), 100);
    const subtotal = Math.round(precio * it.cantidad * (1 - desc / 100) * 100) / 100;
    total += subtotal;
    items.push({ cod_articulo: it.cod_articulo, cantidad: it.cantidad, cod_lista: listaItem, descripcion, precio, iva, subtotal, descuento_porc: desc });
  }
  total = Math.round(total * 100) / 100;

  // 🪤 Sin precio no se vende. IM contesta 200 con el error en el body cuando el artículo no
  // está en esa lista, y eso pasaba como precio 0: el renglón se guardaba en cero y se
  // mandaba así. Pasó con el art 918 COLLAR AHORQUE CHICO en Lista 3.
  const sinPrecio = items.filter((it) => !(it.precio > 0));
  if (sinPrecio.length) {
    const nombres = sinPrecio.map((it) => it.descripcion || `artículo ${it.cod_articulo}`).join(', ');
    return { ok: false, status: 422, body: {
      ok: false, bloqueado: true,
      error: `${nombres}: no tiene precio cargado en la lista elegida. Probá con otra lista o avisá a la oficina.`,
      sin_precio: sinPrecio.map((it) => ({ cod_articulo: it.cod_articulo, cod_lista: it.cod_lista })),
    } };
  }

  // 🔒 Vender MÁS BARATO de lo que corresponde se FRENA (Mati, 26/08: "no le deje
  // presupuestar un producto a un precio más bajo del que le corresponde, sino pierde el
  // sentido de ese control"). Es plata que se pierde y no la recupera nadie después.
  //
  // Al revés NO se frena: cobrarle de más a un cliente que tenía derecho a mejor precio se
  // avisa, pero el vendedor puede tener un motivo. Y si el control no pudo correr (IM caído,
  // Supabase sin responder) tampoco se frena: no se pierde una venta por un problema nuestro.
  const control = await controlarListas(items.map((it) => ({
    cod_articulo: it.cod_articulo, cantidad: it.cantidad, cod_lista: it.cod_lista, descuento: it.descuento_porc,
  })), { silenciar: false });
  // Sin precio SÍ se frena siempre (arriba): no es una regla comercial opinable, es que el
  // artículo no tiene precio en esa lista y no se puede vender. Lo de abajo es distinto:
  // es nuestra parametrización diciendo que el precio es más bajo del que corresponde.
  const bloqueos = BLOQUEAR_POR_MARGEN
    ? (control?.avisos ?? []).filter((a) => a.severidad === 'margen')
    : [];
  if (bloqueos.length) {
    return { ok: false, status: 422, body: {
      ok: false, bloqueado: true,
      error: bloqueos.length === 1
        ? bloqueos[0].mensaje
        : `Hay ${bloqueos.length} renglones con la lista mal elegida. Corregilos antes de enviar el pedido.`,
      // 🪤 Acá iba `bloqueos`, que es la lista FILTRADA. El front indexa los avisos por
      // posición del renglón, así que un array filtrado le corre todos los carteles: le
      // marcaba el renglón equivocado y el botón de un toque le cambiaba la lista al que no
      // era. Va la lista completa; cuál frena se sabe por la severidad de cada uno.
      avisos: control?.avisos ?? bloqueos,
    } };
  }
  return { ok: true, items, total, control };
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
        descuento_porc: Math.min(Math.max(Number(it.descuento_porc) || 0, 0), 100),
      }))
      .filter((it) => it.cod_articulo > 0 && it.cantidad > 0);
    if (!itemsValidos.length) { res.status(400).json({ error: 'El pedido no tiene items válidos' }); return; }

    // El cod_empresa venía del body sin validar: un numero cualquiera creaba el presupuesto
    // en una empresa que no existe (o en otra sucursal). Misma lista blanca que las listas.
    const codEmpresaPedido = Number(body.cod_empresa);
    const codEmpresa = EMPRESAS_VALIDAS.has(codEmpresaPedido) ? codEmpresaPedido : PEDIDO_EMPRESA_DEFAULT;
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

    const resuelto = await resolverYControlar(itemsValidos, codLista, 'crearPedido');
    if (!resuelto.ok) { res.status(resuelto.status).json(resuelto.body); return; }
    const { items: itemsConPrecio, total: totalEstimado, control } = resuelto;
    // 🪤 Esto era un Map por cod_articulo. Ahora el mismo articulo puede ir en DOS renglones
    // (distinta lista o distinto descuento) y el Map se quedaba con UNO solo: las dos filas
    // guardaban el aviso del ultimo. evaluarPedido devuelve un aviso por renglon y EN ORDEN,
    // asi que la posicion es la forma correcta de emparejarlos.
    const avisoDe = (i: number) => control?.avisos[i];

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
    // 🪤 Este insert no chequeaba `error`. supabase-js no tira excepción: resuelve con
    // {data:null, error}, así que el flujo seguía derecho, posteaba a IM y respondía "ok"
    // dejando una cabecera con total y CERO renglones. Si faltara una migración, pasaría
    // en el 100% de los pedidos y en silencio.
    const { error: itemsErr } = await sb().from('pedidos_vendedor_items').insert(itemsConPrecio.map((it, i) => {
      const av = avisoDe(i);
      return {
        pedido_id: pedidoId,
        cod_articulo: it.cod_articulo,
        descripcion: it.descripcion || null,
        cantidad: it.cantidad,
        precio_unit: it.precio,
        cod_lista_precios: it.cod_lista,
        descuento_porc: it.descuento_porc,
        lista_sugerida: av?.lista_sugerida ?? null,
        aviso_lista: [av?.mensaje, av?.mensaje_descuento].filter(Boolean).join(' · ') || null,
        iva_por: it.iva,
        subtotal: it.subtotal,
        orden: i,
      };
    }));
    if (itemsErr) {
      // Antes de tocar IM: sin renglones el pedido no sirve, y la cabecera sola es basura.
      await sb().from('pedidos_vendedor').delete().eq('id', pedidoId);
      console.error('[crearPedido] insert de items falló:', itemsErr.message);
      res.status(500).json({ error: `No se pudieron guardar los renglones del pedido: ${itemsErr.message}` });
      return;
    }

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
      usuario: await usuarioIM(user),
      punto_de_venta: PEDIDO_PUNTO_DE_VENTA,
      // 🪤 Era un ternario: si el vendedor escribia CUALQUIER cosa, el marcador desaparecia.
      // El campo `usuario` de IM es el operador de la oficina (hoy siempre el mismo para todos
      // los pedidos de la app), asi que esta es la unica linea de la cabecera donde se lee en
      // criollo quien armo el pedido. Va de PREFIJO, y con el nombre en vez del codigo: el
      // corte a 500 es por la cola, asi que lo que va primero nunca se pierde.
      observaciones: `Pedido app · ${user.nombre || `vend ${codVendedor}`}${body.observaciones ? ` · ${String(body.observaciones)}` : ''}`.slice(0, 500),
      cod_compatibilidad: pedidoId.slice(0, 8),
      items: itemsConPrecio.map((it) => ({
        cod_articulo: it.cod_articulo,
        cantidad: it.cantidad,
        precio: it.precio > 0 ? String(it.precio) : undefined,
        iva_por: it.iva,
        descuento_porc: it.descuento_porc > 0 ? it.descuento_porc : undefined,
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
    const { data: pedidoFinal, error: errUpd } = await sb().from('pedidos_vendedor')
      .update(update).eq('id', pedidoId).select().maybeSingle();
    if (errUpd) {
      // Si esto falla justo despues de que IM creo el presupuesto, el pedido queda 'borrador'
      // con im_presupuesto_id NULL para siempre y la UI decia "Pedido cargado" en verde. No se
      // puede deshacer lo de IM, asi que al menos que quede el numero en el log y que el
      // vendedor sepa que tiene que mirarlo.
      console.error(`[crearPedido] pedido ${pedidoId}: IM contesto ${JSON.stringify(update)} pero Supabase no lo guardo: ${errUpd.message}`);
    }

    if (imRes.ok) {
      res.json({ ok: true, pedido: pedidoFinal ?? { id: pedidoId, ...update },
        ...(errUpd ? { aviso: `El pedido entró a InfoManager (presupuesto ${imRes.numero ?? imRes.id}) pero no se pudo guardar en la app. Anotalo: puede no aparecer en «Mis pedidos».` } : {}) });
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

/**
 * PUT /api/pedidos/:id — editar un pedido que todavía no se facturó.
 *
 * Híbrido, porque InfoManager no deja hacer todo (Mati eligió esto el 26/08):
 *   · si SOLO cambiaron cantidades  -> PUT /presupuestos/{id} y el número se conserva.
 *   · si cambió el surtido o alguna lista -> se anula el presupuesto y se crea uno nuevo,
 *     porque el schema VentasPresupuestosActualizar sólo acepta {id, cantidad} por renglón:
 *     no se pueden agregar ni sacar productos, ni cambiar la lista de precios.
 * La respuesta dice cuál de los dos caminos se tomó (`numero_cambio`) para que el frontend
 * pueda avisarle al vendedor que el presupuesto pasó a tener otro número.
 *
 * Quién puede: el vendedor sus propios pedidos; admin y gerencia cualquiera (Jorgelina
 * necesita poder corregir lo que ve, que es justamente lo que le queremos ahorrar a mano).
 */
export async function editarPedido(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const user = req.user!;
    let q = sb().from('pedidos_vendedor').select('*').eq('id', req.params.id).eq('tenant_id', TENANT_ID);
    if (user.rol === 'vendedor') q = q.eq('cod_vendedor', user.cod_vendedor ?? -1);
    const { data: pedido, error } = await q.maybeSingle();
    if (error) { res.status(500).json({ error: error.message }); return; }
    if (!pedido) { res.status(404).json({ error: 'Pedido no encontrado' }); return; }

    if (pedido.estado === 'anulado') { res.status(409).json({ error: 'El pedido está anulado: no se puede editar.' }); return; }
    if (pedido.estado === 'facturado') { res.status(409).json({ error: 'El pedido ya está facturado: no se puede editar.' }); return; }
    if (pedido.estado === 'sin_respuesta') {
      res.status(409).json({ error: 'No sabemos si este pedido entró en InfoManager. Revisalo a mano antes de tocarlo.' }); return;
    }

    // ¿Ya lo facturaron en IM mientras tanto? Si sí, se sincroniza el estado y se corta.
    if (pedido.im_presupuesto_id) {
      const f = await presupuestoFacturado(pedido.im_presupuesto_id);
      if (f.desconocido) {
        res.status(502).json({ error: 'No se pudo verificar en InfoManager si el pedido ya está facturado. Probá de nuevo en un rato.' }); return;
      }
      if (f.facturado) {
        await sb().from('pedidos_vendedor').update({ estado: 'facturado' }).eq('id', pedido.id);
        res.status(409).json({ error: 'El pedido ya fue facturado en InfoManager: no se puede editar.' }); return;
      }
    }

    const body = req.body ?? {};
    const itemsInput: ItemInput[] = Array.isArray(body.items) ? body.items : [];
    const itemsValidos = itemsInput
      .map((it) => ({
        cod_articulo: Number(it.cod_articulo),
        cantidad: Number(it.cantidad),
        cod_lista: LISTAS_VALIDAS.has(Number(it.cod_lista)) ? Number(it.cod_lista) : undefined,
        descuento_porc: Math.min(Math.max(Number(it.descuento_porc) || 0, 0), 100),
      }))
      .filter((it) => it.cod_articulo > 0 && it.cantidad > 0);
    if (!itemsValidos.length) { res.status(400).json({ error: 'El pedido no tiene items válidos' }); return; }

    const resuelto = await resolverYControlar(itemsValidos, Number(pedido.cod_lista_precios) || PEDIDO_LISTA_FALLBACK, 'editarPedido');
    if (!resuelto.ok) { res.status(resuelto.status).json(resuelto.body); return; }
    const { items: nuevos, total, control } = resuelto;
    // 🪤 Esto era un Map por cod_articulo. Ahora el mismo articulo puede ir en DOS renglones
    // (distinta lista o distinto descuento) y el Map se quedaba con UNO solo: las dos filas
    // guardaban el aviso del ultimo. evaluarPedido devuelve un aviso por renglon y EN ORDEN,
    // asi que la posicion es la forma correcta de emparejarlos.
    const avisoDe = (i: number) => control?.avisos[i];

    // ¿Alcanza con actualizar cantidades? Sólo si el surtido y las listas son los mismos.
    // `.order('orden')` no es opcional: la firma compara EN ORDEN (ver firmaRenglones) y sin
    // esto Supabase devuelve las filas en cualquier orden.
    const { data: actuales } = await sb().from('pedidos_vendedor_items')
      .select('cod_articulo, cod_lista_precios, descuento_porc, orden')
      .eq('pedido_id', pedido.id).order('orden');
    // El DESCUENTO está en la firma porque IM sólo deja cambiar `cantidad` sobre un
    // presupuesto existente: si el descuento cambia y la firma no se entera, la app guarda el
    // 25%, contesta "modificado en InfoManager" y a IM no llega nunca.
    const soloCantidades = firmaRenglones(nuevos) === firmaRenglones((actuales ?? []).map((a: any) => ({
      cod_articulo: a.cod_articulo, cod_lista: a.cod_lista_precios, descuento_porc: a.descuento_porc,
    })));

    const observaciones = body.observaciones != null ? String(body.observaciones) : pedido.observaciones;
    let numeroCambio = false;
    let imUpdate: Record<string, any> = {};

    if (PEDIDOS_DRY_RUN || !pedido.im_presupuesto_id) {
      // Nunca llegó a IM (dry-run o quedó en borrador): sólo se reescribe en Supabase.
      console.log('[editarPedido] sin push a IM (dry_run o pedido en borrador)', pedido.id);
    } else if (soloCantidades) {
      // Camino barato: se conserva el número de presupuesto.
      const imItems = await getItemsComprobante(pedido.im_presupuesto_id);
      // Emparejado por posición dentro de cada artículo. Sólo es válido porque la firma de
      // arriba también es sensible al orden: si el vendedor reordenó algo, no llegamos acá.
      const payload = emparejarRenglonesIM(nuevos, imItems);
      if (!payload) {
        res.status(409).json({ error: 'Los renglones del presupuesto en InfoManager no coinciden con los de la app. Anulá el pedido y cargalo de nuevo.' });
        return;
      }
      const r = await actualizarPresupuestoCantidades(pedido.im_presupuesto_id, payload);
      if (!r.ok) { res.status(400).json({ ok: false, error: `InfoManager no pudo actualizar el presupuesto: ${r.error}`, raw: r.raw }); return; }
    } else {
      // Cambió el surtido o una lista: IM no lo permite sobre el mismo presupuesto.
      const anul = await anularComprobante({
        id: pedido.im_presupuesto_id,
        numero: pedido.im_numero,
        punto_de_venta: pedido.im_punto_de_venta ?? PEDIDO_PUNTO_DE_VENTA,
        fecha: (await fechaComprobante(pedido.im_presupuesto_id)) ?? fechaArgentina(pedido.created_at),
        observaciones: `Reemplazado por edición · pedido ${String(pedido.id).slice(0, 8)}`,
      });
      if (!anul.ok) {
        res.status(400).json({ ok: false, error: `No se pudo anular el presupuesto anterior en InfoManager: ${anul.error}. No se cambió nada.` });
        return;
      }
      const imRes = await crearPresupuesto({
        cod_empresa: Number(pedido.cod_empresa) || PEDIDO_EMPRESA_DEFAULT,
        cod_cliente: Number(pedido.cod_cliente),
        cod_vendedor: Number(pedido.cod_vendedor),
        cod_lista_precios: Number(pedido.cod_lista_precios) || PEDIDO_LISTA_FALLBACK,
        usuario: await usuarioIM(user),
        punto_de_venta: PEDIDO_PUNTO_DE_VENTA,
        observaciones: `Pedido app · ${user.nombre || `vend ${pedido.cod_vendedor}`}${observaciones ? ` · ${observaciones}` : ''}`.slice(0, 500),
        cod_compatibilidad: String(pedido.id).slice(0, 8),
        items: nuevos.map((it) => ({
          cod_articulo: it.cod_articulo, cantidad: it.cantidad,
          precio: it.precio > 0 ? String(it.precio) : undefined, iva_por: it.iva,
          descuento_porc: it.descuento_porc > 0 ? it.descuento_porc : undefined,
        })),
      });
      if (!imRes.ok) {
        // El viejo quedó anulado y el nuevo no entró: hay que decirlo fuerte, no dejarlo pasar.
        await sb().from('pedidos_vendedor').update({
          estado: imRes.sinRespuesta ? 'sin_respuesta' : 'error', im_error: imRes.error,
        }).eq('id', pedido.id);
        res.status(imRes.sinRespuesta ? 202 : 400).json({
          ok: false,
          error: `Se anuló el presupuesto ${pedido.im_numero} pero el nuevo NO se pudo crear: ${imRes.error}. Revisalo en InfoManager.`,
        });
        return;
      }
      numeroCambio = true;
      imUpdate = { im_presupuesto_id: imRes.id, im_numero: imRes.numero, im_error: null };
    }

    // Los renglones se reemplazan enteros: es más simple y no deja restos. Se chequean los
    // dos: si sale el delete y falla el insert, el pedido queda sin renglones y el
    // presupuesto en IM ya está actualizado — hay que decirlo, no responder ok.
    const { error: delErr } = await sb().from('pedidos_vendedor_items').delete().eq('pedido_id', pedido.id);
    if (delErr) {
      res.status(500).json({ error: `No se pudieron reemplazar los renglones: ${delErr.message}` });
      return;
    }
    const { error: insErr2 } = await sb().from('pedidos_vendedor_items').insert(nuevos.map((it, i) => {
      const av = avisoDe(i);
      return {
        pedido_id: pedido.id,
        cod_articulo: it.cod_articulo,
        descripcion: it.descripcion || null,
        cantidad: it.cantidad,
        precio_unit: it.precio,
        cod_lista_precios: it.cod_lista,
        descuento_porc: it.descuento_porc,
        lista_sugerida: av?.lista_sugerida ?? null,
        aviso_lista: [av?.mensaje, av?.mensaje_descuento].filter(Boolean).join(' · ') || null,
        iva_por: it.iva,
        subtotal: it.subtotal,
        orden: i,
      };
    }));
    if (insErr2) {
      await sb().from('pedidos_vendedor').update({
        estado: 'error',
        im_error: `Los renglones no se pudieron guardar en la app: ${insErr2.message}. En InfoManager el presupuesto SÍ quedó actualizado.`,
      }).eq('id', pedido.id);
      res.status(500).json({ error: `El presupuesto se actualizó en InfoManager pero los renglones no se pudieron guardar acá: ${insErr2.message}. Revisalo.` });
      return;
    }
    const { data: final } = await sb().from('pedidos_vendedor')
      .update({ total_estimado: total, observaciones, ...imUpdate })
      .eq('id', pedido.id).select().maybeSingle();

    res.json({ ok: true, pedido: final, numero_cambio: numeroCambio, solo_cantidades: soloCantidades });
  } catch (err: any) {
    console.error('editarPedido error:', err);
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
    if (pedido.estado === 'facturado') { res.status(409).json({ error: 'El pedido ya está facturado: no se puede anular desde acá.' }); return; }
    if (pedido.estado === 'sin_respuesta') {
      // IM nunca contesto: NO se sabe si el presupuesto existe. Marcarlo anulado sin tocar IM
      // deja un PR vivo alla que nadie va a volver a mirar. Que lo verifique una persona.
      res.status(409).json({ error: 'InfoManager no contestó cuando se creó este pedido: no se sabe si entró. Verificalo en IM antes de anularlo.' });
      return;
    }
    if (!pedido.im_presupuesto_id || !pedido.im_numero) {
      // Nunca llegó a IM: se anula solo local.
      await sb().from('pedidos_vendedor').update({ estado: 'anulado' }).eq('id', pedido.id);
      res.json({ ok: true, solo_local: true }); return;
    }
    // ¿Ya lo facturaron? Anular un presupuesto facturado deja la factura sin respaldo.
    const fact = await presupuestoFacturado(pedido.im_presupuesto_id);
    if (fact.facturado) {
      await sb().from('pedidos_vendedor').update({ estado: 'facturado' }).eq('id', pedido.id);
      res.status(409).json({ error: 'El pedido ya fue facturado en InfoManager: no se puede anular.' }); return;
    }
    const imRes = await anularComprobante({
      id: pedido.im_presupuesto_id,
      numero: pedido.im_numero,
      punto_de_venta: pedido.im_punto_de_venta ?? PEDIDO_PUNTO_DE_VENTA,
      fecha: (await fechaComprobante(pedido.im_presupuesto_id)) ?? fechaArgentina(pedido.created_at),
      observaciones: `Anulado desde app · pedido ${pedido.id.slice(0, 8)}`,
    });
    if (!imRes.ok) {
      // 🪤 Si alguien borró el presupuesto a mano desde InfoManager, el id ya no existe y
      // el pedido quedaría trabado para siempre en "enviado". Pasó el 27/08: Mati borró el
      // 57818 desde IM. En ese caso se marca anulado igual y se deja constancia.
      const noExiste = /no se encontraron datos|no existe/i.test(String(imRes.error ?? ''));
      if (noExiste) {
        const { data } = await sb().from('pedidos_vendedor').update({
          estado: 'anulado',
          im_error: 'El presupuesto ya no existe en InfoManager (lo borraron desde ahí).',
        }).eq('id', pedido.id).select().maybeSingle();
        res.json({ ok: true, pedido: data, ya_no_estaba: true });
        return;
      }
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
    // Saldo, cupo y margen de acuerdos son datos sensibles: un vendedor solo puede ver los de
    // SUS clientes. Mismo chequeo que historialCompras, contra el cache de clientes de IM.
    const user = req.user!;
    if (user.rol === 'vendedor') {
      const clientesIM = await fetchClientesIMCached();
      const cli = clientesIM.find((c: any) => Number(c.cod_cliente) === codCliente);
      if (!cli || Number(cli.cod_vendedor) !== Number(user.cod_vendedor)) {
        res.status(403).json({ error: 'Cliente no pertenece al vendedor' });
        return;
      }
    }
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
      .map(([cod, a]) => ({ cod_articulo: cod, descripcion: a.descripcion, cod_rubro: a.cod_rubro }));
    const filtered = term
      ? all.filter((a) => a.descripcion.toLowerCase().includes(term) || String(a.cod_articulo).includes(term))
      : all;
    const pagina = filtered.slice(0, 80);

    // 🪤 Acá se devolvía `precio_venta` del catálogo de /articulos/stock. Ese campo está
    // muerto en IM: 31% de los artículos lo tienen en 0 (justo las bolsas del mayorista) y
    // cuando trae un número tampoco es el real. El precio bueno sale de la lista de precios,
    // que se trae entera de una sola llamada y se cachea una hora.
    const codLista = LISTAS_VALIDAS.has(Number(req.query.cod_lista))
      ? Number(req.query.cod_lista) : PEDIDO_LISTA_FALLBACK;
    let precios = new Map<number, number>();
    try { precios = await fetchPreciosDeLista(codLista); } catch { /* va sin precio */ }

    res.json({
      ok: true,
      cod_lista: codLista,
      // Si la lista entera vino vacía es que no se pudo consultar, no que 80 artículos no
      // tengan precio. El front lo dice distinto: "no tiene precio" y "no lo pude averiguar"
      // son dos cosas y el vendedor decide distinto en cada caso.
      hay_precios: precios.size > 0,
      // null y no 0: el front tiene que poder distinguir "no sé el precio" de "vale cero".
      articulos: pagina.map((a) => ({ ...a, precio_venta: precios.get(a.cod_articulo) ?? null })),
      solo_casa_central: !todos && !!deDeposito,
    });
  } catch (err: any) {
    res.status(502).json({ error: `No se pudo cargar el catálogo desde IM: ${err?.message ?? 'sin respuesta'}` });
  }
}
