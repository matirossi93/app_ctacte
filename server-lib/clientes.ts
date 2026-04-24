import type { Request, Response } from 'express';
import { sb, TENANT_ID, hasSupabase } from './supabase.js';
import type { JwtPayload } from './auth.js';

/**
 * Lookup de TODOS los clientes del maestro (client_operational), no solo deudores.
 * Uso: picker de Recibos cuando el cliente no tiene saldo en el mes (ej. adelantos en efectivo).
 * Vendedor ve solo los suyos. Admin/gerente ve todos, o filtra vía ?cod_vendedor=.
 */
export async function listClientesLookup(req: Request & { user?: JwtPayload }, res: Response) {
    try {
        if (!hasSupabase()) { res.status(500).json({ ok: false, error: 'Supabase no configurado' }); return; }
        const user = req.user!;

        let q = sb().from('client_operational')
            .select('cod_cliente, cod_vendedor, razon_social, localidad')
            .eq('tenant_id', TENANT_ID);

        if (user.rol === 'vendedor') {
            q = q.eq('cod_vendedor', user.cod_vendedor ?? -1);
        } else if (req.query.cod_vendedor) {
            q = q.eq('cod_vendedor', Number(req.query.cod_vendedor));
        }

        q = q.order('razon_social', { ascending: true }).limit(5000);
        const { data, error } = await q;
        if (error) { res.status(500).json({ ok: false, error: error.message }); return; }

        const items = (data ?? []).map((c: any) => ({
            cod: String(c.cod_cliente),
            name: c.razon_social ?? `Cliente #${c.cod_cliente}`,
            localidad: c.localidad ?? null,
            cod_vendedor: c.cod_vendedor ?? null,
        }));
        res.json({ ok: true, items });
    } catch (err: any) {
        console.error('listClientesLookup error:', err);
        res.status(500).json({ ok: false, error: err.message });
    }
}
