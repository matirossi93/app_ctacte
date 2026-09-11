import { useEffect, useState } from 'react';
import type { ResultadoPedido } from '../../server-lib/listas';
import { authHeaders } from './auth';

export interface EntradaControlLista { cod_articulo: number; cantidad: number; cod_lista: number; descuento_porc: number }

/** Identifica cantidades, orden, listas y descuentos; nunca deja avisos de otro borrador. */
export function useControlListas(items: EntradaControlLista[], contexto: string) {
    const contenido = JSON.stringify(items);
    const firma = `${contexto}:${contenido}`;
    const [respuesta, setRespuesta] = useState<{ firma: string; datos?: ResultadoPedido; error?: string } | null>(null);
    useEffect(() => {
        const rows = JSON.parse(contenido) as EntradaControlLista[];
        if (!rows.length || rows.some(i => !Number.isFinite(i.cantidad) || i.cantidad <= 0 || !Number.isFinite(i.descuento_porc) || i.descuento_porc < 0 || i.descuento_porc > 100)) return;
        const ctrl = new AbortController();
        const timer = setTimeout(async () => {
            try {
                const r = await fetch('/api/pedidos/validar', {
                    method: 'POST', signal: ctrl.signal,
                    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                    // En oficina se muestran desvíos y el cálculo, no sugerencias comerciales:
                    // no consultar precios por renglón sólo para silenciar comentarios.
                    body: JSON.stringify({ items: rows, solo_reglas: true }),
                });
                const d = await r.json();
                if (ctrl.signal.aborted) return;
                if (!r.ok || !d?.ok || d.sin_control) throw new Error('No se pudieron controlar las listas.');
                setRespuesta({ firma, datos: d });
            } catch {
                if (!ctrl.signal.aborted) setRespuesta({ firma, error: 'Control de listas no disponible. Revisá los precios antes de guardar.' });
            }
        }, 400);
        return () => { clearTimeout(timer); ctrl.abort(); };
    }, [contenido, firma]);
    return respuesta?.firma === firma ? respuesta : null;
}
