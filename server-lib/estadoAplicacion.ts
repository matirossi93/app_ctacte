import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Request, Response, NextFunction } from 'express';
import { hasSupabase, sb } from './supabase.js';

/** El builder genera esta identidad sin depender de un .git dentro del contenedor. */
export function leerVersionCompilada(): string {
  try {
    const info = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../build-info.json', import.meta.url)), 'utf8'));
    return /^[a-f0-9]{64}$/.test(info.version) ? info.version : 'development';
  } catch { return 'development'; }
}
export const VERSION_COMPILADA = leerVersionCompilada();

type Resultado = { listo: boolean; version: number; vinculo: boolean };
/** Un sondeo compartido, con expiración corta. La comprobación no muta datos. */
export function crearComprobadorEsquema(consultar: () => Promise<Resultado>, ahora = Date.now) {
  let guardado: { hasta: number; valor: Resultado } | null = null;
  let enCurso: Promise<Resultado> | null = null;
  return async (): Promise<Resultado> => {
    if (guardado && guardado.hasta > ahora()) return guardado.valor;
    if (enCurso) return enCurso;
    enCurso = Promise.resolve().then(consultar).then(d => ({ listo: d.listo === true && d.version === 42, version: 42, vinculo: d.vinculo === true }))
      .catch(() => ({ listo: false, version: 42, vinculo: false }))
      .then(valor => { guardado = { valor, hasta: ahora() + (valor.listo ? 30_000 : 3_000) }; return valor; })
      .finally(() => { enCurso = null; });
    return enCurso;
  };
}
export const comprobarEsquema = crearComprobadorEsquema(async () => {
  if (!hasSupabase()) return { listo: false, version: 42, vinculo: false };
  const { data, error } = await sb().rpc('reparto_estado_esquema').abortSignal(AbortSignal.timeout(5000));
  if (error) return { listo: false, version: 42, vinculo: false };
  // La capacidad nueva conserva version41 en el RPC para que aplicar SQL no bloquee la app anterior.
  return {
    listo: data?.listo === true && data?.version === 41 && data?.version_cierre === 42, version: 42,
    /**
     * 🔑 Capacidad POR FUNCIÓN, no versión del todo: si la 043 no se aplicó todavía, se apaga
     * vincular notas existentes y nada más. Exigirla en `listo` dejaría en 503 toda la
     * facturación por una pantalla que ni siquiera está en uso.
     */
    vinculo: data?.vinculo_listo === true && data?.version_vinculo === 43,
  };
});
export function saludProceso(_req: Request, res: Response) {
  res.setHeader('Cache-Control','no-store');
  res.json({ ok: true, version: VERSION_COMPILADA });
}
export async function estadoPreparacion(_req: Request, res: Response) {
  const esquema = await comprobarEsquema();
  const listo = esquema.listo && (process.env.NODE_ENV !== 'production' || VERSION_COMPILADA !== 'development');
  res.setHeader('Cache-Control','no-store');
  res.status(listo ? 200 : 503).json({ listo, version: VERSION_COMPILADA, esquema_requerido: 42, esquema_listo: esquema.listo, vinculo_notas: esquema.vinculo });
}
/** Evita escrituras financieras con migración ausente o permisos incorrectos. */
export async function exigirEsquemaReparto(req: Request, res: Response, next: NextFunction) {
  if (['GET','HEAD','OPTIONS'].includes(req.method)) { next(); return; }
  const estado = await comprobarEsquema();
  if (!estado.listo) { res.status(503).json({ error: 'Reparto está esperando una actualización de su base de datos. No se modificó ningún comprobante.' }); return; }
  next();
}

/**
 * Las guardas de la 043 son lo único que impide que una nota se cuente dos veces al adoptarla.
 * Sin ellas la pantalla no se habilita, pero el resto de la app sigue funcionando.
 */
export async function exigirVinculoNotas(_req: Request, res: Response, next: NextFunction) {
  const estado = await comprobarEsquema();
  if (!estado.vinculo) { res.status(503).json({ error: 'Vincular notas existentes está esperando una actualización de la base de datos. No se modificó nada.' }); return; }
  next();
}
