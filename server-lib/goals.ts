import type { Request, Response } from 'express';
import { sb, TENANT_ID, hasSupabase } from './supabase.js';
import { fetchVendedores } from './infomanager.js';
import type { JwtPayload } from './auth.js';

function today(): { year: number; month: number; day: number } {
  const d = new Date();
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function businessDaysInMonth(year: number, month: number): number {
  const days = new Date(year, month, 0).getDate();
  let bd = 0;
  for (let d = 1; d <= days; d++) {
    const wd = new Date(year, month - 1, d).getDay();
    if (wd !== 0) bd++; // excluye domingo, sábado cuenta (Semillero opera sábados)
  }
  return bd;
}

function businessDaysElapsed(year: number, month: number, day: number, totalDays: number, totalAuto: number): number {
  // Días trabajados reales excluyendo domingos
  let bd = 0;
  for (let d = 1; d <= day; d++) {
    const wd = new Date(year, month - 1, d).getDay();
    if (wd !== 0) bd++;
  }
  // Si hay override manual de totalDays (total con feriados descontados),
  // proporcionamos el transcurrido a esa escala
  if (totalDays !== totalAuto && totalAuto > 0) {
    bd = Math.min(totalDays, Math.round(bd * (totalDays / totalAuto)));
  }
  return bd;
}

export interface GoalItem {
  cod_vendedor: number;
  nombre: string;
  vendedor_key: string | null;
  email: string | null;
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
      sb().from('month_config').select('dias_habiles').eq('tenant_id', TENANT_ID).eq('year', year).eq('month', month).maybeSingle()
    ]);

    if (goalsRes.error) { res.status(500).json({ error: `goals: ${goalsRes.error.message}` }); return; }
    if (salesRes.error) { res.status(500).json({ error: `sales: ${salesRes.error.message}` }); return; }

    // Traer usuarios con cod_vendedor + email para tags visuales
    const { data: usuariosRows } = await sb().from('usuarios')
      .select('id, email, cod_vendedor, vendedor_key, nombre')
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

    const diasAuto = businessDaysInMonth(year, month);
    // Prioridad: month_config.dias_habiles > cálculo automático (feriados no considerados)
    const diasTotal = (monthCfgRes.data as any)?.dias_habiles ?? diasAuto;
    const isCurrentMonth = year === t.year && month === t.month;
    const diasTrans = isCurrentMonth ? businessDaysElapsed(year, month, t.day, diasTotal, diasAuto) : diasTotal;
    const diasRestantes = Math.max(0, diasTotal - diasTrans);

    // Base: unión de vendedores de InfoManager (filtramos los reales de venta, no sucursales/consumo interno)
    const vendedoresValidos = (vendedoresIM ?? []).filter((v: any) => {
      const n = String(v?.nombre ?? '').toUpperCase();
      return !n.includes('SUCURSAL') && !n.includes('CONSUMO');
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
      dias_habiles_source: (monthCfgRes.data as any)?.dias_habiles ? 'manual' : 'auto',
      dias_habiles_transcurridos: diasTrans,
      dias_restantes: diasRestantes,
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
    q = q.order('objetivo_mes', { ascending: false, nullsFirst: false }).limit(1000);
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
      return {
        cod_cliente: c.cod_cliente,
        cod_vendedor: c.cod_vendedor,
        razon_social: c.razon_social,
        localidad: c.localidad,
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

    // Filtro
    const filter = String(req.query.filter ?? 'todos');
    const filtered = items.filter(it => {
      if (filter === 'completado') return it.status === 'completado';
      if (filter === 'parcial') return it.status === 'parcial';
      if (filter === 'bajo_objetivo') return it.status === 'sin_compras' || it.status === 'parcial';
      if (filter === 'sin_compras') return it.status === 'sin_compras';
      if (filter === 'sin_objetivo') return it.status === 'sin_objetivo';
      return true;
    });

    // Stats
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
    };

    res.json({ ok: true, year, month, items: filtered, stats });
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
    const dias_habiles = Number(body.dias_habiles);
    if (!year || !month || !dias_habiles || dias_habiles > 31 || dias_habiles < 1) {
      res.status(400).json({ error: 'payload inválido: { year, month, dias_habiles }' });
      return;
    }
    const { data, error } = await sb().from('month_config').upsert({
      tenant_id: TENANT_ID,
      year, month, dias_habiles,
      notas: body.notas ?? null,
      set_by: user.sub,
      updated_at: new Date().toISOString()
    }, { onConflict: 'tenant_id,year,month' }).select().single();
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
