import { evaluarPedido, type ArticuloInfo, type ReglaDescuento, type ReglaLista } from './listas.js';

/**
 * LOS AVISOS DE LISTA, CONTANDO LAS CANTIDADES POR CLIENTE Y NO POR PRESUPUESTO.
 *
 * Mati (21/09/2026): *"un cliente en particular que tiene dos o tres presupuestos... las listas
 * de precio van por presupuesto, las cantidades. Pero si un cliente tiene tres presupuestos, las
 * cantidades para acceder a esas listas de precio hay que considerar las tres, porque es el mismo
 * cliente. Esto pasa porque por ahí tienen varias sucursales"*.
 *
 * 🔑 QUÉ SE SUMA: los pedidos del MISMO cliente con la MISMA fecha de entrega, o sea los que se
 * despachan juntos. Es la agrupación que la pantalla ya usaba para avisar de pedidos duplicados
 * (`vivosPorClienteDia`), así que no se inventa un criterio nuevo — y las sucursales de un mismo
 * cliente comparten código en InfoManager (confirmado por Mati ese día), así que agrupar por
 * `cod_cliente` alcanza.
 *
 * Medido el 21/09/2026 sobre 10 días: 47 de 296 presupuestos vivos (16%) son de clientes que
 * pidieron más de una vez el mismo día, en 22 grupos; el más grande, $3,1 millones en tres
 * pedidos. Evaluados sueltos, a cada uno le corresponde una lista peor que la que le toca.
 */
export interface PresupuestoParaListas {
  id: string | number;
  cod_cliente: number | string | null;
  fecha: string | null;
}
export interface RenglonParaListas {
  cod_articulo: number;
  cantidad: number | string;
  cod_lista_precios?: number | null;
  descuento_porc?: number | null;
}
export interface Gravedad { pierde_margen: number; cobra_de_mas: number }

/** La clave del grupo: mismo cliente, misma fecha de entrega. */
export const claveDeGrupo = (p: PresupuestoParaListas) =>
  `${Number(p.cod_cliente)}|${String(p.fecha ?? '').slice(0, 10)}`;

export function avisosDeListaPorPedido(
  presupuestos: PresupuestoParaListas[],
  renglones: Map<string, RenglonParaListas[]>,
  catalogo: Map<number, ArticuloInfo>,
  reglas: ReglaLista[],
  descuentos: ReglaDescuento[],
): { avisos: Map<string, string[]>; gravedad: Map<string, Gravedad> } {
  const avisos = new Map<string, string[]>();
  const gravedad = new Map<string, Gravedad>();

  const grupos = new Map<string, PresupuestoParaListas[]>();
  for (const p of presupuestos) {
    const k = claveDeGrupo(p);
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k)!.push(p);
  }

  for (const grupo of grupos.values()) {
    // Un pedido sin renglones no aporta nada y no puede recibir avisos.
    const conRenglones = grupo
      .map(p => ({ id: String(p.id), rs: renglones.get(String(p.id)) ?? [] }))
      .filter(x => x.rs.length);
    if (!conRenglones.length) continue;

    /**
     * 🪤 `evaluarPedido` devuelve un aviso por renglón identificado por `idx`, así que hay que
     * saber de quién es cada índice: sin esto los avisos de los tres pedidos caerían todos en el
     * primero del grupo.
     */
    const duenio: string[] = [];
    const propios: RenglonParaListas[] = [];
    const items = [];
    for (const { id, rs } of conRenglones) {
      for (const x of rs) {
        duenio.push(id);
        propios.push(x);
        items.push({
          cod_articulo: x.cod_articulo, cantidad: Number(x.cantidad),
          cod_lista: x.cod_lista_precios, descuento: x.descuento_porc,
        });
      }
    }

    const r = evaluarPedido(items as any, catalogo, reglas, descuentos);
    const textos = new Map<string, string[]>();
    for (const a of r.avisos) {
      const id = duenio[a.idx];
      if (!id) continue;
      const g = gravedad.get(id) ?? { pierde_margen: 0, cobra_de_mas: 0 };
      /**
       * 🪤 "Tiene derecho a L2 y está en L1" es un FALSO POSITIVO cuando el renglón lleva
       * descuento: un descuento y una lista mejor son dos caminos al mismo precio y el vendedor
       * elige cuál usar (Mati, 27/08/2026 — L1 con 25% da exactamente L2). Se silencia hacia el
       * lado seguro: acusar de más a quien hizo bien las cosas hace que después nadie mire
       * ningún cartel.
       */
      const conDescuento = Number(propios[a.idx]?.descuento_porc ?? 0) > 0;
      if (a.severidad === 'margen') g.pierde_margen += 1;
      else if (a.severidad === 'cliente' && !conDescuento) g.cobra_de_mas += 1;
      if (g.pierde_margen || g.cobra_de_mas) gravedad.set(id, g);

      const mios = textos.get(id) ?? [];
      // Las oportunidades de mejor precio son comentarios para el vendedor, no tareas de
      // revisión para oficina. El descuento se controla de todos modos.
      if (a.severidad === 'margen' && a.mensaje) mios.push(a.mensaje);
      // El descuento fuera de tope es otro problema, y ese no depende de la lista.
      if ((a as any).mensaje_descuento) mios.push((a as any).mensaje_descuento);
      if (mios.length) textos.set(id, mios);
    }

    /**
     * 🔑 DE DÓNDE SALE LA CUENTA. Con el pedido a la vista mostrando 4 bolsas y un cartel que
     * habla de la lista de 10, el número no cierra y el cartel pierde toda credibilidad. Se
     * aclara sólo cuando hay más de un pedido: en el caso normal sería ruido.
     */
    if (conRenglones.length > 1) {
      for (const [id, mios] of textos) {
        textos.set(id, [`Las cantidades se contaron sobre los ${conRenglones.length} pedidos de este cliente para esa fecha.`, ...mios]);
      }
    }
    for (const [id, mios] of textos) avisos.set(id, mios);
  }

  return { avisos, gravedad };
}
