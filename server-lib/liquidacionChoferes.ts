/**
 * Los choferes y lo que entregaron: la base del pago.
 *
 * Mati (08/09/2026): *"tenemos que incorporar el selector de transportista en HR... también
 * asignamos a cada hoja el chofer"*, *"es el mismo dato: chofer y transportista"*, y sobre todo:
 * *"analizamos mes a mes las hojas de rutas porque **a ellos se les paga en función a lo que
 * entregan**. Eso tiene que estar perfecto y actualizado"*.
 *
 * 🔴 Por eso este módulo no es un reporte de color: **de acá sale un pago**. Dos consecuencias
 * de diseño:
 *  · Se liquida sobre las hojas **cerradas** — una hoja abierta todavía puede cambiar. Las
 *    abiertas se cuentan aparte, para que se vea qué falta cerrar antes de pagar.
 *  · Los importes salen del snapshot guardado en cada hoja, que es lo que efectivamente se
 *    llevó el camión.
 *
 * 🔑 El importe descuenta las NOTAS DE CRÉDITO por lo que no se entregó (*"una vez que vuelve el
 * repartidor se hacen NC o facturas por dif de mercadería y eso impacta en el num final"*). Como
 * la API de IM no relaciona una NC con su factura, esas notas se emiten desde el panel y el
 * vínculo lo guarda `hojas_ruta_ajustes` (migración 036).
 *
 * 🪤 Sólo cuentan los ajustes EMITIDOS. Uno cargado y no emitido no bajó ninguna cuenta
 * corriente: descontarlo sería pagarle de menos al chofer por algo que no pasó.
 */
import type { Request, Response } from 'express';
import { sb, TENANT_ID } from './supabase.js';
import type { JwtPayload } from './auth.js';
import { puedeArmarHojasDeRuta } from './permisos.js';
import { fechaArgentina } from './infomanager.js';

function frenaSiNoPuede(req: Request & { user?: JwtPayload }, res: Response): boolean {
  if (!puedeArmarHojasDeRuta(String(req.user?.rol ?? ''))) {
    res.status(403).json({ error: 'Esto lo ve administración.' });
    return true;
  }
  return false;
}

const redondear = (n: number) => Math.round(n * 100) / 100;

/** GET /api/choferes — la lista para el selector de la hoja. */
export async function listarChoferes(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  const { data, error } = await sb().from('choferes')
    .select('id, nombre, activo').eq('tenant_id', TENANT_ID).eq('activo', true).order('nombre');
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ ok: true, choferes: data ?? [] });
}

/** El primer y el último día de un mes `YYYY-MM`, sin depender de la zona horaria. */
export function limitesDelMes(mes: string): { desde: string; hasta: string } {
  const [a, m] = mes.split('-').map(Number);
  const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate();
  return { desde: `${mes}-01`, hasta: `${mes}-${String(ultimo).padStart(2, '0')}` };
}

/**
 * GET /api/liquidacion?mes=YYYY-MM — cuánto entregó cada chofer en el mes.
 *
 * Por chofer: hojas cerradas, pedidos, clientes, bultos, kilos e importe. Y aparte, lo que
 * todavía está en hojas abiertas, que **no se liquida** hasta que se cierren.
 */
export async function liquidacionMensual(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  try {
    const mes = /^\d{4}-\d{2}$/.test(String(req.query.mes ?? '')) ? String(req.query.mes) : fechaArgentina().slice(0, 7);
    const { desde, hasta } = limitesDelMes(mes);

    const { data: hojas, error } = await sb().from('hojas_ruta')
      .select('id, numero, fecha, estado, chofer_id, transporte, cerrada_at, choferes(nombre), hojas_ruta_pedidos(cod_cliente, total, bultos, kg), hojas_ruta_ajustes(tipo, importe, emitido_at)')
      .eq('tenant_id', TENANT_ID).gte('fecha', desde).lte('fecha', hasta).order('fecha');
    if (error) { res.status(500).json({ error: error.message }); return; }

    const porChofer = new Map<string, any>();
    let abiertas = 0;
    let importeAbierto = 0;

    for (const h of (hojas ?? []) as any[]) {
      const pedidos = h.hojas_ruta_pedidos ?? [];
      const despachado = pedidos.reduce((s: number, p: any) => s + Number(p.total ?? 0), 0);
      // Lo que volvió: sólo los ajustes ya emitidos en InfoManager.
      const emitidos = (h.hojas_ruta_ajustes ?? []).filter((a: any) => a.emitido_at);
      const nc = emitidos.filter((a: any) => a.tipo === 'nc').reduce((s: number, a: any) => s + Number(a.importe ?? 0), 0);
      const nd = emitidos.filter((a: any) => a.tipo === 'nd').reduce((s: number, a: any) => s + Number(a.importe ?? 0), 0);
      const importe = despachado - nc + nd;
      const kg = pedidos.reduce((s: number, p: any) => s + Number(p.kg ?? 0), 0);
      const bultos = pedidos.reduce((s: number, p: any) => s + Number(p.bultos ?? 0), 0);

      // 🔴 Sólo se liquida lo cerrado: una hoja abierta todavía puede cambiar.
      if (h.estado !== 'cerrada') {
        // 🪤 Una hoja VACÍA no es algo que falte cerrar: es una hoja creada por error, y el panel
        // ni siquiera ofrece cerrarla (no tiene nada que entregar). Contarla dejaba un aviso de
        // "quedan 3 hojas sin cerrar por $0" que pedía una acción imposible — lo que corresponde
        // es borrarla. Auditoría del 08/09/2026.
        if (h.estado !== 'anulada' && pedidos.length) { abiertas += 1; importeAbierto += importe; }
        continue;
      }

      // 🪤 Sin chofer asignado la hoja igual se muestra, en un grupo aparte: si se repartiera
      // entre los demás, alguien cobraría de más y otro de menos.
      const k = h.chofer_id ? String(h.chofer_id) : 'sin_chofer';
      if (!porChofer.has(k)) {
        porChofer.set(k, {
          chofer_id: h.chofer_id ?? null,
          chofer: h.choferes?.nombre ?? (h.chofer_id ? 'Chofer dado de baja' : 'Sin chofer asignado'),
          hojas: 0, pedidos: 0, clientes: new Set<number>(), bultos: 0, kg: 0, importe: 0,
          // Se muestran aparte: es lo que el chofer llevó y volvió sin entregar.
          despachado: 0, notas_credito: 0,
          numeros: [] as number[],
        });
      }
      const c = porChofer.get(k);
      c.hojas += 1;
      c.pedidos += pedidos.length;
      for (const p of pedidos) c.clientes.add(Number(p.cod_cliente));
      c.bultos += bultos;
      c.kg += kg;
      c.importe += importe;
      c.despachado += despachado;
      c.notas_credito += nc;
      c.numeros.push(h.numero);
    }

    const choferes = [...porChofer.values()]
      .map(c => ({
        ...c,
        clientes: c.clientes.size,
        bultos: redondear(c.bultos), kg: redondear(c.kg), importe: redondear(c.importe),
        despachado: redondear(c.despachado), notas_credito: redondear(c.notas_credito),
      }))
      .sort((a, b) => b.importe - a.importe);

    res.json({
      ok: true, mes, desde, hasta,
      choferes,
      totales: {
        hojas: choferes.reduce((s, c) => s + c.hojas, 0),
        pedidos: choferes.reduce((s, c) => s + c.pedidos, 0),
        kg: redondear(choferes.reduce((s, c) => s + c.kg, 0)),
        importe: redondear(choferes.reduce((s, c) => s + c.importe, 0)),
      },
      // Lo que todavía no se puede liquidar, para que se vea antes de pagar.
      sin_cerrar: { hojas: abiertas, importe: redondear(importeAbierto) },
      // El importe ya descuenta las notas de crédito emitidas desde el panel.
      incluye_ajustes: true,
      notas_credito: redondear(choferes.reduce((s, c) => s + c.notas_credito, 0)),
    });
  } catch (err: any) {
    console.error('[liquidacionMensual]', err?.message);
    res.status(500).json({ error: err?.message ?? 'error' });
  }
}
