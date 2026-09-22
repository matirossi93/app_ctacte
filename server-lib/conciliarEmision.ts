/**
 * 🔴 SE ANULÓ LA FACTURA Y EL REMITO QUEDÓ VIVO. LAS DOS SALIDAS.
 *
 * Mati (22/09/2026), sobre el caso de BUSTOS: *"es que eran dos clientes apellido BUSTOS que
 * estaban involucrados... rafael y el otro roberto"*.
 *
 * Lo que había pasado, leído de InfoManager: el pedido era de BUSTOS, Roberto (124) y se cargó a
 * BUSTOS, Rafael (522). Salieron FA 50695 + RE 77809 al cliente equivocado; la oficina borró la
 * factura en IM y rehizo el pedido para Roberto. Cuatro días después el RE 77809 seguía vigente
 * —descontando por segunda vez los mismos 9 artículos, verificado midiendo el stock antes y
 * después de anularlo— y en la hoja de ruta 3419 figuraba la entrega al cliente que no la
 * recibió.
 *
 * La app lo había detectado: `sincronizarAnulados` marca el pedido `anulado` y avisa *"conciliá
 * también el remito antes de emitir otro pedido"*. Pero eso es un cartel, no una salida — y sin
 * salida, lo único que puede hacer la oficina es rehacer el pedido, que emite factura **y**
 * remito: un segundo remito por mercadería que ya salió.
 *
 * 🔑 LA PREGUNTA QUE DECIDE ES UNA SOLA, Y LA APP NO LA PUEDE CONTESTAR: ¿el remito que quedó
 *    vivo corresponde o no? Con la factura muerta las dos situaciones se ven idénticas desde
 *    afuera, y elegir mal cuesta caro en los dos sentidos: anular un remito bueno deja
 *    mercadería entregada sin respaldo, y dejar vivo uno malo la descuenta dos veces. Así que la
 *    contesta una persona, con el remito a la vista, y cada respuesta tiene su camino:
 *
 *      · NO corresponde  → `descartarRemitoSobrante`: se anula en IM, sale de la hoja de ruta y
 *                          el pedido vuelve a estar libre.
 *      · SÍ corresponde  → `habilitarFacturaPendiente`: el pedido pasa a `factura_pendiente` y
 *                          Facturar emite SÓLO la factura, enganchándole el remito que ya existe.
 */
import type { Request, Response } from 'express';
import type { JwtPayload } from './auth.js';
import { sb, TENANT_ID } from './supabase.js';
import { frenaSiNoPuede } from './facturarPresupuestos.js';
import { anularComprobante, cabeceraComprobante, fechaArgentina, invalidarIM } from './infomanager.js';
import { invalidarVista } from './vistaPresupuestos.js';
import { invalidarRemitos } from './vistaRemitos.js';
import { mutarReparto } from './repartoDatos.js';

/** Los campos de la fila que hacen falta para conciliar. */
const CAMPOS = 'im_comprobante_id, im_numero, cliente_nombre, cod_cliente, cod_empresa, '
  + 'im_factura_id, im_factura_numero, im_factura_tipo, im_remito_id, im_remito_numero, '
  + 'facturado_at, estado_emision, historial_remitos, historial_facturas';

interface FilaEmitida {
  im_comprobante_id: string;
  im_numero: number | null;
  cliente_nombre: string | null;
  cod_cliente: number;
  im_factura_id: string | null;
  im_factura_numero: number | null;
  im_factura_tipo: string | null;
  im_remito_id: string | null;
  im_remito_numero: number | null;
  facturado_at: string | null;
  estado_emision: string | null;
  historial_remitos: unknown[] | null;
  historial_facturas: unknown[] | null;
}

/**
 * La fila tiene que estar en el estado que estos dos caminos arreglan: factura registrada que ya
 * no vale, y remito registrado. Cualquier otra cosa se rechaza con su motivo, no con un 404 mudo.
 */
async function filaParaConciliar(
  id: string,
): Promise<{ ok: true; fila: FilaEmitida } | { ok: false; status: number; error: string }> {
  const leer = (campos: string) => sb().from('presupuestos_facturados')
    .select(campos).eq('tenant_id', TENANT_ID).eq('im_comprobante_id', id).maybeSingle();
  let { data, error } = await leer(CAMPOS);
  /**
   * 🪤 Entre que sale el deploy y se aplica la migración 051, `historial_facturas` no existe y el
   * select entero falla — también para descartar un remito, que ni la usa. Se relee sin ella: el
   * único camino que la necesita de verdad avisa por su cuenta que falta la migración.
   */
  if (error && ['42703', 'PGRST204'].includes(String((error as any).code))) {
    ({ data, error } = await leer(CAMPOS.replace(', historial_facturas', '')));
  }
  if (error) return { ok: false, status: 500, error: error.message };
  if (!data) return { ok: false, status: 404, error: 'Ese pedido no tiene una emisión registrada.' };
  const fila = data as unknown as FilaEmitida;
  /**
   * 🪤 `factura_pendiente` también entra, y no es por comodidad: si el remito se anula DESPUÉS de
   * que alguien dijo "el remito está bien", el pedido queda en ese estado con un remito muerto —
   * la emisión lo frena, pero sin esto no habría forma de destrabarlo desde la app.
   */
  if (fila.estado_emision !== 'anulado' && fila.estado_emision !== 'factura_pendiente') {
    return {
      ok: false, status: 409,
      error: 'Ese pedido no está marcado como "factura anulada". Actualizá la pantalla: puede que ya lo haya resuelto alguien.',
    };
  }
  if (!fila.im_remito_id) {
    return { ok: false, status: 409, error: 'Ese pedido no tiene un remito registrado, así que no hay nada que conciliar.' };
  }
  return { ok: true, fila };
}

/**
 * 🔴 QUE LA FACTURA ESTÉ REALMENTE MUERTA, LEÍDO DE INFOMANAGER AHORA.
 *
 * 🪤 `estado_emision: 'anulado'` es lo que vio la app la última vez que sincronizó, y las dos
 * operaciones de este archivo son irreversibles. Si mientras tanto alguien la revivió —o la
 * lectura de entonces fue un falso positivo— tocar el remito rompería una emisión sana.
 *
 * 🪤 `existe: null` / `anulada: null` es "no pude preguntar" y frena igual: no es lo mismo que
 * "está muerta" (ver `cabeceraComprobante`).
 */
async function facturaMuerta(idFactura: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!idFactura) return { ok: true };   // nunca se registró una: no hay nada que verificar.
  const cab = await cabeceraComprobante(idFactura);
  if (cab.existe === false) return { ok: true };
  if (cab.anulada === true) return { ok: true };
  if (cab.existe !== true || cab.anulada !== false) {
    return { ok: false, error: 'No pude verificar en InfoManager si la factura sigue vigente. Probá de nuevo en un rato: no se tocó nada.' };
  }
  return {
    ok: false,
    error: `La factura ${cab.numero ?? ''} está VIGENTE en InfoManager. No se toca el remito de una factura viva.`,
  };
}

/** Dónde está el remito dentro de una hoja de ruta, si está en alguna. */
async function hojaDelRemito(remitoId: string) {
  const { data, error } = await sb().from('hojas_ruta_pedidos')
    .select('hoja_id, im_comprobante_id, hojas_ruta!inner(numero, estado, version, tenant_id)')
    .eq('hojas_ruta.tenant_id', TENANT_ID).eq('im_remito_id', remitoId).maybeSingle();
  if (error) throw new Error(`No pude verificar si el remito está en una hoja de ruta: ${error.message}`);
  return data as any;
}

/**
 * POST /api/facturacion/remito-sobrante/:comprobanteId — EL REMITO NO CORRESPONDE.
 *
 * 🔴 EMITE UNA ANULACIÓN REAL EN INFOMANAGER Y DEVUELVE STOCK. Lo aprieta una persona que ya
 * miró el remito: el que pasó por acá el 22/09/2026 devolvió exactamente las 9 cantidades que
 * había descontado.
 *
 * El orden NO es casual. Primero se verifica que la hoja de ruta se pueda tocar —después de
 * anular ya no hay vuelta atrás—, después se anula en IM, y recién al final se limpia acá. Al
 * revés, un fallo a mitad de camino dejaría un remito VIVO fuera de la hoja, que es invisible;
 * así, el peor caso deja un remito anulado que se sigue viendo, que es evidente y se arregla.
 */
export async function descartarRemitoSobrante(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  const id = String(req.params.comprobanteId ?? '').trim();
  if (!/^\d+$/.test(id)) { res.status(400).json({ error: 'Falta el pedido.' }); return; }

  try {
    const base = await filaParaConciliar(id);
    if (!base.ok) { res.status(base.status).json({ error: base.error }); return; }
    const fila = base.fila;

    const viva = await facturaMuerta(fila.im_factura_id);
    if (!viva.ok) { res.status(409).json({ error: viva.error }); return; }

    // El remito, leído ahora. Si ya está anulado no se vuelve a anular: sólo se limpia acá.
    const cabRe = await cabeceraComprobante(fila.im_remito_id!);
    if (cabRe.existe !== false && cabRe.anulada !== true
        && (cabRe.existe !== true || cabRe.anulada !== false)) {
      res.status(502).json({ error: 'No pude verificar en InfoManager si el remito sigue vigente. Probá de nuevo en un rato: no se tocó nada.' });
      return;
    }
    const seguiaVivo = cabRe.existe === true && cabRe.anulada === false;

    // 🔴 ANTES de anular: una hoja cerrada ya se liquidó y sacarle un remito descuadra el cierre.
    const enHoja = await hojaDelRemito(fila.im_remito_id!);
    if (enHoja && String(enHoja.hojas_ruta?.estado ?? '') === 'cerrada') {
      res.status(409).json({
        error: `El remito ${fila.im_remito_numero ?? ''} está en la hoja ${enHoja.hojas_ruta?.numero ?? ''}, que ya está CERRADA y liquidada. Reabrila antes de descartarlo.`,
      });
      return;
    }

    if (seguiaVivo) {
      const anulado = await anularComprobante({
        id: fila.im_remito_id!,
        numero: Number(cabRe.numero) || Number(fila.im_remito_numero) || 0,
        punto_de_venta: Number(cabRe.punto_de_venta) || 0,
        fecha: cabRe.fecha ?? fechaArgentina(),
        tipo_comprobante: 'RE',
        observaciones: `ANULADO: no corresponde. La factura ${fila.im_factura_numero ?? ''} de este pedido se anulo en InfoManager.`.slice(0, 500),
      });
      if (!anulado.ok) {
        console.error(`[descartarRemitoSobrante] RE ${fila.im_remito_numero}: ${anulado.error}`);
        res.status(502).json({ error: `InfoManager no anuló el remito ${fila.im_remito_numero ?? ''}: ${anulado.error}. No se tocó nada más.` });
        return;
      }
      // Que haya quedado anulado lo dice IM, no la respuesta del PUT (regla de oro de esta API).
      const post = await cabeceraComprobante(fila.im_remito_id!);
      if (post.existe === true && post.anulada === false) {
        res.status(502).json({ error: `InfoManager aceptó la anulación del remito ${fila.im_remito_numero ?? ''} pero sigue figurando vigente. Verificalo en InfoManager.` });
        return;
      }
    }

    // Sale de la hoja de ruta. Va por la misma RPC que el botón de la pantalla de reparto, así
    // la versión de la hoja avanza y el cambio queda atado a quien lo pidió.
    if (enHoja) {
      await mutarReparto(req.user?.sub, 'quitar', {
        hoja_id: enHoja.hoja_id,
        im_comprobante_id: String(enHoja.im_comprobante_id),
        version_esperada: enHoja.hojas_ruta?.version,
      });
    }

    /**
     * El pedido vuelve a estar LIBRE: se borra la fila, que es como se representa "sin reclamo"
     * en todo el resto del circuito (ver `soltarReclamo` y `liberarReclamo`).
     *
     * 🔑 El rastro de lo que pasó no se pierde: queda escrito en los propios comprobantes de
     * InfoManager, anulados y con el motivo en las observaciones. Es donde la oficina lo mira —
     * fue justamente así como se reconstruyó el caso de BUSTOS cuatro días después.
     */
    const { error: errBorrar } = await sb().from('presupuestos_facturados')
      .delete().eq('tenant_id', TENANT_ID).eq('im_comprobante_id', id)
      .in('estado_emision', ['anulado', 'factura_pendiente']);
    if (errBorrar) {
      res.status(500).json({ error: `Anulé el remito ${fila.im_remito_numero ?? ''} en InfoManager pero no pude liberar el pedido acá: ${errBorrar.message}` });
      return;
    }

    invalidarIM(); invalidarVista(); invalidarRemitos();
    res.json({
      ok: true, comprobante: id,
      remito: fila.im_remito_numero ?? null,
      ya_estaba_anulado: !seguiaVivo,
      hoja: enHoja?.hojas_ruta?.numero ?? null,
    });
  } catch (err: any) {
    console.error('[descartarRemitoSobrante]', err?.message);
    res.status(err?.status ?? 502).json({ error: err?.message ?? 'No se pudo descartar el remito.' });
  }
}

/**
 * POST /api/facturacion/factura-pendiente/:comprobanteId — EL REMITO ESTÁ BIEN, FALTA LA FACTURA.
 *
 * NO emite nada: deja el pedido en `factura_pendiente`, y ahí Facturar hace SÓLO la factura y le
 * engancha el remito que ya existe (facturarPresupuestos.ts, paso 2·bis). Es el espejo exacto de
 * `habilitarRemitoPendiente`, y por el mismo motivo no emite acá: lo que se emite, se emite desde
 * un solo lugar, con su reclamo y sus controles.
 *
 * 🪤 El número de la factura muerta no se tira: se guarda en `historial_facturas`. Sin eso, la
 * hoja de ruta impresa con la factura vieja queda sin explicación posible.
 */
export async function habilitarFacturaPendiente(req: Request & { user?: JwtPayload }, res: Response) {
  if (frenaSiNoPuede(req, res)) return;
  const id = String(req.params.comprobanteId ?? '').trim();
  if (!/^\d+$/.test(id)) { res.status(400).json({ error: 'Falta el pedido.' }); return; }

  try {
    const base = await filaParaConciliar(id);
    if (!base.ok) { res.status(base.status).json({ error: base.error }); return; }
    const fila = base.fila;

    const muerta = await facturaMuerta(fila.im_factura_id);
    if (!muerta.ok) { res.status(409).json({ error: muerta.error }); return; }

    /**
     * 🔴 Y EL REMITO TIENE QUE ESTAR VIVO. Habilitar este camino sobre un remito anulado emitiría
     * una factura sin mercadería que la respalde, y encima dejaría el pedido cerrado como si
     * estuviera completo.
     */
    const cabRe = await cabeceraComprobante(fila.im_remito_id!);
    if (cabRe.existe === false || cabRe.anulada === true) {
      res.status(409).json({
        error: `El remito ${fila.im_remito_numero ?? ''} ya no está vigente en InfoManager. Si la mercadería tiene que salir de nuevo, usá "El remito no corresponde" y facturá el pedido entero.`,
      });
      return;
    }
    if (cabRe.existe !== true || cabRe.anulada !== false) {
      res.status(502).json({ error: 'No pude verificar en InfoManager si el remito sigue vigente. Probá de nuevo en un rato: no se cambió nada.' });
      return;
    }
    if (Number(cabRe.cod_cliente) !== Number(fila.cod_cliente)) {
      res.status(409).json({
        error: `El remito ${fila.im_remito_numero ?? ''} es del cliente ${cabRe.cod_cliente} y el pedido es del ${fila.cod_cliente}. No se le puede emitir esta factura.`,
      });
      return;
    }

    const historial = [
      ...(Array.isArray(fila.historial_facturas) ? fila.historial_facturas : []),
      { id: fila.im_factura_id, numero: fila.im_factura_numero, tipo: fila.im_factura_tipo, motivo: 'anulada en IM' },
    ];
    const { data, error } = await sb().from('presupuestos_facturados').update({
      im_factura_id: null, im_factura_numero: null, im_factura_tipo: null,
      facturado_at: null, claim_token: null,
      estado_emision: 'factura_pendiente', historial_facturas: historial,
    }).eq('tenant_id', TENANT_ID).eq('im_comprobante_id', id)
      // 🪤 Condicionado al estado que se leyó: si alguien lo resolvió mientras tanto, no se pisa.
      .eq('estado_emision', 'anulado').not('im_remito_id', 'is', null)
      .select('im_comprobante_id, im_remito_numero');
    // 🪤 Sin la migración la columna del historial no existe, y el error de Postgres no le dice
    // nada a nadie. El pedido queda como estaba.
    if (error && ['PGRST204', '42703'].includes(String((error as any).code))) {
      res.status(503).json({ error: 'Falta aplicar la migración 051 para rehacer una factura sobre un remito vivo. No se cambió nada.' });
      return;
    }
    if (error) { res.status(500).json({ error: error.message }); return; }
    if (!(data ?? []).length) {
      res.status(409).json({ error: 'Alguien lo resolvió mientras tanto. Actualizá la pantalla.' });
      return;
    }

    invalidarVista(); invalidarRemitos();
    res.json({ ok: true, comprobante: id, remito: fila.im_remito_numero ?? null, factura_anulada: fila.im_factura_numero ?? null });
  } catch (err: any) {
    console.error('[habilitarFacturaPendiente]', err?.message);
    res.status(502).json({ error: err?.message ?? 'No se pudo habilitar la factura.' });
  }
}
