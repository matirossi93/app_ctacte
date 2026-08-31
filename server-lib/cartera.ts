import type { Request, Response } from 'express';
import type { JwtPayload } from './auth.js';
import { sb, TENANT_ID } from './supabase.js';
import { fechaArgentina, fetchClientesIMCached, fetchVendedores } from './infomanager.js';
import { filaUsuario } from './perfilUsuario.js';
import {
  agruparConciliacion, armarConciliacion, fetchRecibosTransito,
  getSnapshotConciliacion, hoyISOArgentina,
  type ClienteMaestro, type MaestroSnapshot, type PendienteIM, type ReciboTransito, type ResultadoConciliacion,
} from './conciliacion.js';
import { ESTADOS_NO_TERMINALES } from './conciliacion.js';
import { normalizarInvoices, resolverSinVendedor, type InvoiceIM } from './invoicesIM.js';

// ═══════════════════════════════════════════════════════════════════════════
// Cartera de cuenta corriente: "cuánto hay en la calle", a una FECHA y por vendedor.
//
// Pedido de Mati (31/08/2026): "un filtro de fecha para poder sacar el saldo de cuenta
// corriente en determinada fecha y filtrado por vendedor, y un total de las cuentas
// corrientes para saber cuánto hay en calle".
//
// 🔑 InfoManager NO puede contestar esto. Su único reporte de cta cte
// (/reportes/comprob_pendientes_clientes) es una FOTO DE HOY y no acepta fecha: un corte al
// 31/07 pedido en agosto sale mal, porque los pagos posteriores ya bajaron esos saldos.
// La fecha pasada sale de `conciliacion_snapshot` (migración 013), la foto diaria que ya
// guarda el cron de las 23:50 — o sea CERO llamadas nuevas a IM.
//
// Y si de esa fecha no hay foto, no se muestra ningún número: "cero" y "no sé" no son lo
// mismo, y un total de cartera equivocado es peor que no tenerlo.
// ═══════════════════════════════════════════════════════════════════════════

/** Quién puede ver la cartera. Mati, 31/08: admin, gerente y socio. */
const ROLES_CARTERA = new Set(['admin', 'gerente', 'socio']);

/**
 * De qué unidad puede ver la cartera este usuario.
 *
 * 🔴 31/08/2026: el rol `socio` junta dos cosas distintas. Mati lo aclaró textual —
 * **elvio y andrea son dueños de TODA la empresa; enzo y daniel sólo de sus sucursales**
 * (Jujuy y San Juan). Mientras el código los trató a los cuatro igual, `/api/cartera` le
 * servía la cartera ENTERA de Casa Central a los cuatro, porque tomaba la empresa del query
 * con default 1. Es la misma forma del bug de Objetivos de esa misma mañana (`d799d0a`).
 *
 * 🪤 La distinción NO se puede deducir de `cod_empresa`: ese campo es la unidad desde la que
 * el usuario EMITE (depósito y punto de venta de IM), no lo que puede mirar — elvio tiene
 * cod_empresa=2 (BRS) y ve todo. Va por el flag explícito `ve_toda_la_empresa` (migración
 * 030), mismo criterio que `ve_todos_los_clientes` (028).
 *
 * admin y gerente miran cualquier unidad: son los que hacen el consolidado.
 */
export function empresaPermitida(
  rol: string,
  empresaDelUsuario: number | null,
  empresaPedida: number,
  veTodaLaEmpresa = false,
): number {
  if (rol === 'admin' || rol === 'gerente' || veTodaLaEmpresa) return empresaPedida;
  // Sin unidad cargada cae en Casa Central, que es el default documentado de toda la app
  // (ver sucursalDe en sucursales.ts).
  return empresaDelUsuario ?? 1;
}

const ES_FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;

export type Fuente =
  /** Hoy: sale del reporte vivo de IM (con su cache de 10 min). */
  | { tipo: 'vivo' }
  /** Fecha pasada: sale de la foto guardada. */
  | { tipo: 'foto'; fecha: string }
  | { tipo: 'invalida'; motivo: string };

/**
 * Qué fuente corresponde para la fecha pedida.
 *
 * 🪤 Las fechas ISO se comparan como texto a propósito: `'2026-07-31' < '2026-08-01'` es
 * cierto carácter por carácter, y así no hay que construir Date (que interpreta la zona
 * horaria y ya rompió los pedidos una vez — ver fechaArgentina).
 */
export function resolverFuente(fechaPedida: string | undefined | null, hoy: string): Fuente {
  const f = String(fechaPedida ?? '').trim();
  if (!f) return { tipo: 'vivo' };
  if (!ES_FECHA_ISO.test(f)) return { tipo: 'invalida', motivo: 'La fecha tiene que venir como AAAA-MM-DD.' };
  // Descarta 2026-13-45: el regex sola no alcanza.
  const d = new Date(`${f}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== f) {
    return { tipo: 'invalida', motivo: 'Esa fecha no existe.' };
  }
  if (f > hoy) return { tipo: 'invalida', motivo: 'Todavía no se puede saber el saldo de un día que no llegó.' };
  if (f === hoy) return { tipo: 'vivo' };
  return { tipo: 'foto', fecha: f };
}

/**
 * El maestro cliente→vendedor congelado dentro de la foto, con la forma que espera
 * `agruparConciliacion`.
 *
 * 🔑 Se usa el maestro DE LA FOTO y no el de hoy: si un cliente cambió de vendedor entre el
 * corte y hoy, con el maestro vivo su deuda de julio aparecería en la cartera del vendedor
 * nuevo. Devuelve null cuando la foto es vieja y no lo trae (el campo se agregó después):
 * ahí hay que caer al maestro vivo y AVISARLO.
 */
export function maestroFotoAClientes(m: MaestroSnapshot | null | undefined): ClienteMaestro[] | null {
  if (!m || typeof m !== 'object') return null;
  const out: ClienteMaestro[] = [];
  for (const [cod, v] of Object.entries(m)) {
    const n = Number(cod);
    if (!Number.isFinite(n)) continue;
    out.push({ cod_cliente: n, razon_social: v?.nombre ?? '', cod_vendedor: v?.cod_vendedor ?? null });
  }
  return out;
}

/**
 * Los recibos que al CORTE todavía no habían llegado a InfoManager.
 *
 * 🪤 No sirve la lista de tránsito de hoy: un recibo que el vendedor cargó el 28/07 y la
 * oficina imputó el 02/08 hoy figura 'imputado', pero al 31/07 la plata estaba cobrada y IM
 * todavía la mostraba como deuda. Restarle a julio el tránsito de HOY da cualquier cosa.
 *
 * La regla es la misma que ya usa el Cruce carpeta (cruceCarpeta.ts, `transitoAlCorte`),
 * validada contra el cierre real de junio:
 *   · no terminales de hoy, con fecha ≤ corte → seguían sin imputar
 *   · imputados DESPUÉS del corte, con fecha ≤ corte → al corte estaban en tránsito
 *
 * Los imputados que califican salen con status 'pendiente_revision' para que
 * `clasificarRecibos` los cuente como tránsito; los anticipos y los caducados los sigue
 * separando ella, que es la que sabe (no restan).
 */
export function recibosAlCorte(recs: ReciboTransito[], corte: string): ReciboTransito[] {
  const out: ReciboTransito[] = [];
  for (const rec of recs) {
    const fecha = rec.fecha_comprobante
      ? String(rec.fecha_comprobante).slice(0, 10)
      : (rec.created_at ? String(rec.created_at).slice(0, 10) : null);
    if (fecha == null || fecha > corte) continue;
    if (rec.status === 'imputado') {
      if (!rec.imputado_at) continue;
      // Imputado ANTES o EL DÍA del corte: al corte IM ya lo tenía, no era tránsito.
      if (fechaArgentina(String(rec.imputado_at)) <= corte) continue;
      out.push({ ...rec, status: 'pendiente_revision' });
    } else {
      out.push(rec);
    }
  }
  return out;
}

export interface TotalCartera {
  saldo_im: number;
  en_transito: number;
  ajustado: number;
  n_clientes: number;
}
export interface CarteraVendedor extends TotalCartera {
  cod_vendedor: number;
  nombre: string;
}
export interface TotalesCartera {
  total: TotalCartera;
  por_vendedor: CarteraVendedor[];
  /** Suma de los vendedores elegidos. null = sin filtro. */
  filtrado: (TotalCartera & { cods: number[] }) | null;
  /** Casa Central, San Martín, Santo Cristo y la 861: NO es plata de clientes. */
  internas: { saldo_im: number; n_cuentas: number };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Los totales de la cartera a partir de la conciliación ya agrupada.
 *
 * 🔑 `total` es SIEMPRE la cartera completa, se haya filtrado o no: el filtro por vendedor
 * cambia el desglose, no cuánta plata hay en la calle. Si el total se moviera con el filtro,
 * dos personas mirando la misma pantalla con distinta selección verían "cuánto hay en calle"
 * distinto y ninguno de los dos sabría cuál es el número de la empresa.
 */
export function totalesCartera(r: ResultadoConciliacion, cods: number[] | null): TotalesCartera {
  const por_vendedor: CarteraVendedor[] = r.vendedores.map(v => ({
    cod_vendedor: v.cod_vendedor,
    nombre: v.nombre,
    saldo_im: v.total_saldo_im,
    en_transito: v.total_en_transito,
    ajustado: v.total_ajustado,
    n_clientes: v.clientes.length,
  }));

  const total: TotalCartera = {
    saldo_im: r.totales.saldo_im,
    en_transito: r.totales.en_transito,
    ajustado: r.totales.ajustado,
    n_clientes: r.vendedores.reduce((a, v) => a + v.clientes.length, 0),
  };

  let filtrado: TotalesCartera['filtrado'] = null;
  if (cods && cods.length) {
    const elegidos = por_vendedor.filter(v => cods.includes(v.cod_vendedor));
    filtrado = {
      cods,
      saldo_im: r2(elegidos.reduce((a, v) => a + v.saldo_im, 0)),
      en_transito: r2(elegidos.reduce((a, v) => a + v.en_transito, 0)),
      ajustado: r2(elegidos.reduce((a, v) => a + v.ajustado, 0)),
      n_clientes: elegidos.reduce((a, v) => a + v.n_clientes, 0),
    };
  }

  return {
    total,
    por_vendedor,
    filtrado,
    internas: {
      saldo_im: r2(r.internas.reduce((a, i) => a + i.saldo_im, 0)),
      n_cuentas: r.internas.length,
    },
  };
}

/** Los códigos de vendedor del query `?cods=2,3,12`. null = sin filtro. */
export function parsearCods(q: unknown): number[] | null {
  if (q == null || q === '') return null;
  const cods = String(q).split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n >= 0);
  return cods.length ? cods : null;
}

/** Las fechas que SÍ tienen foto, de la más nueva a la más vieja. */
async function fechasConFoto(codEmpresa: number, limite = 120): Promise<string[]> {
  const { data, error } = await sb().from('conciliacion_snapshot')
    .select('fecha')
    .eq('tenant_id', TENANT_ID)
    .eq('cod_empresa', codEmpresa)
    .order('fecha', { ascending: false })
    .limit(limite);
  if (error) throw new Error(`conciliacion_snapshot fechas: ${error.message}`);
  return (data ?? []).map((r: any) => String(r.fecha));
}

/** Los recibos de la empresa, incluyendo los imputados después del corte. */
async function fetchRecibosParaCorte(codEmpresa: number, corte: string): Promise<ReciboTransito[]> {
  let q = sb().from('comprobantes_pago')
    .select('id, cod_cliente, monto, fecha_comprobante, created_at, status, cod_empresa, error_msg, imputado_at')
    .eq('tenant_id', TENANT_ID)
    .or(`status.in.(${ESTADOS_NO_TERMINALES.join(',')}),and(status.eq.imputado,imputado_at.gte.${corte})`)
    .order('created_at', { ascending: false })
    .limit(4000);
  if (codEmpresa === 1) q = q.or('cod_empresa.eq.1,cod_empresa.is.null');
  else q = q.eq('cod_empresa', codEmpresa);
  const { data, error } = await q;
  if (error) throw new Error(`comprobantes_pago (cartera): ${error.message}`);
  const rows = (data ?? []) as ReciboTransito[];
  if (rows.length === 4000) console.warn('[cartera] comprobantes_pago devolvió 4000 filas (el tope): posible truncación');
  return rows;
}

// ═══════════════════════════════════════════════════════════════════════════
// La LISTA de clientes a una fecha pasada — "el estado de todas las cuentas a esa fecha"
// (Mati, 31/08/2026). Hasta acá la fecha movía sólo el total: la lista de abajo era siempre
// la de hoy, y estaba dicho en pantalla porque no había de dónde sacar la otra.
//
// Sale de la MISMA foto que el total, así que no cuesta una sola llamada a InfoManager.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Los comprobantes de la foto, con el shape que la pantalla ya lee.
 *
 * 🔑 El vendedor sale del maestro CONGELADO en la foto: es el mismo criterio que usa el total
 * que se muestra justo arriba (ver `maestroFotoAClientes`). Si la lista usara el maestro de
 * hoy, un cliente reasignado en agosto movería su deuda de julio al vendedor nuevo y el
 * desglose por vendedor no cerraría contra su propia lista.
 *
 * Sin maestro (fotos viejas) se cae a la heurística de /api/data: heredar el vendedor de otro
 * comprobante del mismo cliente. Es peor, pero es lo que ya hacía la lista de hoy.
 */
export function invoicesDesdeFoto(
  rows: PendienteIM[],
  maestro: MaestroSnapshot | null,
  codEmpresa: number,
  nombreVendedor: (cod: number) => string,
): InvoiceIM[] {
  const invoices = normalizarInvoices(rows, codEmpresa, nombreVendedor);
  if (!maestro) return resolverSinVendedor(invoices);

  for (const inv of invoices) {
    const delMaestro = maestro[inv.COD_CLIENT];
    if (delMaestro?.cod_vendedor == null) continue;
    inv.COD_VENDED = String(delMaestro.cod_vendedor);
    inv.VENDEDORES = delMaestro.cod_vendedor === 0 ? 'SIN VENDEDOR' : nombreVendedor(delMaestro.cod_vendedor);
  }
  // Los que el maestro no conoce siguen pudiendo tener vendedor 0: misma red de siempre.
  return resolverSinVendedor(invoices);
}

/** El mismo filtro por vendedor que aplica /api/data. Sin selección, no filtra. */
export function filtrarPorCods(invoices: InvoiceIM[], cods: number[] | null): InvoiceIM[] {
  if (!cods || !cods.length) return invoices;
  const set = new Set(cods.map(String));
  return invoices.filter(inv => set.has(inv.COD_VENDED));
}

/**
 * GET /api/cartera/clientes?fecha=AAAA-MM-DD&cod_empresa=1&cods=2,3
 *
 * La lista de comprobantes pendientes tal como estaba esa fecha. Sólo fechas PASADAS: la de
 * hoy es /api/data, que es el camino que la app ya usa y tiene su propio cache.
 */
export async function getCarteraClientes(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const user = req.user!;
    // Mismo gate que el total: esta lista ES la cartera, sólo que abierta cliente por cliente.
    if (!ROLES_CARTERA.has(String(user.rol))) {
      res.status(403).json({ error: 'La cartera total la ven administración y los socios.' });
      return;
    }

    const empresaPedida = Number(req.query.cod_empresa) || 1;
    if (![1, 2, 3, 4].includes(empresaPedida)) { res.status(400).json({ error: 'cod_empresa inválida' }); return; }
    const fila = await filaUsuario(user);
    const codEmpresa = empresaPermitida(String(user.rol), fila.cod_empresa, empresaPedida, fila.ve_toda_la_empresa);
    const cods = parsearCods(req.query.cods);
    const hoy = hoyISOArgentina();
    const fuente = resolverFuente(req.query.fecha as string | undefined, hoy);

    if (fuente.tipo === 'invalida') { res.status(400).json({ error: fuente.motivo }); return; }
    if (fuente.tipo === 'vivo') {
      res.status(400).json({ error: 'Para el día de hoy la lista sale de /api/data, que es la que ya usa la app.' });
      return;
    }

    const foto = await getSnapshotConciliacion(codEmpresa, fuente.fecha);
    if (!foto) {
      res.json({
        ok: true, disponible: false, fecha: fuente.fecha, cod_empresa: codEmpresa,
        fechas_disponibles: await fechasConFoto(codEmpresa),
      });
      return;
    }

    const vendedores = await fetchVendedores();
    const porCod = new Map(vendedores.map(v => [v.cod_vendedor, v.nombre]));
    const nombreVendedor = (cod: number) => porCod.get(cod) ?? `VENDEDOR ${cod}`;

    const invoices = filtrarPorCods(
      invoicesDesdeFoto(foto.rows, foto.maestro, codEmpresa, nombreVendedor),
      cods,
    );

    res.json({
      ok: true, disponible: true, fecha: fuente.fecha, cod_empresa: codEmpresa,
      generado_at: foto.created_at,
      maestro_congelado: foto.maestro != null,
      invoices,
    });
  } catch (err: any) {
    console.error('getCarteraClientes error:', err);
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/**
 * GET /api/cartera?fecha=AAAA-MM-DD&cod_empresa=1&cods=2,3
 *
 * Sin `fecha` (o con la de hoy) devuelve la cartera viva; con una fecha pasada, la de la foto
 * de ese día. Si no hay foto devuelve `disponible: false` y las fechas que sí tienen — nunca
 * un número inventado.
 */
export async function getCartera(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const user = req.user!;
    // 🔑 El gate va ACÁ y no solo en el middleware: las rutas llevan `requireJwt`, que un
    // vendedor con sesión válida pasa sin problema. Mismo criterio que getConciliacion.
    if (!ROLES_CARTERA.has(String(user.rol))) {
      res.status(403).json({ error: 'La cartera total la ven administración y los socios.' });
      return;
    }

    const empresaPedida = Number(req.query.cod_empresa) || 1;
    if (![1, 2, 3, 4].includes(empresaPedida)) { res.status(400).json({ error: 'cod_empresa inválida' }); return; }
    // La unidad sale de QUIÉN pregunta, no sólo del query: ver empresaPermitida.
    const fila = await filaUsuario(user);
    const codEmpresa = empresaPermitida(String(user.rol), fila.cod_empresa, empresaPedida, fila.ve_toda_la_empresa);
    const cods = parsearCods(req.query.cods);
    const hoy = hoyISOArgentina();
    const fuente = resolverFuente(req.query.fecha as string | undefined, hoy);

    if (fuente.tipo === 'invalida') { res.status(400).json({ error: fuente.motivo }); return; }

    if (fuente.tipo === 'vivo') {
      const { resultado, fetchedAt } = await armarConciliacion(codEmpresa, false);
      res.json({
        ok: true, disponible: true, modo: 'vivo', fecha: hoy, cod_empresa: codEmpresa,
        // La foto de hoy se mueve durante el día: nunca se vende como corte exacto.
        exacto: false,
        generado_at: new Date(fetchedAt).toISOString(),
        ...totalesCartera(resultado, cods),
      });
      return;
    }

    const foto = await getSnapshotConciliacion(codEmpresa, fuente.fecha);
    if (!foto) {
      res.json({
        ok: true, disponible: false, modo: 'sin_foto', fecha: fuente.fecha, cod_empresa: codEmpresa,
        fechas_disponibles: await fechasConFoto(codEmpresa),
      });
      return;
    }

    const maestroFoto = maestroFotoAClientes(foto.maestro);
    const [maestroVivo, vendedores, recibos] = await Promise.all([
      maestroFoto ? Promise.resolve(null) : fetchClientesIMCached(),
      fetchVendedores(),
      fetchRecibosParaCorte(codEmpresa, fuente.fecha),
    ]);
    const resultado = agruparConciliacion(
      foto.rows,
      maestroFoto ?? maestroVivo ?? [],
      recibosAlCorte(recibos, fuente.fecha),
      vendedores,
    );

    res.json({
      ok: true, disponible: true, modo: 'foto', fecha: fuente.fecha, cod_empresa: codEmpresa,
      exacto: true,
      generado_at: foto.created_at,
      // Sin maestro congelado el reparto por vendedor usa el de hoy: el total sigue siendo
      // exacto, pero un cliente reasignado desde entonces cae en el vendedor equivocado.
      maestro_congelado: maestroFoto != null,
      ...totalesCartera(resultado, cods),
    });
  } catch (err: any) {
    console.error('getCartera error:', err);
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}
