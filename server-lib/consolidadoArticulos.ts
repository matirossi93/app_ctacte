/**
 * CUÁNTO SE PIDIÓ DE CADA ARTÍCULO, CONTRA LO QUE HAY.
 *
 * Mati (08/09/2026): *"a Jorgelina le pueda salir el total de artículos que hay en esos
 * presupuestos, el producto y la suma de todas las cantidades pedidas versus lo que dice el
 * sistema... para que antes de facturar pueda ver con qué cantidad cuenta de cada artículo y si
 * hay algo que le falta, o si está más pedido de lo que hay, pueda avisar o **redistribuir esas
 * cantidades entre los clientes que hicieron el pedido**"*.
 *
 * 🔴 Y el 08/09 más tarde, corrigiendo lo que había: *"eso se está midiendo factura a factura,
 * esa no era la idea"*. El control por presupuesto ya existía (la columna de stock del detalle) y
 * **no sirve para decidir a quién darle**: si hay 300 kg y tres clientes piden 200 cada uno, mirando
 * de a uno los tres parecen servibles. La pregunta sólo se contesta sumando todo primero.
 *
 * 🔑 Se suman los pedidos **pendientes**, no todos. Los que ya están en una hoja o en retiro
 * salieron con su remito y **ya descontaron stock en InfoManager**: contarlos otra vez restaría
 * dos veces la misma mercadería y mostraría faltantes que no existen.
 */

/** Un renglón de IM, tal como lo junta `vistaDeRango`. */
export interface RenglonConsolidado {
  cod_articulo: number;
  cantidad: number;
}

/** Lo mínimo que se necesita de cada presupuesto para repartir. */
export interface PedidoConsolidado {
  im_comprobante_id: string;
  im_numero: number | null;
  cod_cliente: number;
  cliente_nombre: string;
  /** null = sin revisar. Sirve para no repartirle a uno que quedó observado. */
  revision_estado: string | null;
}

export interface QuienPidio {
  im_comprobante_id: string;
  im_numero: number | null;
  cod_cliente: number;
  cliente_nombre: string;
  cantidad: number;
  revision_estado: string | null;
  /** Qué le tocaría si se reparte lo que hay en proporción a lo pedido. */
  sugerido: number;
}

export interface FilaConsolidado {
  cod_articulo: number;
  descripcion: string;
  unidad_de_medida: string | null;
  /** Kilos por bulto: dice si "30" son 30 kilos o 30 bolsas. */
  equivalencia_um: number | null;
  /** La suma de todo lo pedido en el rango, entre los pedidos que todavía no salieron. */
  pedido: number;
  /** Lo que hay en el depósito. `null` = no se pudo consultar (≠ "no hay"). */
  stock: number | null;
  /** Cuánto falta para cubrir todo lo pedido. 0 si alcanza, null si no se sabe. */
  falta: number | null;
  /** En cuántos pedidos aparece. */
  pedidos: number;
  quienes: QuienPidio[];
}

const redondear = (n: number) => Math.round(n * 100) / 100;

/**
 * Arma el consolidado a partir de los renglones que ya trajo la vista.
 *
 * No consulta nada: recibe lo que `vistaDeRango` ya pidió a InfoManager. Es CPU pura, así que
 * agregarlo no cuesta ni una llamada más.
 */
export function armarConsolidado(
  pedidos: PedidoConsolidado[],
  renglonesPorComprobante: Map<string, RenglonConsolidado[]>,
  catalogo: Map<number, { descripcion?: string; unidad_de_medida?: string | null; equivalencia_um?: number | null }>,
  stock: Map<number, number> | null,
): { articulos: FilaConsolidado[]; totales: { articulos: number; faltantes: number; sin_stock_consultado: boolean } } {
  const porArticulo = new Map<number, { pedido: number; quienes: QuienPidio[] }>();

  for (const p of pedidos) {
    const rs = renglonesPorComprobante.get(String(p.im_comprobante_id)) ?? [];
    // 🪤 El mismo artículo puede venir en DOS renglones del mismo presupuesto (el vendedor parte
    // la cantidad). Se acumula por pedido antes de listarlo, o el cliente aparecería dos veces y
    // el reparto sugerido saldría mal.
    const suyo = new Map<number, number>();
    for (const r of rs) {
      const cod = Number(r.cod_articulo);
      const cant = Number(r.cantidad);
      if (!Number.isFinite(cod) || !Number.isFinite(cant) || cant <= 0) continue;
      suyo.set(cod, (suyo.get(cod) ?? 0) + cant);
    }
    for (const [cod, cant] of suyo) {
      if (!porArticulo.has(cod)) porArticulo.set(cod, { pedido: 0, quienes: [] });
      const acc = porArticulo.get(cod)!;
      acc.pedido += cant;
      acc.quienes.push({
        im_comprobante_id: p.im_comprobante_id,
        im_numero: p.im_numero,
        cod_cliente: p.cod_cliente,
        cliente_nombre: p.cliente_nombre,
        cantidad: redondear(cant),
        revision_estado: p.revision_estado,
        sugerido: 0,     // se calcula abajo, cuando ya se sabe el total del artículo
      });
    }
  }

  const articulos: FilaConsolidado[] = [];
  for (const [cod, acc] of porArticulo) {
    const art = catalogo.get(cod);
    const hay = stock ? (stock.get(cod) ?? 0) : null;
    const pedido = redondear(acc.pedido);
    // 🪤 `falta` sólo tiene sentido si se pudo consultar el stock. Con stock negativo (pasa: hay
    // diferencias de inventario) falta TODO lo pedido, no una parte.
    const falta = hay == null ? null : redondear(Math.max(0, pedido - Math.max(0, hay)));

    /**
     * El reparto sugerido: si no alcanza, a cada uno le toca en proporción a lo que pidió.
     * Es una PROPUESTA para arrancar la conversación, no una decisión — quién se queda sin
     * mercadería lo decide la oficina, que sabe qué cliente puede esperar.
     */
    const quienes = acc.quienes
      .map(q => ({
        ...q,
        sugerido: hay == null || falta === 0 || pedido <= 0
          ? q.cantidad
          : redondear(Math.max(0, hay) * (q.cantidad / pedido)),
      }))
      .sort((a, b) => b.cantidad - a.cantidad);   // el que más pidió primero: es el que más pesa

    articulos.push({
      cod_articulo: cod,
      descripcion: art?.descripcion ?? `Artículo ${cod}`,
      unidad_de_medida: art?.unidad_de_medida ?? null,
      equivalencia_um: art?.equivalencia_um ?? null,
      pedido,
      stock: hay == null ? null : redondear(hay),
      falta,
      pedidos: quienes.length,
      quienes,
    });
  }

  // Primero lo que falta y por cuánto: es lo único que hay que resolver hoy.
  articulos.sort((a, b) => (b.falta ?? -1) - (a.falta ?? -1) || b.pedido - a.pedido);

  return {
    articulos,
    totales: {
      articulos: articulos.length,
      faltantes: articulos.filter(a => (a.falta ?? 0) > 0).length,
      sin_stock_consultado: stock == null,
    },
  };
}
