import { cabeceraComprobante, fetchVentas, type VentaRaw } from './infomanager.js';
import { importesPuntuales as puntuales } from './cacheImportesFacturas.js';
export { invalidarImportesFacturas } from './cacheImportesFacturas.js';
type Opciones = { ventas?: VentaRaw[]; desde?: string; hasta?: string; actualizar?: boolean };
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
      const ventas = await fetchVentas(desde, hasta, { actualizar: opciones.actualizar });
      for (const v of ventas) porId.set(String(v.id), v);
    }
  }
  const faltantes = [...new Set(candidatas.map(f => String(f.im_factura_id)).filter(id => !porId.has(id)))];
  for (let i = 0; i < faltantes.length; i += 4) {
    await Promise.all(faltantes.slice(i, i + 4).map(async id => {
      if (!/^\d+$/.test(id)) throw new Error('La factura vinculada no tiene un identificador válido. Revisá su asociación.');
      const c = await puntuales.obtener(id, async () => {
        const cab = await cabeceraComprobante(id);
        if (cab.existe !== true || cab.anulada !== false || cab.total == null) throw new Error(`No pude verificar el importe actual de la factura ${id} en InfoManager. Actualizá antes de continuar.`);
        return { ...cab, id, anulada: 'N' };
      }, { actualizar: opciones.actualizar });
      porId.set(id, c);
    }));
  }
  return filas.map(f => {
    if (!candidatasSet.has(f)) return f;
    const v = porId.get(String(f.im_factura_id));
    const valido = v && String(v.tipo_comprobante).trim() === 'FA' && String(v.anulada).trim().toUpperCase() === 'N'
      && Number(v.cod_cliente) === Number(f.cod_cliente) && f.cod_empresa != null && Number(v.cod_empresa) === Number(f.cod_empresa)
      && v.total != null && String(v.total).trim() !== '' && Number.isFinite(Number(v.total)) && Number(v.total) >= 0;
    if (!valido) throw new Error(`No pude verificar la factura ${f.im_factura_numero ?? f.im_factura_id} y su importe en InfoManager. Revisá su vigencia y asociación antes de continuar.`);
    return { ...f, total_snapshot: f.total_snapshot ?? f.total, total: Number(v.total), importe_fuente: 'factura_im' };
  });
}
