import type { Request, Response } from 'express';
import { sb, TENANT_ID, hasSupabase } from './supabase.js';
import { fetchVendedores } from './infomanager.js';
import type { JwtPayload } from './auth.js';

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

    // Base: unión de vendedores de InfoManager (filtramos sucursales/consumo).
    // Además, por default filtramos los que NO tienen usuario con activo=true.
    // El admin puede pedir ?incluir_inactivos=true para verlos igual.
    const incluirInactivos = String(req.query.incluir_inactivos ?? '') === 'true';
    const vendedoresValidos = (vendedoresIM ?? []).filter((v: any) => {
      const n = String(v?.nombre ?? '').toUpperCase();
      if (n.includes('SUCURSAL') || n.includes('CONSUMO')) return false;
      if (incluirInactivos) return true;
      const u = usuariosByCod.get(v.cod_vendedor);
      // Si no hay usuario asociado → oculto por default (probable histórico IM).
      // Si hay usuario → solo si activo=true.
      return !!u && u.activo !== false;
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
        activo: u?.activo !== false,
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

    // Totales equipo (solo para admin/gerente)
    let totales: any = null;
    if (user.rol !== 'vendedor') {
      const tgt = visible.reduce((a, i) => a + (i.target_neto ?? 0), 0);
      const av = visible.reduce((a, i) => a + i.avance, 0);
      totales = {
        target: tgt,
        avance: av,
        pct: tgt > 0 ? av / tgt : null,
        proyeccion: visible.reduce((a, i) => a + i.proyeccion, 0),
        vendedores_con_target: visible.filter(i => i.target_neto != null).length,
        vendedores_total: visible.length,
      };
    }

    res.json({
      ok: true,
      year, month,
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
 */
export async function listClientesObjetivo(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    if (!hasSupabase()) { res.status(500).json({ error: 'Supabase no configurado' }); return; }
    const user = req.user!;
    const t = today();
    const year = Number(req.query.year) || t.year;
    const month = Number(req.query.month) || t.month;

    let codVend: number | null = null;
    if (user.rol === 'vendedor') {
      codVend = user.cod_vendedor ?? -1;
    } else if (req.query.cod_vendedor) {
      codVend = Number(req.query.cod_vendedor);
    }

    // Clientes del vendedor (o todos si admin sin filtro)
    let q = sb().from('client_operational').select('cod_cliente, cod_vendedor, razon_social, localidad, frecuencia, dia_visita, tipo_abc, objetivo_mes, fact_mes_pasado, fact_prom_3m, saldo_cta_cte').eq('tenant_id', TENANT_ID);
    if (codVend != null) q = q.eq('cod_vendedor', codVend);
    q = q.order('objetivo_mes', { ascending: false, nullsFirst: false }).limit(2000);
    const { data: clientes, error: errC } = await q;
    if (errC) { res.status(500).json({ error: errC.message }); return; }

    // Avance por cliente mes actual
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
      const objetivo = c.objetivo_mes != null ? Number(c.objetivo_mes) : null;
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
        cod_vendedor: c.cod_vendedor,
        razon_social: c.razon_social,
        localidad: locNorm ? prettyLoc(locNorm) : c.localidad,
        localidad_norm: locNorm,
        frecuencia: c.frecuencia,
        dia_visita: c.dia_visita,
        tipo_abc: c.tipo_abc,
        objetivo_mes: objetivo,
        fact_mes_pasado: c.fact_mes_pasado != null ? Number(c.fact_mes_pasado) : null,
        fact_prom_3m: c.fact_prom_3m != null ? Number(c.fact_prom_3m) : null,
        saldo_cta_cte: c.saldo_cta_cte != null ? Number(c.saldo_cta_cte) : null,
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

    res.json({ ok: true, year, month, items: filtered, stats, seleccion });
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

    if (diasProvided) {
      payload.dias_habiles = dias_habiles;
    } else if (holidays) {
      // dias_habiles es NOT NULL — si el row no existe aún, necesitamos un valor.
      // Chequear si existe; si no, calcular auto desde el cálculo con feriados.
      const { data: existing } = await sb().from('month_config')
        .select('dias_habiles')
        .eq('tenant_id', TENANT_ID).eq('year', year).eq('month', month)
        .maybeSingle();
      if (!existing) {
        payload.dias_habiles = businessDaysInMonth(year, month, holidays);
      }
      // Si existe, no tocamos dias_habiles (se mantiene el valor previo).
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
