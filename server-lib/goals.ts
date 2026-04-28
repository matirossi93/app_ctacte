import type { Request, Response } from 'express';
import { sb, TENANT_ID, hasSupabase } from './supabase.js';
import { fetchVendedores, fetchVentas } from './infomanager.js';
import type { JwtPayload } from './auth.js';
import { computeVentaNeta, monthKey } from '../src/utils/ventas.js';
import { getMonthlyVentasRaw } from './snapshotCache.js';

function normLoc(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quita tildes
    .trim().toUpperCase()
    .replace(/\s+/g, ' ');
}
function prettyLoc(s: string): string {
  // Title case preservando el normalizado (resultado típico: "Alberdi")
  return s.toLowerCase().replace(/(^|\s|-)(\w)/g, (_, pre, ch) => pre + ch.toUpperCase());
}

function today(): { year: number; month: number; day: number } {
  const d = new Date();
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * Días hábiles del mes: excluye domingos + feriados pasados como array de días (1..31).
 * Sábado cuenta (Semillero opera sábados).
 */
function businessDaysInMonth(year: number, month: number, holidays: number[] = []): number {
  const days = new Date(year, month, 0).getDate();
  const h = new Set(holidays);
  let bd = 0;
  for (let d = 1; d <= days; d++) {
    const wd = new Date(year, month - 1, d).getDay();
    if (wd !== 0 && !h.has(d)) bd++;
  }
  return bd;
}

/**
 * Días hábiles transcurridos hasta (incluido) `day`, excluyendo domingos + feriados.
 */
function businessDaysElapsed(year: number, month: number, day: number, holidays: number[] = []): number {
  const h = new Set(holidays);
  let bd = 0;
  for (let d = 1; d <= day; d++) {
    const wd = new Date(year, month - 1, d).getDay();
    if (wd !== 0 && !h.has(d)) bd++;
  }
  return bd;
}

export interface GoalItem {
  cod_vendedor: number;
  nombre: string;
  vendedor_key: string | null;
  email: string | null;
  activo: boolean;
  year: number;
  month: number;
  target_neto: number | null;
  avance: number;
  num_comprobantes: number;
  pct_cumplimiento: number | null;
  proyeccion: number;
  necesario_por_dia: number | null;
  dias_habiles_total: number;
  dias_habiles_transcurridos: number;
  dias_restantes: number;
  goal_set_by_email: string | null;
  goal_updated_at: string | null;
}

/**
 * GET /api/goals?year=&month=
 * Admin/gerente: TODOS los vendedores con goals + avance.
 * Vendedor: solo el suyo.
 * Si year/month no se pasan, usa mes actual.
 */
export async function listGoals(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    if (!hasSupabase()) { res.status(500).json({ error: 'Supabase no configurado' }); return; }
    const user = req.user!;
    const t = today();
    const year = Number(req.query.year) || t.year;
    const month = Number(req.query.month) || t.month;

    // Fetch goals + ventas caches + vendedores IM + month_config en paralelo
    const [goalsRes, salesRes, vendedoresIM, monthCfgRes] = await Promise.all([
      sb().from('vendor_goals').select('cod_vendedor, target_neto, dias_habiles, set_by, updated_at').eq('tenant_id', TENANT_ID).eq('year', year).eq('month', month),
      sb().from('vendor_sales_monthly').select('cod_vendedor, neto, num_comprobantes').eq('tenant_id', TENANT_ID).eq('year', year).eq('month', month),
      fetchVendedores().catch(() => []),
      sb().from('month_config').select('dias_habiles, holidays').eq('tenant_id', TENANT_ID).eq('year', year).eq('month', month).maybeSingle()
    ]);

    if (goalsRes.error) { res.status(500).json({ error: `goals: ${goalsRes.error.message}` }); return; }
    if (salesRes.error) { res.status(500).json({ error: `sales: ${salesRes.error.message}` }); return; }

    // Traer usuarios con cod_vendedor + email para tags visuales + flag activo.
    const { data: usuariosRows } = await sb().from('usuarios')
      .select('id, email, cod_vendedor, vendedor_key, nombre, activo')
      .eq('tenant_id', TENANT_ID)
      .not('cod_vendedor', 'is', null);
    const usuariosById = new Map<string, any>();
    const usuariosByCod = new Map<number, any>();
    (usuariosRows ?? []).forEach((u: any) => {
      usuariosById.set(u.id, u);
      if (u.cod_vendedor != null) usuariosByCod.set(u.cod_vendedor, u);
    });

    const goalsByCod = new Map<number, any>();
    (goalsRes.data ?? []).forEach((g: any) => goalsByCod.set(g.cod_vendedor, g));
    const salesByCod = new Map<number, { neto: number; num: number }>();
    (salesRes.data ?? []).forEach((s: any) => salesByCod.set(s.cod_vendedor, { neto: Number(s.neto) || 0, num: s.num_comprobantes || 0 }));

    const cfg = monthCfgRes.data as any;
    const holidaysRaw = Array.isArray(cfg?.holidays) ? cfg.holidays : [];
    const holidays: number[] = holidaysRaw
      .map((d: any) => Number(d))
      .filter((d: number) => Number.isInteger(d) && d >= 1 && d <= 31);
    const diasAuto = businessDaysInMonth(year, month); // sin feriados — para referencia
    const diasConFeriados = businessDaysInMonth(year, month, holidays);
    // Prioridad: dias_habiles manual > auto con feriados
    const diasTotal = cfg?.dias_habiles ?? diasConFeriados;
    const isCurrentMonth = year === t.year && month === t.month;
    const diasTrans = isCurrentMonth ? businessDaysElapsed(year, month, t.day, holidays) : diasTotal;
    const diasRestantes = Math.max(0, diasTotal - diasTrans);

    // Whitelist de cod_vendedor que nos interesa mostrar. InfoManager trae históricos
    // (Federico=1, Adolfo=5, Robledo=8, Dario=9, Niño=10) que no operan más — no los queremos.
    // Si se incorpora alguien nuevo, agregar su cod_vendedor acá.
    // 2=Sebastián, 3=Marcelo, 4=Julio, 6=Andrea (backoffice), 12=Brian.
    const COD_VENDEDORES_VISIBLES = new Set([2, 3, 4, 6, 12]);

    const incluirInactivos = String(req.query.incluir_inactivos ?? '') === 'true';
    const vendedoresValidos = (vendedoresIM ?? []).filter((v: any) => {
      const n = String(v?.nombre ?? '').toUpperCase();
      if (n.includes('SUCURSAL') || n.includes('CONSUMO')) return false;
      if (!COD_VENDEDORES_VISIBLES.has(Number(v.cod_vendedor))) return false;
      if (incluirInactivos) return true;
      const u = usuariosByCod.get(v.cod_vendedor);
      // Sin usuario (Andrea) → incluir. Con usuario → solo si activo !== false.
      return !u || u.activo !== false;
    });

    const items: GoalItem[] = vendedoresValidos.map((v: any) => {
      const cod = v.cod_vendedor;
      const goal = goalsByCod.get(cod);
      const sale = salesByCod.get(cod);
      const u = usuariosByCod.get(cod);
      const target = goal?.target_neto != null ? Number(goal.target_neto) : null;
      const avance = sale?.neto ?? 0;
      const pct = target && target > 0 ? avance / target : null;
      const proyeccion = diasTrans > 0 ? avance * (diasTotal / diasTrans) : avance;
      const necesarioDia = target && diasRestantes > 0 ? Math.max(0, (target - avance) / diasRestantes) : null;
      return {
        cod_vendedor: cod,
        nombre: u?.nombre ?? v.nombre,
        vendedor_key: u?.vendedor_key ?? null,
        email: u?.email ?? null,
        // activo=true solo si hay usuario explícito y activo. Sin usuario (Andrea, Dario,
        // Federico, etc.) → activo=false, aparece destildado por default en el popover.
        activo: !!(u && u.activo !== false),
        year, month,
        target_neto: target,
        avance,
        num_comprobantes: sale?.num ?? 0,
        pct_cumplimiento: pct,
        proyeccion,
        necesario_por_dia: necesarioDia,
        dias_habiles_total: diasTotal,
        dias_habiles_transcurridos: diasTrans,
        dias_restantes: diasRestantes,
        goal_set_by_email: goal?.set_by ? (usuariosById.get(goal.set_by)?.email ?? null) : null,
        goal_updated_at: goal?.updated_at ?? null,
      };
    });

    // Filtrar por rol
    const visible = user.rol === 'vendedor'
      ? items.filter(it => it.cod_vendedor === user.cod_vendedor)
      : items;

    // Totales equipo (solo para admin/gerente) — solo vendedores activos (con usuario).
    // Andrea/Dario/Federico/etc. aparecen en la lista para el popover de filtro pero
    // NO deben sumar al avance/target del equipo.
    let totales: any = null;
    if (user.rol !== 'vendedor') {
      const equipo = visible.filter(i => i.activo);
      const tgt = equipo.reduce((a, i) => a + (i.target_neto ?? 0), 0);
      const av = equipo.reduce((a, i) => a + i.avance, 0);
      totales = {
        target: tgt,
        avance: av,
        pct: tgt > 0 ? av / tgt : null,
        proyeccion: equipo.reduce((a, i) => a + i.proyeccion, 0),
        vendedores_con_target: equipo.filter(i => i.target_neto != null).length,
        vendedores_total: equipo.length,
      };
    }

    res.json({
      ok: true,
      year, month,
      is_historic: !isCurrentMonth,
      dias_habiles_total: diasTotal,
      dias_habiles_auto: diasAuto,
      dias_habiles_con_feriados: diasConFeriados,
      dias_habiles_source: cfg?.dias_habiles ? 'manual' : (holidays.length > 0 ? 'con_feriados' : 'auto'),
      dias_habiles_transcurridos: diasTrans,
      dias_restantes: diasRestantes,
      holidays,
      items: visible,
      totales,
    });
  } catch (err: any) {
    console.error('listGoals error:', err);
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/**
 * POST /api/goals
 * Body: { cod_vendedor, year, month, target_neto }
 * Solo admin/gerente.
 */
export async function setGoal(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const user = req.user!;
    if (user.rol !== 'admin' && user.rol !== 'gerente') { res.status(403).json({ error: 'Requiere admin/gerente' }); return; }
    const body = req.body ?? {};
    const cod_vendedor = Number(body.cod_vendedor);
    const year = Number(body.year);
    const month = Number(body.month);
    const target_neto = Number(body.target_neto);
    if (!cod_vendedor || !year || !month || target_neto < 0 || !isFinite(target_neto)) {
      res.status(400).json({ error: 'payload inválido: { cod_vendedor, year, month, target_neto } obligatorios' });
      return;
    }

    const { data, error } = await sb().from('vendor_goals').upsert({
      tenant_id: TENANT_ID,
      cod_vendedor, year, month,
      target_neto,
      set_by: user.sub,
      updated_at: new Date().toISOString()
    }, { onConflict: 'tenant_id,cod_vendedor,year,month' }).select().single();
    if (error) { res.status(500).json({ error: error.message }); return; }
    res.json({ ok: true, goal: data });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/**
 * GET /api/goals/clientes?year=&month=&cod_vendedor=&filter=
 * Devuelve clientes del vendedor con objetivo mes vs avance real.
 * Vendedor ve solo sus clientes. Admin/gerente puede pasar cod_vendedor o ver todos.
 *
 * Fuente de datos del objetivo:
 *  - Mes en curso → client_operational (single-row por cliente, último import).
 *  - Mes histórico → client_objectives_history (snapshot por (cliente, año, mes)).
 *    Metadata (razón social, localidad, frecuencia, etc.) se merge desde
 *    client_operational en ambos casos. Solo objetivo y vendedor del corte
 *    salen del snapshot histórico cuando aplica.
 */
export async function listClientesObjetivo(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    if (!hasSupabase()) { res.status(500).json({ error: 'Supabase no configurado' }); return; }
    const user = req.user!;
    const t = today();
    const year = Number(req.query.year) || t.year;
    const month = Number(req.query.month) || t.month;
    const isCurrent = year === t.year && month === t.month;

    let codVend: number | null = null;
    let codsList: number[] | null = null;
    if (user.rol === 'vendedor') {
      codVend = user.cod_vendedor ?? -1;
    } else if (req.query.cod_vendedor) {
      codVend = Number(req.query.cod_vendedor);
    } else if (req.query.cods) {
      const parsed = String(req.query.cods)
        .split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0);
      if (parsed.length) codsList = parsed;
    }

    // ─── Snapshot histórico de objetivos cuando year/month != actual ──────────
    // Mantiene un map cod_cliente → { objetivo_mes, cod_vendedor, fact_*, tipo_abc }
    // para hidratar luego sobre la metadata operacional.
    type HistRow = { cod_cliente: number; cod_vendedor: number | null; objetivo_mes: number | null; fact_mes_pasado: number | null; fact_prom_3m: number | null; tipo_abc: string | null };
    const histByCliente = new Map<number, HistRow>();
    if (!isCurrent) {
      let qH = sb().from('client_objectives_history')
        .select('cod_cliente, cod_vendedor, objetivo_mes, fact_mes_pasado, fact_prom_3m, tipo_abc')
        .eq('tenant_id', TENANT_ID)
        .eq('year', year).eq('month', month);
      if (codVend != null) qH = qH.eq('cod_vendedor', codVend);
      else if (codsList) qH = qH.in('cod_vendedor', codsList);
      qH = qH.limit(5000);
      const { data: histRows, error: errH } = await qH;
      if (errH) { res.status(500).json({ error: `history: ${errH.message}` }); return; }
      (histRows ?? []).forEach((h: any) => histByCliente.set(h.cod_cliente, h));
    }

    // ─── Metadata operacional ────────────────────────────────────────────────
    // En histórico filtramos por los cod_cliente que aparecen en el snapshot.
    // En mes actual filtramos por cod_vendedor como antes.
    let q = sb().from('client_operational').select('cod_cliente, cod_vendedor, razon_social, localidad, frecuencia, dia_visita, tipo_abc, direccion, repartidor, hoja_ruta, dia_entrega, cond_pago, notas, objetivo_mes, objetivo_year, objetivo_month, fact_mes_pasado, fact_prom_3m, saldo_cta_cte').eq('tenant_id', TENANT_ID);
    if (isCurrent) {
      if (codVend != null) q = q.eq('cod_vendedor', codVend);
      else if (codsList) q = q.in('cod_vendedor', codsList);
    } else {
      const codClientes = Array.from(histByCliente.keys());
      if (codClientes.length === 0) {
        // No hay snapshot para este mes (no se importó Maestro o pre-migración).
        // Devolvemos lista vacía con stats en 0 — el frontend mostrará el banner
        // "sin datos históricos para este mes".
        res.json({
          ok: true, year, month, items: [], seleccion: { localidad: null, total_clientes: 0, con_objetivo: 0, total_objetivo: 0, total_avance: 0, num_comprobantes: 0, pct: null },
          stats: { total_clientes: 0, con_objetivo: 0, completados: 0, parciales: 0, sin_compras: 0, sin_objetivo: 0, total_objetivo: 0, total_avance: 0, pct_equipo: null, localidades: [] },
          historic_empty: true,
        });
        return;
      }
      // Postgres `in` con muchos valores: en lotes de 1000 para evitar URL gigante.
      // En la práctica nunca pasamos de ~1000 clientes así que un solo .in() basta.
      q = q.in('cod_cliente', codClientes);
    }
    q = q.order('objetivo_mes', { ascending: false, nullsFirst: false }).limit(5000);
    const { data: clientes, error: errC } = await q;
    if (errC) { res.status(500).json({ error: errC.message }); return; }

    // Avance por cliente del mes consultado
    const { data: salesMes, error: errS } = await sb().from('client_sales_monthly')
      .select('cod_cliente, neto, num_comprobantes')
      .eq('tenant_id', TENANT_ID)
      .eq('year', year)
      .eq('month', month);
    if (errS) { res.status(500).json({ error: errS.message }); return; }
    const salesByCliente = new Map<number, { neto: number; num: number }>();
    (salesMes ?? []).forEach((s: any) => salesByCliente.set(s.cod_cliente, { neto: Number(s.neto) || 0, num: s.num_comprobantes || 0 }));

    const items = (clientes ?? []).map((c: any) => {
      const sale = salesByCliente.get(c.cod_cliente);
      const avance = sale?.neto ?? 0;
      // Objetivo: para mes actual viene de client_operational (con rollover guard).
      // Para mes histórico viene del snapshot client_objectives_history.
      let objetivo: number | null;
      let codVendedorEfectivo: number | null;
      let factMesPasado: number | null;
      let factProm3m: number | null;
      let tipoAbc: string | null;
      if (isCurrent) {
        const objetivoMatches = c.objetivo_year === year && c.objetivo_month === month;
        objetivo = (objetivoMatches && c.objetivo_mes != null) ? Number(c.objetivo_mes) : null;
        codVendedorEfectivo = c.cod_vendedor ?? null;
        factMesPasado = c.fact_mes_pasado != null ? Number(c.fact_mes_pasado) : null;
        factProm3m = c.fact_prom_3m != null ? Number(c.fact_prom_3m) : null;
        tipoAbc = c.tipo_abc ?? null;
      } else {
        const h = histByCliente.get(c.cod_cliente);
        objetivo = h?.objetivo_mes != null ? Number(h.objetivo_mes) : null;
        codVendedorEfectivo = h?.cod_vendedor ?? c.cod_vendedor ?? null;
        factMesPasado = h?.fact_mes_pasado != null ? Number(h.fact_mes_pasado) : null;
        factProm3m = h?.fact_prom_3m != null ? Number(h.fact_prom_3m) : null;
        tipoAbc = h?.tipo_abc ?? c.tipo_abc ?? null;
      }
      const pct = objetivo && objetivo > 0 ? avance / objetivo : null;
      const falta = objetivo != null ? Math.max(0, objetivo - avance) : null;
      const sobrante = objetivo != null && avance > objetivo ? avance - objetivo : 0;
      const status = objetivo == null
        ? 'sin_objetivo'
        : avance >= objetivo ? 'completado'
        : avance > 0 ? 'parcial'
        : 'sin_compras';
      const locNorm = normLoc(c.localidad);
      return {
        cod_cliente: c.cod_cliente,
        cod_vendedor: codVendedorEfectivo,
        razon_social: c.razon_social,
        localidad: locNorm ? prettyLoc(locNorm) : c.localidad,
        localidad_norm: locNorm,
        frecuencia: c.frecuencia,
        dia_visita: c.dia_visita,
        tipo_abc: tipoAbc,
        direccion: c.direccion ?? null,
        repartidor: c.repartidor ?? null,
        hoja_ruta: c.hoja_ruta ?? null,
        dia_entrega: c.dia_entrega ?? null,
        cond_pago: c.cond_pago ?? null,
        notas: c.notas ?? null,
        objetivo_mes: objetivo,
        fact_mes_pasado: factMesPasado,
        fact_prom_3m: factProm3m,
        // saldo_cta_cte vive en el presente; en histórico no aplica al corte.
        saldo_cta_cte: isCurrent && c.saldo_cta_cte != null ? Number(c.saldo_cta_cte) : null,
        avance,
        num_comprobantes: sale?.num ?? 0,
        pct_cumplimiento: pct,
        falta,
        sobrante,
        status,
      };
    });

    // Filtros (status + localidad) — localidad se compara normalizada
    const filter = String(req.query.filter ?? 'todos');
    const localidadFilter = normLoc(String(req.query.localidad ?? ''));
    const filtered = items.filter(it => {
      if (localidadFilter && it.localidad_norm !== localidadFilter) return false;
      if (filter === 'completado') return it.status === 'completado';
      if (filter === 'parcial') return it.status === 'parcial';
      if (filter === 'bajo_objetivo') return it.status === 'sin_compras' || it.status === 'parcial';
      if (filter === 'sin_compras') return it.status === 'sin_compras';
      if (filter === 'sin_objetivo') return it.status === 'sin_objetivo';
      return true;
    });

    // Localidades agregadas (basado en TODOS los clientes, no filtrados).
    // Key por forma normalizada → display con título.
    const locMap = new Map<string, { localidad: string; count: number; total_objetivo: number; total_avance: number; completados: number }>();
    items.forEach(it => {
      const key = it.localidad_norm || '__sin_localidad__';
      const display = it.localidad_norm ? prettyLoc(it.localidad_norm) : 'Sin localidad';
      if (!locMap.has(key)) locMap.set(key, { localidad: display, count: 0, total_objetivo: 0, total_avance: 0, completados: 0 });
      const l = locMap.get(key)!;
      l.count++;
      l.total_objetivo += it.objetivo_mes ?? 0;
      l.total_avance += it.avance;
      if (it.status === 'completado') l.completados++;
    });
    const localidades = Array.from(locMap.values())
      .sort((a, b) => b.total_objetivo - a.total_objetivo);

    // Stats (globales sobre items — antes de filtros)
    const withObjetivo = items.filter(i => i.objetivo_mes != null);
    const totalObjetivo = withObjetivo.reduce((a, i) => a + (i.objetivo_mes ?? 0), 0);
    const totalAvance = items.reduce((a, i) => a + i.avance, 0);
    const stats = {
      total_clientes: items.length,
      con_objetivo: withObjetivo.length,
      completados: items.filter(i => i.status === 'completado').length,
      parciales: items.filter(i => i.status === 'parcial').length,
      sin_compras: items.filter(i => i.status === 'sin_compras').length,
      sin_objetivo: items.filter(i => i.status === 'sin_objetivo').length,
      total_objetivo: totalObjetivo,
      total_avance: totalAvance,
      pct_equipo: totalObjetivo > 0 ? totalAvance / totalObjetivo : null,
      localidades,
    };

    // Resumen de la selección (respeta localidad filter, ignora status filter para el hero)
    const inSel = items.filter(it => !localidadFilter || it.localidad_norm === localidadFilter);
    const selObjetivo = inSel.reduce((a, i) => a + (i.objetivo_mes ?? 0), 0);
    const selAvance = inSel.reduce((a, i) => a + i.avance, 0);
    const selNumComp = inSel.reduce((a, i) => a + i.num_comprobantes, 0);
    const selConObjetivo = inSel.filter(i => i.objetivo_mes != null).length;
    const seleccion = {
      localidad: localidadFilter ? prettyLoc(localidadFilter) : null,
      total_clientes: inSel.length,
      con_objetivo: selConObjetivo,
      total_objetivo: selObjetivo,
      total_avance: selAvance,
      num_comprobantes: selNumComp,
      pct: selObjetivo > 0 ? selAvance / selObjetivo : null,
    };

    res.json({ ok: true, year, month, is_historic: !isCurrent, items: filtered, stats, seleccion });
  } catch (err: any) {
    console.error('listClientesObjetivo error:', err);
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/**
 * POST /api/month-config
 * Body: { year, month, dias_habiles, notas? }
 * Solo admin/gerente. Override de días hábiles del mes (feriados, etc).
 */
export async function setMonthConfig(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const user = req.user!;
    if (user.rol !== 'admin' && user.rol !== 'gerente') { res.status(403).json({ error: 'Requiere admin/gerente' }); return; }
    const body = req.body ?? {};
    const year = Number(body.year);
    const month = Number(body.month);
    if (!year || !month) { res.status(400).json({ error: 'year, month obligatorios' }); return; }

    // holidays opcional — array de días (1..31)
    let holidays: number[] | undefined;
    if (Array.isArray(body.holidays)) {
      const cleaned: number[] = body.holidays
        .map((d: any) => Number(d))
        .filter((d: number) => Number.isInteger(d) && d >= 1 && d <= 31);
      holidays = Array.from(new Set<number>(cleaned)).sort((a, b) => a - b);
    }

    // dias_habiles opcional — override manual
    const diasProvided = body.dias_habiles != null;
    const dias_habiles = diasProvided ? Number(body.dias_habiles) : null;
    if (diasProvided && (!dias_habiles || dias_habiles < 1 || dias_habiles > 31)) {
      res.status(400).json({ error: 'dias_habiles debe estar entre 1 y 31' }); return;
    }

    const payload: any = {
      tenant_id: TENANT_ID,
      year, month,
      notas: body.notas ?? null,
      set_by: user.sub,
      updated_at: new Date().toISOString(),
    };
    if (holidays) payload.holidays = holidays;

    // dias_habiles es NOT NULL. En upsert, Postgres evalúa primero el INSERT,
    // así que hay que mandarlo SIEMPRE — sea manual o auto-calculado con feriados.
    if (diasProvided) {
      payload.dias_habiles = dias_habiles;
    } else if (holidays) {
      payload.dias_habiles = businessDaysInMonth(year, month, holidays);
    } else {
      payload.dias_habiles = businessDaysInMonth(year, month);
    }

    const { data, error } = await sb().from('month_config').upsert(payload, { onConflict: 'tenant_id,year,month' }).select().single();
    if (error) { res.status(500).json({ error: error.message }); return; }
    res.json({ ok: true, config: data });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/**
 * POST /api/goals/sync-now — admin forzar cron de ventas (útil después de setear para ver datos frescos)
 */
export async function syncVentasNow(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const user = req.user!;
    if (user.rol !== 'admin' && user.rol !== 'gerente') { res.status(403).json({ error: 'Requiere admin/gerente' }); return; }
    const { syncVentasMesActual } = await import('./syncVentas.js');
    const result = await syncVentasMesActual();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/**
 * GET /api/goals/debug-cliente/:cod?year=&month=
 * Admin only. Consulta /ventas de InfoManager live para ese cliente + mes,
 * devuelve comprobante por comprobante con lo que computeVentaNeta calcula,
 * y compara contra el row de client_sales_monthly cacheado.
 * Uso: verificar discrepancias puntuales. No pisa la cache.
 */
export async function debugClienteAvance(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    const user = req.user!;
    if (user.rol !== 'admin' && user.rol !== 'gerente') { res.status(403).json({ error: 'Requiere admin/gerente' }); return; }
    if (!hasSupabase()) { res.status(500).json({ error: 'Supabase no configurado' }); return; }

    const cod = Number(req.params.cod);
    if (!cod) { res.status(400).json({ error: 'cod_cliente inválido' }); return; }

    const t = today();
    const year = Number(req.query.year) || t.year;
    const month = Number(req.query.month) || t.month;
    const desde = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const isCurrentMonth = year === t.year && month === t.month;
    const hasta = isCurrentMonth
      ? new Date().toISOString().slice(0, 10)
      : `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    // Traer todas las ventas del mes (sin filtrar por cod_cliente — InfoManager
    // no soporta query por cliente en /ventas según Swagger actual).
    const ventasMes = await fetchVentas(desde, hasta);

    // Filtrar client-side.
    const delCliente = ventasMes.filter((v: any) => Number(v.cod_cliente) === cod);

    // Breakdown por tipo para este cliente.
    const tipoBreak = new Map<string, { count: number; sumTotal: number; sumNeto: number }>();
    let sumNeto = 0;
    const comprobantes = delCliente.map((v: any) => {
      const tipo = String(v.tipo ?? v.tipo_comprobante ?? '').toUpperCase();
      const fa_total = Number(v.fa_total ?? v.total ?? 0);
      const neto = computeVentaNeta(v);
      const mk = monthKey(v.fa_fecha ?? v.fecha);
      const inMonth = mk && mk.year === year && mk.month === month;
      sumNeto += neto;
      const b = tipoBreak.get(tipo) ?? { count: 0, sumTotal: 0, sumNeto: 0 };
      b.count++; b.sumTotal += fa_total; b.sumNeto += neto;
      tipoBreak.set(tipo, b);
      return {
        id: v.id ?? null,
        tipo, fecha: v.fa_fecha ?? v.fecha,
        cod_empresa: v.cod_empresa ?? null,
        cod_vendedor: v.cod_vendedor ?? null,
        fa_total, neto_calculado: neto,
        anulada: v.anulada ?? null,
        in_month: inMonth,
      };
    });

    // Cache row.
    const { data: cacheRow } = await sb().from('client_sales_monthly')
      .select('neto, num_comprobantes, updated_at')
      .eq('tenant_id', TENANT_ID).eq('cod_cliente', cod)
      .eq('year', year).eq('month', month)
      .maybeSingle();

    // Operational (razón social).
    const { data: opRow } = await sb().from('client_operational')
      .select('razon_social, localidad, cod_vendedor, objetivo_mes')
      .eq('tenant_id', TENANT_ID).eq('cod_cliente', cod)
      .maybeSingle();

    res.json({
      ok: true,
      cliente: {
        cod_cliente: cod,
        razon_social: opRow?.razon_social ?? null,
        localidad: opRow?.localidad ?? null,
        cod_vendedor: opRow?.cod_vendedor ?? null,
        objetivo_mes: opRow?.objetivo_mes ?? null,
      },
      periodo: { year, month, desde, hasta },
      live: {
        total_ventas_mes_InfoManager: ventasMes.length,
        comprobantes_del_cliente: delCliente.length,
        neto_calculado_live: Number(sumNeto.toFixed(2)),
        breakdown_tipo: Object.fromEntries(
          Array.from(tipoBreak.entries())
            .map(([t, s]) => [t || '(vacío)', { count: s.count, total: Math.round(s.sumTotal), neto: Math.round(s.sumNeto) }])
        ),
        comprobantes,
      },
      cache: cacheRow ? {
        neto: Number(cacheRow.neto) || 0,
        num_comprobantes: cacheRow.num_comprobantes,
        updated_at: cacheRow.updated_at,
      } : null,
      discrepancia: cacheRow ? Number((sumNeto - (Number(cacheRow.neto) || 0)).toFixed(2)) : null,
    });
  } catch (err: any) {
    console.error('debugClienteAvance error:', err);
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}

/**
 * GET /api/goals/snapshot?year=&month=&asOfDate=YYYY-MM-DD&cod_vendedor=&cods=
 *
 * Calcula avance del equipo + clientes con corte arbitrario al asOfDate.
 * Pensado para reuniones donde se quiere ver el avance "al miércoles X".
 *
 * Mecanismo: usa el cache RAM del dataset crudo del mes (TTL 5min). El primer
 * fetch al mes tarda ~3-5s; cambios sucesivos de asOfDate dentro del mismo
 * mes son <100ms (filter en memoria, sin red).
 *
 * Validaciones:
 *  - asOfDate dentro del mes (`YYYY-MM-01` ≤ asOfDate ≤ último día del mes)
 *  - asOfDate futuro: clamp a today() y se devuelve el ajustado
 *  - asOfDate fuera del mes: 400 con mensaje explicando
 *  - Si asOfDate == último día del mes en curso, devuelve los mismos números
 *    que /api/goals (la única diferencia es que no se persiste el agregado).
 */
export async function getGoalsSnapshot(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    if (!hasSupabase()) { res.status(500).json({ error: 'Supabase no configurado' }); return; }
    const user = req.user!;
    const t = today();
    const year = Number(req.query.year);
    const month = Number(req.query.month);
    const asOfDateRaw = String(req.query.asOfDate ?? '').trim();
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      res.status(400).json({ error: 'year/month obligatorios y válidos' }); return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDateRaw)) {
      res.status(400).json({ error: 'asOfDate debe tener formato YYYY-MM-DD' }); return;
    }

    const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    if (asOfDateRaw < monthStart || asOfDateRaw > monthEnd) {
      res.status(400).json({ error: `asOfDate ${asOfDateRaw} fuera del mes ${year}-${String(month).padStart(2, '0')} (rango ${monthStart}..${monthEnd})` });
      return;
    }
    // Clamp a hoy si futuro (mes en curso). En meses pasados, asOfDate ya es válido.
    const todayIso = new Date().toISOString().slice(0, 10);
    const isCurrentMonth = year === t.year && month === t.month;
    let asOfDate = asOfDateRaw;
    let clamped = false;
    if (isCurrentMonth && asOfDateRaw > todayIso) {
      asOfDate = todayIso;
      clamped = true;
    }
    const isHistoric = !isCurrentMonth;
    const asOfDay = parseInt(asOfDate.slice(8, 10), 10);

    const codEmpresa = req.query.codEmpresa ? Number(req.query.codEmpresa) : undefined;

    // ─── Fetch crudo del mes (con cache RAM) ─────────────────────────────────
    const t0 = Date.now();
    const { ventas, cached, cacheAge } = await getMonthlyVentasRaw(year, month, { codEmpresa });
    const fetchMs = Date.now() - t0;

    // ─── Filtrar por asOfDate y agregar ──────────────────────────────────────
    const ventasHasta = ventas.filter(v => {
      const f = String(v.fa_fecha ?? v.fecha ?? '').slice(0, 10);
      return f && f <= asOfDate;
    });

    const byCliente = new Map<number, { neto: number; num: number }>();
    const byVendedor = new Map<number, { neto: number; num: number }>();
    const clientToVendor = new Map<number, number>();
    for (const v of ventasHasta) {
      if (v.cod_cliente != null && v.cod_vendedor != null && v.cod_vendedor !== 0) {
        if (!clientToVendor.has(v.cod_cliente)) clientToVendor.set(v.cod_cliente, v.cod_vendedor);
      }
    }
    for (const v of ventasHasta) {
      const neto = computeVentaNeta(v);
      if (neto === 0) continue;
      const k = monthKey(v.fa_fecha ?? v.fecha);
      if (!k || k.year !== year || k.month !== month) continue;
      if (v.cod_cliente != null) {
        const cur = byCliente.get(v.cod_cliente) ?? { neto: 0, num: 0 };
        cur.neto += neto; cur.num += 1;
        byCliente.set(v.cod_cliente, cur);
      }
      let codVend = v.cod_vendedor != null && v.cod_vendedor !== 0 ? v.cod_vendedor : null;
      if (codVend == null && v.cod_cliente != null) {
        codVend = clientToVendor.get(v.cod_cliente) ?? null;
      }
      if (codVend != null) {
        const cur = byVendedor.get(codVend) ?? { neto: 0, num: 0 };
        cur.neto += neto; cur.num += 1;
        byVendedor.set(codVend, cur);
      }
    }

    // ─── Filtros por rol/vendedor para clientes (replica listClientesObjetivo) ──
    let codVendFilter: number | null = null;
    let codsListFilter: number[] | null = null;
    if (user.rol === 'vendedor') {
      codVendFilter = user.cod_vendedor ?? -1;
    } else if (req.query.cod_vendedor) {
      codVendFilter = Number(req.query.cod_vendedor);
    } else if (req.query.cods) {
      const parsed = String(req.query.cods)
        .split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0);
      if (parsed.length) codsListFilter = parsed;
    }

    // ─── Cargar metadata en paralelo (goals, vendedores, month_config, history) ──
    const [goalsRes, vendedoresIM, monthCfgRes] = await Promise.all([
      sb().from('vendor_goals').select('cod_vendedor, target_neto, dias_habiles, set_by, updated_at').eq('tenant_id', TENANT_ID).eq('year', year).eq('month', month),
      fetchVendedores().catch(() => []),
      sb().from('month_config').select('dias_habiles, holidays').eq('tenant_id', TENANT_ID).eq('year', year).eq('month', month).maybeSingle(),
    ]);
    if (goalsRes.error) { res.status(500).json({ error: `goals: ${goalsRes.error.message}` }); return; }

    const { data: usuariosRows } = await sb().from('usuarios')
      .select('id, email, cod_vendedor, vendedor_key, nombre, activo')
      .eq('tenant_id', TENANT_ID)
      .not('cod_vendedor', 'is', null);
    const usuariosByCod = new Map<number, any>();
    (usuariosRows ?? []).forEach((u: any) => { if (u.cod_vendedor != null) usuariosByCod.set(u.cod_vendedor, u); });

    const goalsByCod = new Map<number, any>();
    (goalsRes.data ?? []).forEach((g: any) => goalsByCod.set(g.cod_vendedor, g));

    const cfg = monthCfgRes.data as any;
    const holidays: number[] = (Array.isArray(cfg?.holidays) ? cfg.holidays : [])
      .map((d: any) => Number(d))
      .filter((d: number) => Number.isInteger(d) && d >= 1 && d <= 31);
    const diasTotal = cfg?.dias_habiles ?? businessDaysInMonth(year, month, holidays);
    const diasTrans = businessDaysElapsed(year, month, asOfDay, holidays);
    const diasRestantes = Math.max(0, diasTotal - diasTrans);

    // ─── Whitelist de vendedores visibles (mismo criterio que listGoals) ──
    const COD_VENDEDORES_VISIBLES = new Set([2, 3, 4, 6, 12]);
    const incluirInactivos = String(req.query.incluir_inactivos ?? '') === 'true';
    const vendedoresValidos = (vendedoresIM ?? []).filter((v: any) => {
      const n = String(v?.nombre ?? '').toUpperCase();
      if (n.includes('SUCURSAL') || n.includes('CONSUMO')) return false;
      if (!COD_VENDEDORES_VISIBLES.has(Number(v.cod_vendedor))) return false;
      if (incluirInactivos) return true;
      const u = usuariosByCod.get(v.cod_vendedor);
      return !u || u.activo !== false;
    });

    const items: GoalItem[] = vendedoresValidos.map((v: any) => {
      const cod = v.cod_vendedor;
      const goal = goalsByCod.get(cod);
      const sale = byVendedor.get(cod);
      const u = usuariosByCod.get(cod);
      const target = goal?.target_neto != null ? Number(goal.target_neto) : null;
      const avance = sale?.neto ?? 0;
      const pct = target && target > 0 ? avance / target : null;
      const proyeccion = diasTrans > 0 ? avance * (diasTotal / diasTrans) : avance;
      const necesarioDia = target && diasRestantes > 0 ? Math.max(0, (target - avance) / diasRestantes) : null;
      return {
        cod_vendedor: cod,
        nombre: u?.nombre ?? v.nombre,
        vendedor_key: u?.vendedor_key ?? null,
        email: u?.email ?? null,
        activo: !!(u && u.activo !== false),
        year, month,
        target_neto: target,
        avance: Number(avance.toFixed(2)),
        num_comprobantes: sale?.num ?? 0,
        pct_cumplimiento: pct,
        proyeccion: Number(proyeccion.toFixed(2)),
        necesario_por_dia: necesarioDia != null ? Number(necesarioDia.toFixed(2)) : null,
        dias_habiles_total: diasTotal,
        dias_habiles_transcurridos: diasTrans,
        dias_restantes: diasRestantes,
        goal_set_by_email: null,
        goal_updated_at: goal?.updated_at ?? null,
      };
    });

    const visible = user.rol === 'vendedor'
      ? items.filter(it => it.cod_vendedor === user.cod_vendedor)
      : items;

    let totales: any = null;
    if (user.rol !== 'vendedor') {
      const equipo = visible.filter(i => i.activo);
      const tgt = equipo.reduce((a, i) => a + (i.target_neto ?? 0), 0);
      const av = equipo.reduce((a, i) => a + i.avance, 0);
      totales = {
        target: tgt,
        avance: av,
        pct: tgt > 0 ? av / tgt : null,
        proyeccion: equipo.reduce((a, i) => a + i.proyeccion, 0),
        vendedores_con_target: equipo.filter(i => i.target_neto != null).length,
        vendedores_total: equipo.length,
      };
    }

    // ─── Clientes: avance al corte por cada cliente con objetivo ─────────────
    // Mismo patrón que listClientesObjetivo pero el avance viene del agregado
    // en RAM (byCliente), no del cache mensual de Supabase.
    type HistRow = { cod_cliente: number; cod_vendedor: number | null; objetivo_mes: number | null; fact_mes_pasado: number | null; fact_prom_3m: number | null; tipo_abc: string | null };
    const histByCliente = new Map<number, HistRow>();
    if (isHistoric) {
      let qH = sb().from('client_objectives_history')
        .select('cod_cliente, cod_vendedor, objetivo_mes, fact_mes_pasado, fact_prom_3m, tipo_abc')
        .eq('tenant_id', TENANT_ID)
        .eq('year', year).eq('month', month);
      if (codVendFilter != null) qH = qH.eq('cod_vendedor', codVendFilter);
      else if (codsListFilter) qH = qH.in('cod_vendedor', codsListFilter);
      qH = qH.limit(5000);
      const { data: histRows } = await qH;
      (histRows ?? []).forEach((h: any) => histByCliente.set(h.cod_cliente, h));
    }

    let qC = sb().from('client_operational')
      .select('cod_cliente, cod_vendedor, razon_social, localidad, frecuencia, dia_visita, tipo_abc, direccion, repartidor, hoja_ruta, dia_entrega, cond_pago, notas, objetivo_mes, objetivo_year, objetivo_month, fact_mes_pasado, fact_prom_3m, saldo_cta_cte')
      .eq('tenant_id', TENANT_ID);
    if (isHistoric) {
      const codClientes = Array.from(histByCliente.keys());
      if (codClientes.length === 0) {
        // Sin snapshot histórico → devolver clientes vacío (igual que listClientesObjetivo).
        res.json({
          ok: true, year, month, asOfDate,
          asOfBusinessDay: diasTrans, asOfDayClamped: clamped,
          is_historic: isHistoric,
          dias_habiles_total: diasTotal, dias_habiles_transcurridos: diasTrans, dias_restantes: diasRestantes,
          holidays, cached, cacheAge_ms: cacheAge,
          ventas_procesadas: ventasHasta.length, ventas_descartadas_por_fecha: ventas.length - ventasHasta.length,
          fetch_ms: fetchMs,
          items: visible, totales,
          clientes: [], historic_empty: true,
        });
        return;
      }
      qC = qC.in('cod_cliente', codClientes);
    } else {
      if (codVendFilter != null) qC = qC.eq('cod_vendedor', codVendFilter);
      else if (codsListFilter) qC = qC.in('cod_vendedor', codsListFilter);
    }
    qC = qC.limit(5000);
    const { data: clientes } = await qC;

    const clientesItems = (clientes ?? []).map((c: any) => {
      const sale = byCliente.get(c.cod_cliente);
      const avance = sale?.neto ?? 0;
      let objetivo: number | null;
      let codVendedorEfectivo: number | null;
      let factMesPasado: number | null;
      let factProm3m: number | null;
      let tipoAbc: string | null;
      if (isHistoric) {
        const h = histByCliente.get(c.cod_cliente);
        objetivo = h?.objetivo_mes != null ? Number(h.objetivo_mes) : null;
        codVendedorEfectivo = h?.cod_vendedor ?? c.cod_vendedor ?? null;
        factMesPasado = h?.fact_mes_pasado != null ? Number(h.fact_mes_pasado) : null;
        factProm3m = h?.fact_prom_3m != null ? Number(h.fact_prom_3m) : null;
        tipoAbc = h?.tipo_abc ?? c.tipo_abc ?? null;
      } else {
        const matches = c.objetivo_year === year && c.objetivo_month === month;
        objetivo = (matches && c.objetivo_mes != null) ? Number(c.objetivo_mes) : null;
        codVendedorEfectivo = c.cod_vendedor ?? null;
        factMesPasado = c.fact_mes_pasado != null ? Number(c.fact_mes_pasado) : null;
        factProm3m = c.fact_prom_3m != null ? Number(c.fact_prom_3m) : null;
        tipoAbc = c.tipo_abc ?? null;
      }
      const pct = objetivo && objetivo > 0 ? avance / objetivo : null;
      const falta = objetivo != null ? Math.max(0, objetivo - avance) : null;
      const sobrante = objetivo != null && avance > objetivo ? avance - objetivo : 0;
      const status = objetivo == null
        ? 'sin_objetivo'
        : avance >= objetivo ? 'completado'
        : avance > 0 ? 'parcial'
        : 'sin_compras';
      const locNorm = normLoc(c.localidad);
      return {
        cod_cliente: c.cod_cliente,
        cod_vendedor: codVendedorEfectivo,
        razon_social: c.razon_social,
        localidad: locNorm ? prettyLoc(locNorm) : c.localidad,
        localidad_norm: locNorm,
        frecuencia: c.frecuencia,
        dia_visita: c.dia_visita,
        tipo_abc: tipoAbc,
        direccion: c.direccion ?? null,
        repartidor: c.repartidor ?? null,
        hoja_ruta: c.hoja_ruta ?? null,
        dia_entrega: c.dia_entrega ?? null,
        cond_pago: c.cond_pago ?? null,
        notas: c.notas ?? null,
        objetivo_mes: objetivo,
        fact_mes_pasado: factMesPasado,
        fact_prom_3m: factProm3m,
        saldo_cta_cte: isHistoric ? null : (c.saldo_cta_cte != null ? Number(c.saldo_cta_cte) : null),
        avance: Number(avance.toFixed(2)),
        num_comprobantes: sale?.num ?? 0,
        pct_cumplimiento: pct,
        falta,
        sobrante,
        status,
      };
    });

    res.json({
      ok: true,
      year, month,
      asOfDate,
      asOfBusinessDay: diasTrans,
      asOfDayClamped: clamped,
      is_historic: isHistoric,
      dias_habiles_total: diasTotal,
      dias_habiles_transcurridos: diasTrans,
      dias_restantes: diasRestantes,
      holidays,
      cached,
      cacheAge_ms: cacheAge,
      ventas_procesadas: ventasHasta.length,
      ventas_descartadas_por_fecha: ventas.length - ventasHasta.length,
      fetch_ms: fetchMs,
      items: visible,
      totales,
      clientes: clientesItems,
    });
  } catch (err: any) {
    console.error('getGoalsSnapshot error:', err);
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}
