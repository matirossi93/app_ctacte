import type { Request, Response } from 'express';
import { sb, TENANT_ID, hasSupabase } from './supabase.js';
import { fetchClientesIMCached } from './infomanager.js';
import type { JwtPayload } from './auth.js';

/**
 * Lookup de TODOS los clientes para el picker de Recibos.
 *
 * Fuente primaria: la API de InfoManager (/clientes). Antes leíamos la tabla
 * `client_operational` de Supabase, que se llena con la importación mensual del
 * Excel — eso dejaba afuera a los clientes nuevos del mes y no se los podía
 * elegir para cargar un recibo. IM siempre tiene el maestro al día.
 *
 * Vendedor ve solo los suyos (filtra por cod_vendedor del cliente en IM).
 * Admin/gerente ven todos, o filtran vía ?cod_vendedor=.
 *
 * Fallback: si IM no responde, caemos al maestro de Supabase para no dejar el
 * picker vacío.
 */
export async function listClientesLookup(req: Request & { user?: JwtPayload }, res: Response) {
    try {
        const user = req.user!;

        // Un vendedor sin cod_vendedor filtraba por -1 y devolvia [] con ok:true, o sea
        // exactamente lo mismo que "este vendedor no tiene clientes". Es un problema de
        // configuracion del usuario, no un listado vacio: que se distinga.
        if (user.rol === 'vendedor' && user.cod_vendedor == null) {
            res.json({ ok: true, items: [], source: 'none', sin_vendedor: true });
            return;
        }

        // ── Fuente primaria: InfoManager ────────────────────────────────────
        let clientesIM: Awaited<ReturnType<typeof fetchClientesIMCached>> = [];
        try {
            clientesIM = await fetchClientesIMCached();
        } catch (e: any) {
            console.warn('[listClientesLookup] IM fallo, intento fallback Supabase:', e?.message);
        }

        if (clientesIM.length > 0) {
            let items = clientesIM.map((c) => ({
                cod: String(c.cod_cliente),
                name: c.razon_social || `Cliente #${c.cod_cliente}`,
                localidad: c.localidad ?? null,
                cod_vendedor: c.cod_vendedor ?? null,
                // La lista de precios del cliente. El buscador de productos del módulo de
                // pedidos cotiza con esto: sin el dato acá arrancaba siempre en Lista 1 y le
                // mostraba al vendedor un precio que no era el del cliente que tiene enfrente.
                cod_lista: Number((c as any).lista_precio) > 0 ? Number((c as any).lista_precio) : null,
            }));

            if (user.rol === 'vendedor') {
                const cv = user.cod_vendedor ?? -1;
                items = items.filter((i) => i.cod_vendedor === cv);
            } else if (req.query.cod_vendedor) {
                const cv = Number(req.query.cod_vendedor);
                items = items.filter((i) => i.cod_vendedor === cv);
            }

            items.sort((a, b) => a.name.localeCompare(b.name, 'es'));
            res.json({ ok: true, items, source: 'infomanager' });
            return;
        }

        // ── Fallback: maestro Supabase (importación Excel) ──────────────────
        if (!hasSupabase()) {
            res.json({ ok: true, items: [], source: 'none' });
            return;
        }

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
        res.json({ ok: true, items, source: 'supabase_fallback' });
    } catch (err: any) {
        console.error('listClientesLookup error:', err);
        res.status(500).json({ ok: false, error: err.message });
    }
}
