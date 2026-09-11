import { fetchArticulosCatalogo, getPrecioLista } from './infomanager.js';
import { ivaExplicita } from './identidadIM.js';

export class ErrorFiscal extends Error { status = 409; }
export function ivaDeOriginal(r: any): number | null {
  return ivaExplicita(Object.hasOwn(r, 'iva_verificada') ? r.iva_verificada : r.iva_por);
}
/** Conserva alícuota del original; consultas puntuales sólo para códigos nuevos. */
export async function conIVAConfiable<T extends { cod_articulo: number; cod_lista_precios?: number | null; iva_por?: number | null }>(
  finales: T[], originales: any[], comprobarBody = false,
): Promise<Array<T & { iva_por: number }>> {
  const porCodigo = new Map<number, number>();
  for (const r of originales) {
    const cod = Number(r.cod_articulo); if (!(cod > 0)) continue;
    const iva = ivaDeOriginal(r);
    if (iva == null) throw new ErrorFiscal(`No pude verificar el IVA original del artículo ${cod}. No se emitió nada.`);
    if (porCodigo.has(cod) && porCodigo.get(cod) !== iva) throw new ErrorFiscal(`El artículo ${cod} tiene alícuotas distintas en el original. Requiere revisión en InfoManager.`);
    porCodigo.set(cod, iva);
  }
  const nuevos = finales.filter(r => !porCodigo.has(r.cod_articulo));
  const catalogo = nuevos.length ? await fetchArticulosCatalogo() : null;
  const pendientes = new Map<string, typeof nuevos[number]>();
  for (const r of nuevos) {
    const iva = ivaExplicita(catalogo?.get(r.cod_articulo)?.iva_por);
    if (iva != null) porCodigo.set(r.cod_articulo, iva);
    else pendientes.set(`${r.cod_articulo}|${r.cod_lista_precios ?? 0}`, r);
  }
  // Pool acotado. getPrecioLista ya deduplica y cachea por código/lista.
  const tareas = [...pendientes.values()];
  let siguiente = 0;
  await Promise.all(Array.from({ length: Math.min(2, tareas.length) }, async () => {
    while (siguiente < tareas.length) {
      const r = tareas[siguiente++];
      const p = r.cod_lista_precios ? await getPrecioLista(r.cod_articulo, r.cod_lista_precios) : null;
      const iva = p && Number(p.cod_articulo) === r.cod_articulo ? ivaExplicita(p.iva_verificada) : null;
      if (iva == null) throw new ErrorFiscal(`No pude verificar el IVA del artículo nuevo ${r.cod_articulo}. Revisá su ficha/lista en InfoManager.`);
      if (porCodigo.has(r.cod_articulo) && porCodigo.get(r.cod_articulo) !== iva) throw new ErrorFiscal(`IVA discordante para el artículo ${r.cod_articulo}.`);
      porCodigo.set(r.cod_articulo, iva);
    }
  }));
  return finales.map(r => {
    const iva = porCodigo.get(r.cod_articulo);
    if (iva == null) throw new ErrorFiscal(`Falta IVA verificado del artículo ${r.cod_articulo}.`);
    if (comprobarBody && r.iva_por != null && r.iva_por !== iva) throw new ErrorFiscal(`El IVA del artículo ${r.cod_articulo} no coincide con el original/catálogo. Actualizá la factura.`);
    return { ...r, iva_por: iva };
  });
}
export function identidadFiscal(cab: any) {
  return { empresa: Number(cab.cod_empresa), cliente: Number(cab.cod_cliente), vendedor: Number(cab.cod_vendedor),
    tipo: String(cab.tipo_comprobante ?? '').trim(), letra: String(cab.tipo_factura ?? '').trim(),
    numero: cab.numero ?? null, punto: cab.punto_de_venta ?? null };
}
export function exigirIdentidadFiscal(cab: any, origen: unknown) {
  if (!origen || JSON.stringify(identidadFiscal(cab)) !== JSON.stringify(origen)) {
    // JSONB puede reordenar claves.
    const actual = identidadFiscal(cab);
    if (!origen || Object.entries(actual).some(([k, v]) => (origen as any)[k] !== v)) {
      throw new ErrorFiscal('La identidad fiscal de la factura cambió o la operación anterior no permite verificarla. Conciliá antes de retomar.');
    }
  }
}
