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
 * 🔑 Se suma lo que **todavía no salió del depósito**, que es lo único que compite por el stock
 * que queda. Lo que ya tiene remito emitido descontó stock en InfoManager: contarlo otra vez
 * restaría dos veces la misma mercadería.
 *
 * 🔄 El filtro ANTES era "no está en una hoja ni en retiro", y fallaba para los dos lados
 * (auditoría del 08/09/2026):
 *  · La hoja se arma DESPUÉS de facturar. En toda esa ventana el presupuesto facturado seguía
 *    contando —y su remito ya había descontado stock—, así que el faltante salía al doble.
 *  · Un retiro marcado ANTES de facturar (flujo soportado: la pantalla lo muestra como "sin
 *    facturar") desaparecía del consolidado con su mercadería sin descontar, y esa demanda
 *    invisible hacía que se le prometiera a otro lo que estaba apartado.
 * Lo que decide es `im_remito_numero`, que es el hecho real: la mercadería salió o no salió.
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
  /** null = sin revisar. Se muestra al lado de cada uno para decidir a quién postergar. */
  revision_estado: string | null;
  /**
   * 🔑 Su mercadería YA SALIÓ del depósito (tiene remito emitido), así que ya está descontada
   * del stock y no compite por lo que queda.
   */
  ya_salio: boolean;
  /**
   * El control de cantidades marcó algo raro en este pedido (típico: cargaron kilos donde van
   * bultos, "30 × MAIZ X 30 KG" = 900 kg). Un renglón así envenena la suma del artículo, así que
   * se avisa donde se toma la decisión.
   */
  cantidad_dudosa?: boolean;
}

export interface QuienPidio {
  im_comprobante_id: string;
  im_numero: number | null;
  cod_cliente: number;
  cliente_nombre: string;
  cantidad: number;
  revision_estado: string | null;
  /** Ver `PedidoConsolidado.cantidad_dudosa`: esta cantidad puede estar mal cargada. */
  cantidad_dudosa: boolean;
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
): {
  articulos: FilaConsolidado[];
  totales: {
    articulos: number; faltantes: number; sin_stock_consultado: boolean;
    sin_renglones: number; con_cantidad_dudosa: number;
  };
} {
  const porArticulo = new Map<number, { pedido: number; quienes: QuienPidio[] }>();
  /**
   * 🔴 Cuántos pedidos quedaron sin renglones. No es cosmético: `vistaDeRango` sólo trae los
   * renglones de los últimos 12 días con pedidos (23,7 s para 15 días contra IM) y acepta rangos
   * de hasta 31, y además se traga con un warn el error de un día entero. Un pedido sin renglones
   * suma CERO al consolidado sin ninguna señal — y los que se caen son los más viejos, o sea el
   * arrastre. Hay que decir que el número está incompleto. Auditoría del 08/09/2026.
   */
  let sinRenglones = 0;

  for (const p of pedidos) {
    // Lo que ya salió del depósito no compite por el stock que queda: ya está descontado.
    if (p.ya_salio) continue;
    const rs = renglonesPorComprobante.get(String(p.im_comprobante_id));
    if (!rs?.length) { sinRenglones += 1; continue; }
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
        cantidad_dudosa: p.cantidad_dudosa === true,
        sugerido: 0,     // se calcula abajo, cuando ya se sabe el total del artículo
      });
    }
  }

  const articulos: FilaConsolidado[] = [];
  for (const [cod, acc] of porArticulo) {
    const art = catalogo.get(cod);
    /**
     * 🪤 `stock.get(cod) ?? 0` decía "no hay ni uno" cuando en realidad IM **no nombró** ese
     * artículo: `/depositos/stock_por_deposito` devuelve ~563 filas contra 1.856 artículos
     * habilitados. El artículo quedaba con falta = todo lo pedido y, como la lista se ordena
     * por faltante y arranca filtrada en "sólo lo que no alcanza", era lo PRIMERO que se veía.
     * El resto del panel ya hacía lo correcto (`panelPresupuestos.ts`, `vistaPresupuestos.ts`):
     * sin dato se muestra "—", no un cero. Auditoría del 08/09/2026.
     */
    const hay = stock ? (stock.get(cod) ?? null) : null;
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
      /** Pedidos cuyos renglones no se pudieron traer: el total está incompleto por abajo. */
      sin_renglones: sinRenglones,
      /** Pedidos con una cantidad sospechosa: pueden estar inflando el total de su artículo. */
      con_cantidad_dudosa: pedidos.filter(p => !p.ya_salio && p.cantidad_dudosa).length,
    },
  };
}
