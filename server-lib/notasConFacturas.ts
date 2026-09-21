import { getV2, imV2Configurada } from './imApiV2.js';

/**
 * QUÉ FACTURA ACREDITA CADA NOTA DE CRÉDITO, dicho por InfoManager.
 *
 * Hasta hoy ese vínculo era NUESTRO: al emitir, la app escribe "SEGUN FACTURA 50401" en las
 * observaciones y guarda la relación de su lado (`hojas_ruta_ajustes`, el journal de
 * correcciones). Eso deja afuera todas las notas que la oficina hace a mano en InfoManager —la
 * mayoría— y obliga a que alguien elija a ojo cuál corresponde a cuál.
 *
 * `GET /api/v2/ventas/notas-credito-con-facturas` lo devuelve nativo. Verificado en vivo el
 * 21/09/2026: NC 30026 → factura B 777-50095, y NC 30028 → factura B 777-49836, que es **de otro
 * mes que la nota**: justo el caso en el que elegir a ojo se equivoca.
 */
export interface FacturaDeNota {
  im_id: string;
  numero: number | null;
  punto_de_venta: number | null;
  tipo: string | null;
  fecha: string | null;
  total: number | null;
  vigente: boolean;
}
export interface NotaConFacturas {
  im_id: string;
  numero: number | null;
  punto_de_venta: number | null;
  tipo: string | null;
  fecha: string | null;
  cod_cliente: number | null;
  cliente: string | null;
  total: number | null;
  /** 🔑 `anulada = 'S'` NO se descarta acá: ver el 🔴 de abajo. */
  vigente: boolean;
  facturas: FacturaDeNota[];
}

/** Dos decimales: son importes que después se comparan contra los nuestros. */
const dos = (n: unknown) => {
  const x = Number(n);
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : null;
};
const entero = (n: unknown) => {
  const x = Number(n);
  return Number.isFinite(x) ? Math.trunc(x) : null;
};
const texto = (s: unknown) => {
  const t = String(s ?? '').trim();
  return t || null;
};
/** Vigente salvo que diga explícitamente que está anulada. */
const esVigente = (v: unknown) => String(v ?? '').trim().toUpperCase() !== 'S';

const comoFactura = (f: any): FacturaDeNota => ({
  im_id: String(f?.id ?? ''),
  numero: entero(f?.numero),
  punto_de_venta: entero(f?.punto_de_venta),
  tipo: texto(f?.tipo_factura),
  fecha: texto(f?.fecha)?.slice(0, 10) ?? null,
  total: dos(f?.total),
  vigente: esVigente(f?.anulada),
});

const comoNota = (n: any): NotaConFacturas => ({
  im_id: String(n?.id ?? ''),
  numero: entero(n?.numero),
  punto_de_venta: entero(n?.punto_de_venta),
  tipo: texto(n?.tipo_factura),
  fecha: texto(n?.fecha)?.slice(0, 10) ?? null,
  cod_cliente: entero(n?.cod_cliente),
  cliente: texto(n?.cliente),
  total: dos(n?.total),
  vigente: esVigente(n?.anulada),
  facturas: Array.isArray(n?.facturas) ? n.facturas.map(comoFactura) : [],
});

/** Notas por página. El endpoint pagina la NOTA, no sus facturas. */
const POR_PAGINA = 200;
/** 🪤 Tope duro: si el servidor repitiera `nextPage`, un while ingenuo cuelga la pantalla. */
const TOPE_PAGINAS = 25;

/**
 * Las notas de crédito del rango, con las facturas que acreditan.
 *
 * 🔴 Las anuladas viajan MARCADAS, no se descartan: si se filtraran acá, "no aparece" pasaría a
 * significar dos cosas distintas —no existe, o existe y está anulada— y el que concilia necesita
 * poder distinguirlas.
 *
 * Sin credenciales v2 devuelve vacío en vez de tirar: lo que dependa de esto se apaga solo y la
 * pantalla que lo llame sigue funcionando como antes.
 */
export async function fetchNotasConFacturas(desde: string, hasta: string): Promise<NotaConFacturas[]> {
  if (!imV2Configurada()) return [];
  const out: NotaConFacturas[] = [];
  let page = 1;
  for (let vuelta = 0; vuelta < TOPE_PAGINAS; vuelta++) {
    const d: any = await getV2('/api/v2/ventas/notas-credito-con-facturas', {
      fechaDesde: desde, fechaHasta: hasta, page, limit: POR_PAGINA,
    });
    const filas: any[] = Array.isArray(d) ? d : (d?.results ?? d?.data ?? d?.items ?? []);
    for (const f of filas) out.push(comoNota(f));
    if (!filas.length) break;
    /**
     * 🪤 Manda `nextPage`, NO la cantidad de filas. Cortar porque "vinieron menos de las
     * pedidas" da por terminada una página parcial y se pierden notas en silencio, que es
     * exactamente lo que no puede pasar acá.
     *
     * Y si la página vino LLENA pero el servidor no informó la siguiente, se sigue igual: quedarse
     * corto es peor que una consulta de más, y el tope de vueltas acota el costo.
     */
    const siguiente = entero(d?.nextPage);
    if (siguiente != null && siguiente > page) { page = siguiente; continue; }
    if (siguiente == null && filas.length >= POR_PAGINA) { page += 1; continue; }
    break;
  }
  return out;
}
