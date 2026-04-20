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

function businessDaysElapsed(year: number, month: number, day: number): number {
  let bd = 0;
  for (let d = 1; d <= day; d++) {
    const wd = new Date(year, month - 1, d).getDay();
    if (wd !== 0) bd++;
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

    // Fetch goals + ventas caches + vendedores IM en paralelo
    const [goalsRes, salesRes, vendedoresIM] = await Promise.all([
      sb().from('vendor_goals').select('cod_vendedor, target_neto, set_by, updated_at').eq('tenant_id', TENANT_ID).eq('year', year).eq('month', month),
      sb().from('vendor_sales_monthly').select('cod_vendedor, neto, num_comprobantes').eq('tenant_id', TENANT_ID).eq('year', year).eq('month', month),
      fetchVendedores().catch(() => [])
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

    const diasTotal = businessDaysInMonth(year, month);
    const isCurrentMonth = year === t.year && month === t.month;
    const diasTrans = isCurrentMonth ? businessDaysElapsed(year, month, t.day) : diasTotal;
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
