import type { Request, Response } from 'express';
import { sb, TENANT_ID, hasSupabase } from './supabase.js';
import type { JwtPayload } from './auth.js';

/**
 * Contador de visitas por sección de la app de vendedores.
 *
 * Existe para poder decidir qué sacar del menú con datos y no con impresiones. Lo que la gente
 * CARGA ya se puede medir (hay tablas de cobranzas, pedidos, actividad); lo que sólo MIRA no
 * dejaba ninguna huella. El 29/08/2026 se midió el uso de todas las secciones y se pudo probar
 * que Actividad estaba muerta (6 registros en toda su historia) pero NO se pudo afirmar nada
 * sobre Rebotes ni Objetivos, que son de consulta.
 *
 * Es telemetría de uso, no de contenido: se guarda qué sección y quién, nunca qué miró adentro.
 */

/** Las únicas secciones que existen. Un valor fuera de esta lista se descarta. */
const SECCIONES = ['hoy', 'cobranzas', 'objetivos', 'comisiones', 'rebotes', 'pedidos'] as const;

/** Filtra lo que llega del cliente: sin esto, cualquiera puede llenar la tabla de basura. */
export function esSeccionValida(x: unknown): boolean {
  return typeof x === 'string' && (SECCIONES as readonly string[]).includes(x);
}

/** Agrupa las filas crudas en el resumen que se lee para decidir. Pura, para poder testearla. */
export function agruparVistas(filas: Array<{ seccion: string; cod_vendedor: number | null }>) {
  const acc = new Map<string, { visitas: number; personas: Set<number | null> }>();
  for (const r of filas) {
    const k = String(r.seccion);
    if (!acc.has(k)) acc.set(k, { visitas: 0, personas: new Set() });
    const a = acc.get(k)!;
    a.visitas++;
    a.personas.add(r.cod_vendedor ?? null);
  }
  return [...acc.entries()]
    .map(([seccion, a]) => ({ seccion, visitas: a.visitas, personas: a.personas.size }))
    .sort((x, y) => y.visitas - x.visitas || x.seccion.localeCompare(y.seccion));
}

/**
 * POST /api/telemetria/vista { seccion }
 *
 * Responde 204 SIEMPRE, incluso si no se pudo guardar: el front lo llama de fondo y un error
 * acá no puede ensuciarle la pantalla al vendedor ni hacerle reintentar. Si falla, se pierde
 * una fila de una tabla de conteo — no es dato de negocio.
 */
export async function registrarVista(req: Request & { user?: JwtPayload }, res: Response): Promise<void> {
  res.status(204).end();
  try {
    if (!hasSupabase()) return;
    const seccion = String((req.body ?? {}).seccion ?? '');
    if (!esSeccionValida(seccion)) return;
    await sb().from('section_views').insert({
      tenant_id: TENANT_ID,
      seccion,
      cod_vendedor: req.user?.cod_vendedor ?? null,
    });
  } catch {
    /* telemetría: no se reintenta ni se loguea, no vale la pena el ruido */
  }
}

/**
 * GET /api/telemetria/secciones?dias=14 — el resumen para decidir.
 * Devuelve cuántas visitas y cuántas personas distintas por sección.
 */
export async function resumenVistas(req: Request & { user?: JwtPayload }, res: Response): Promise<void> {
  try {
    if (!hasSupabase()) { res.status(500).json({ error: 'Supabase no configurado' }); return; }
    const dias = Math.min(Math.max(Number(req.query.dias) || 14, 1), 180);
    const desde = new Date(Date.now() - dias * 86400000).toISOString();
    const { data, error } = await sb()
      .from('section_views')
      .select('seccion, cod_vendedor')
      .eq('tenant_id', TENANT_ID)
      .gte('created_at', desde)
      .limit(50000);
    if (error) { res.status(500).json({ error: error.message }); return; }

    res.json({ ok: true, dias, items: agruparVistas((data ?? []) as any[]) });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'error' });
  }
}
