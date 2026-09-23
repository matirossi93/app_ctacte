import { cabeceraComprobante, fetchVentas, type CabeceraComprobante, type VentaRaw } from './infomanager.js';
import { importesPuntuales as puntuales } from './cacheImportesFacturas.js';
export { invalidarImportesFacturas } from './cacheImportesFacturas.js';
type Opciones = {
  ventas?: VentaRaw[]; desde?: string; hasta?: string; actualizar?: boolean; tolerarErrores?: boolean;
  /** Lector compartido por petición: sin esto, una FA fuera del rango se pide dos veces. */
  leerCabecera?: (id: string) => Promise<CabeceraComprobante>;
};
const dia = (v: unknown) => /^\d{4}-\d{2}-\d{2}/.test(String(v ?? '')) ? String(v).slice(0, 10) : null;

/** El total de la FA vigente manda sobre PR, remito y snapshots. Nunca escribe en IM ni
 * modifica el respaldo original. Reutiliza la consulta de rango; sólo los IDs ausentes
 * necesitan una lectura puntual compartida. No publica importes antiguos como actuales.
 */
export async function actualizarImportesFacturas<T extends Record<string, any>>(filas: T[], opciones: Opciones = {}): Promise<T[]> {
  const candidatas = filas.filter(f => f.im_factura_id && !['anulado', 'incierto'].includes(f.estado_emision));
  if (!candidatas.length) return filas;
  const candidatasSet = new Set(candidatas);
  const porId = new Map<string, any>();
  const errores = new Map<string, string>();
  if (opciones.ventas) {
    for (const v of opciones.ventas) porId.set(String(v.id), v);
  } else {
    const fechas = [...new Set(candidatas.map(f => dia(f.fecha_factura ?? f.fecha ?? f.facturado_at)).filter((f): f is string => !!f))].sort();
    const rangos: Array<[string, string]> = [];
    if (opciones.desde && opciones.hasta) rangos.push([opciones.desde, opciones.hasta]);
    else for (const fecha of fechas) {
      const ultimo = rangos.at(-1);
      if (ultimo && Date.parse(fecha) - Date.parse(ultimo[0]) <= 31 * 864e5) ultimo[1] = fecha;
      else rangos.push([fecha, fecha]);
    }
    for (const [desde, hasta] of rangos) {
      try {
        const ventas = await fetchVentas(desde, hasta, { actualizar: opciones.actualizar });
        for (const v of ventas) porId.set(String(v.id), v);
      } catch (e) {
        if (!opciones.tolerarErrores) throw e;
        for (const f of candidatas) {
          const fecha = dia(f.fecha_factura ?? f.fecha ?? f.facturado_at);
          if (!fecha || (fecha >= desde && fecha <= hasta)) errores.set(String(f.im_factura_id), 'No se pudo consultar el importe en InfoManager. Actualizá para verificarlo.');
        }
      }
    }
  }
  const faltantes = [...new Set(candidatas.map(f => String(f.im_factura_id)).filter(id => !porId.has(id) && !errores.has(id)))];
  for (let i = 0; i < faltantes.length; i += 4) {
    await Promise.all(faltantes.slice(i, i + 4).map(async id => {
      try {
      if (!/^\d+$/.test(id)) throw new Error('La factura vinculada no tiene un identificador válido. Revisá su asociación.');
      /**
       * 🪤 Con un lector de petición NO se pasa por el cache global.
       *
       * `puntuales.obtener` devuelve el total cacheado SIN invocar el lector: la vigencia
       * quedaría leída de la cabecera nueva y el importe de una vieja, que es justo lo contrario
       * de compartir una sola lectura. Las rutas que no inyectan lector conservan su cache.
       */
      /**
       * 🔴 EL AVISO TIENE QUE DECIR QUÉ PASÓ. Hasta el 22/09/2026 las tres situaciones daban
       * el mismo texto —"no pude verificar el importe, actualizá"— y Mati mandó la captura de una
       * hoja con ese cartel sobre la factura 58879767: estaba ANULADA y borrada de InfoManager,
       * con su remito todavía vivo en la hoja. Actualizar no iba a cambiar nada, y el mensaje
       * mandaba justo a eso.
       */
      const normalizar = (cab: any) => {
        if (cab.existe === false) throw new Error(`La factura ${id} ya no está en InfoManager: se anuló y se borró. El remito sigue en la hoja, así que hay que decidir qué hacer con ese pedido.`);
        if (cab.anulada === true) throw new Error(`La factura ${id} está ANULADA en InfoManager. El remito sigue en la hoja, así que hay que decidir qué hacer con ese pedido.`);
        if (cab.existe !== true || cab.anulada !== false || cab.total == null) throw new Error(`No pude leer la factura ${id} en InfoManager (no contestó o vino incompleta). Actualizá antes de continuar.`);
        return { ...cab, id, anulada: 'N' };
      };
      const c = opciones.leerCabecera
        ? normalizar(await opciones.leerCabecera(id))
        : await puntuales.obtener(id, async () => normalizar(await cabeceraComprobante(id)), { actualizar: opciones.actualizar });
      porId.set(id, c);
      } catch (e) {
        if (!opciones.tolerarErrores) throw e;
        errores.set(id, e instanceof Error ? e.message : 'No se pudo consultar la factura en InfoManager.');
      }
    }));
  }
  return filas.map(f => {
    if (!candidatasSet.has(f)) return f;
    const v = porId.get(String(f.im_factura_id));
    // Entregas legacy no guardaban empresa. La FA identificada debe confirmar que
    // pertenece al mismo cliente y a Casa Central antes de completar ese dato.
    const empresa = f.cod_empresa ?? Number(process.env.PEDIDO_EMPRESA_DEFAULT || 1);
    const valido = v && String(v.tipo_comprobante).trim() === 'FA' && String(v.anulada).trim().toUpperCase() === 'N'
      && Number(f.cod_cliente) > 0 && Number(v.cod_cliente) === Number(f.cod_cliente) && Number(v.cod_empresa) === Number(empresa)
      && v.total != null && String(v.total).trim() !== '' && Number.isFinite(Number(v.total)) && Number(v.total) >= 0;
    if (!valido) {
      const mensaje = errores.get(String(f.im_factura_id)) ?? `No pude verificar la factura ${f.im_factura_numero ?? f.im_factura_id} y su importe en InfoManager. Revisá su vigencia y asociación antes de continuar.`;
      if (!opciones.tolerarErrores) throw new Error(mensaje);
      return { ...f, total_snapshot: f.total_snapshot ?? f.total, total: null, importe_fuente: 'no_verificado', importe_error: mensaje };
    }
    /**
     * 🔴 LA FACTURA CAMBIÓ DE TALONARIO. 22/09/2026: dos de 389 facturas emitidas por la app
     * aparecieron en InfoManager con otro número y otro punto de venta —reasignadas al talonario
     * del controlador fiscal (el 15) al imprimirlas—. Se descubrió porque Mati notó una impresión
     * rara, dos semanas después de la primera.
     *
     * 🪤 Va por un campo PROPIO y no por `importe_error`: la factura existe y su total es
     * bueno, así que invalidarla bloquearía armar la hoja por algo que no impide despacharla. Es
     * un aviso para que alguien mire, no un freno.
     */
    const numeroIM = Number(v.numero);
    const pvIM = Number(v.punto_de_venta);
    const registrado = Number(f.im_factura_numero);
    const cambio = Number.isFinite(registrado) && registrado > 0 && Number.isFinite(numeroIM) && numeroIM !== registrado;
    const aviso = cambio
      ? { aviso_comprobante: `Esta factura salió como ${registrado} y en InfoManager figura como ${numeroIM}${Number.isFinite(pvIM) ? ` (punto de venta ${pvIM})` : ''}: la movieron de talonario. Verificala antes de seguir.` }
      : {};
    /**
     * 🔑 LA FECHA DE LA FACTURA, como la tiene InfoManager. Mati (23/09/2026): *"en la parte de
     * facturas emitidas, que aparezca la fecha de la factura también como dato"*.
     *
     * 🪤 No es la del pedido ni `facturado_at`: la oficina elige con qué fecha se emite (hasta 7
     * días adelante) y después la puede mover con el botón Fecha. La única que vale es la que dice
     * la factura — y acá ya se la tenía en la mano, del listado o de su cabecera, sin pedir nada
     * más a InfoManager.
     */
    const fechaIM = typeof v.fecha === 'string' && v.fecha.length >= 10 ? v.fecha.slice(0, 10) : null;
    return { ...f, ...aviso, cod_empresa: Number(v.cod_empresa), empresa_fuente: f.cod_empresa == null ? 'factura_im' : f.empresa_fuente,
      total_snapshot: f.total_snapshot ?? f.total, total: Number(v.total), importe_fuente: 'factura_im', importe_error: null,
      fecha_factura: fechaIM };
  });
}
