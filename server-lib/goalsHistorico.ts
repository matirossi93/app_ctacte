import type { Request, Response } from 'express';
import { sb, TENANT_ID, hasSupabase } from './supabase.js';
import { fetchVendedores } from './infomanager.js';
import type { JwtPayload } from './auth.js';
import { COD_VENDEDORES_VISIBLES } from './comisionesShared.js';
import { usuariosPorCod } from './usuariosPorCod.js';
import { armarHistorico } from '../src/utils/cumplimiento.js';
import { getCached as getResponseCached, setCached as setResponseCached } from './goalsResponseCache.js';

/**
 * GET /api/goals/historico?year=
 *
 * El año completo de objetivos contra lo vendido, para que Matías y Manolo vean la tendencia
 * cuando definen el objetivo del mes siguiente (pedido del 01/09/2026).
 *
 * 🔑 No le pega a InfoManager para los números: `vendor_goals` y `vendor_sales_monthly` ya
 * guardan una fila por vendedor y por mes, así que son dos SELECT y nada más. La única
 * llamada a IM es el maestro de vendedores (cacheado), igual que en el panel del mes.
 */

/** El mes en curso en Argentina (UTC-3). Ver src/utils/hoyArgentina.ts para el mismo criterio. */
function mesEnCursoArgentina(): { year: number; month: number } {
  const [year, month] = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10).split('-').map(Number);
  return { year, month };
}

export async function listGoalsHistorico(req: Request & { user?: JwtPayload }, res: Response) {
  try {
    if (!hasSupabase()) { res.status(500).json({ error: 'Supabase no configurado' }); return; }
    const user = req.user!;
    // Es la foto del equipo entero: mismo criterio que el resto de las vistas de equipo.
    if (user.rol !== 'admin' && user.rol !== 'gerente') { res.status(403).json({ error: 'Requiere admin/gerente' }); return; }

    const enCurso = mesEnCursoArgentina();
    const year = Number(req.query.year) || enCurso.year;
    if (!Number.isInteger(year) || year < 2020 || year > enCurso.year + 1) {
      res.status(400).json({ error: 'year inválido' }); return;
    }

    const cacheKey = `historico:${year}`;
    const cached = getResponseCached(cacheKey);
    if (cached) { res.setHeader('X-Cache', 'HIT'); res.json(cached); return; }

    const [goalsRes, salesRes, vendedoresIM] = await Promise.all([
      sb().from('vendor_goals').select('cod_vendedor, year, month, target_neto')
        .eq('tenant_id', TENANT_ID).eq('year', year),
      sb().from('vendor_sales_monthly').select('cod_vendedor, year, month, neto')
        .eq('tenant_id', TENANT_ID).eq('year', year),
      fetchVendedores().catch(() => []),
    ]);
    if (goalsRes.error) throw new Error(`goals: ${goalsRes.error.message}`);
    if (salesRes.error) throw new Error(`sales: ${salesRes.error.message}`);

    const { data: usuariosRows } = await sb().from('usuarios')
      .select('id, email, cod_vendedor, vendedor_key, nombre, activo, created_at')
      .eq('tenant_id', TENANT_ID).not('cod_vendedor', 'is', null);
    const { byCod: usuariosByCod } = usuariosPorCod(usuariosRows ?? []);

    // Mismo filtro que el panel del mes, para que no aparezca un vendedor acá que allá no está.
    // 📌 Se incluyen los inactivos: el histórico es de meses pasados, y alguien que ya no está
    // igual tuvo objetivos que se cumplieron o no. Sacarlo escondería parte del año.
    const vendedores = (vendedoresIM ?? [])
      .filter((v: any) => {
        const n = String(v?.nombre ?? '').toUpperCase();
        if (n.includes('SUCURSAL') || n.includes('CONSUMO')) return false;
        return COD_VENDEDORES_VISIBLES.has(Number(v.cod_vendedor));
      })
      .map((v: any) => ({
        cod_vendedor: Number(v.cod_vendedor),
        nombre: usuariosByCod.get(v.cod_vendedor)?.nombre ?? v.nombre,
      }));

    const historico = armarHistorico({
      year,
      goals: (goalsRes.data ?? []) as any[],
      ventas: (salesRes.data ?? []) as any[],
      vendedores,
      enCurso,
    });

    const payload = { ok: true, ...historico, mes_en_curso: enCurso };
    setResponseCached(cacheKey, payload);
    res.json(payload);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}
