/**
 * Cómo repartir los pedidos de un día en hojas de ruta que entren en los camiones.
 *
 * Es el trabajo manual que hoy hace Jorgelina y el que más tiempo le lleva (Mati, 07/09/2026):
 * *"a veces las zonas dan mucho más kilos que un solo camión, entonces se subdivide la misma
 * zona en varios repartos para hacer que los kilos coincidan con los que soporta cada camión"*.
 *
 * Tres cosas que salen del circuito real y que el algoritmo tiene que respetar:
 *  1. **Una zona puede necesitar varias hojas.** La zona 10 el 04/09 daba 22.517 kg contra un
 *     camión máximo de 12.000.
 *  2. **Una hoja puede ser de un solo cliente.** *"por ahí un cliente pidió 12.000 kilos él
 *     solo y se lo envía en un camión sólo para él"*.
 *  3. **A veces la flota entera no alcanza** y hay que dejar pedidos para otro viaje. Eso se
 *     dice, no se esconde.
 *
 * 🔑 Es una SUGERENCIA. Quien arma la hoja mueve lo que quiera: el algoritmo no sabe que dos
 * clientes están en la misma cuadra ni que uno cierra al mediodía.
 */

export interface PedidoAReparto {
  im_comprobante_id: string;
  cod_cliente: number;
  cliente_nombre?: string | null;
  cod_zona: number | null;
  zona: string;
  kg: number;
  bultos?: number;
}

export interface CamionDisponible {
  id: string;
  nombre: string;
  capacidad_kg: number;
}

export interface RepartoSugerido {
  camion: CamionDisponible | null;
  cod_zona: number | null;
  zona: string;
  pedidos: PedidoAReparto[];
  kg: number;
  /** Qué tan lleno va. Ayuda a ver si conviene juntar dos repartos flojos. */
  ocupacion: number | null;
  /** Un solo cliente que llena un camión: no es un reparto, es un envío especial. */
  envio_especial: boolean;
}

export interface Sugerencia {
  repartos: RepartoSugerido[];
  /**
   * Los que **no entran ni en el camión más grande**. NO se descartan ni se parten solos:
   * quedan a la vista para que alguien decida (partir el pedido, contratar un flete).
   */
  sin_camion: PedidoAReparto[];
  /**
   * Cuántos viajes le tocan a cada camión si se siguiera la sugerencia tal cual. Es el dato
   * que dice si el día entra o hay que mover pedidos a mañana: 3 viajes del de 12.000 en un
   * turno no pasan.
   */
  viajes_por_camion: Array<{ camion: string; viajes: number; kg: number }>;
  total_kg: number;
  capacidad_total_kg: number;
}

const dos = (n: number) => Math.round(n * 100) / 100;

/**
 * Reparte por zona y, dentro de cada zona, mete los pedidos más pesados primero en el camión
 * más chico donde entren (first-fit decreasing). Con los pesados primero, los chicos rellenan
 * los huecos; al revés, un pedido grande se queda sin lugar aunque hubiera capacidad de sobra.
 */
export function sugerirRepartos(
  pedidos: PedidoAReparto[],
  camiones: CamionDisponible[],
): Sugerencia {
  const flota = [...camiones].sort((a, b) => a.capacidad_kg - b.capacidad_kg);
  const maxCap = flota.length ? flota[flota.length - 1].capacidad_kg : 0;
  const repartos: RepartoSugerido[] = [];
  const sinCamion: PedidoAReparto[] = [];

  // Por zona, y las zonas con más carga primero: son las que van a necesitar varios camiones,
  // y conviene que elijan antes de que la flota se agote.
  const porZona = new Map<string, PedidoAReparto[]>();
  for (const p of pedidos) {
    const k = String(p.cod_zona ?? 'sin');
    if (!porZona.has(k)) porZona.set(k, []);
    porZona.get(k)!.push(p);
  }
  const zonas = [...porZona.entries()]
    .map(([k, l]) => ({ k, l, kg: l.reduce((s, p) => s + p.kg, 0) }))
    .sort((a, b) => b.kg - a.kg);

  for (const { l } of zonas) {
    // 🪤 La flota se REINICIA en cada zona, no se va gastando. Probando con los pedidos reales
    // del 04/09 la primera versión consumía los 4 camiones en la zona 10 y dejaba 18 pedidos
    // de las otras zonas sin nada. El error de fondo era asumir que la flota se reparte una
    // sola vez para todo el día: un camión hace varios viajes y no todo sale el mismo día
    // (37.131 kg pedidos contra 31.000 de capacidad total). Lo que esto responde es "cómo
    // parto ESTA zona en viajes que entren", que es la pregunta que se hace la oficina.
    const libres = [...flota];
    const ordenados = [...l].sort((a, b) => b.kg - a.kg);
    for (const p of ordenados) {
      // Un pedido que no entra en el camión más grande necesita otra solución (partirlo,
      // un flete). Se dice, no se mete igual.
      if (p.kg > maxCap) { sinCamion.push(p); continue; }

      // ¿Entra en algún reparto ya abierto de esta misma zona?
      const cabe = repartos.find(r =>
        r.camion &&
        String(r.cod_zona ?? 'sin') === String(p.cod_zona ?? 'sin') &&
        r.kg + p.kg <= r.camion.capacidad_kg);
      if (cabe) {
        cabe.pedidos.push(p);
        cabe.kg = dos(cabe.kg + p.kg);
        continue;
      }

      // Si no, se abre uno nuevo con el camión MÁS CHICO donde entre: guardar el grande para
      // una zona pesada es lo que hace que la flota alcance.
      let i = libres.findIndex(c => c.capacidad_kg >= p.kg);
      // Sin camiones libres en esta zona, se propone OTRO VIAJE del más chico que lo aguante:
      // la flota se reutiliza, y decir "no entra" cuando en realidad hay que hacer dos viajes
      // sería falso. Sólo queda sin camión lo que no entra en el más grande, ya filtrado arriba.
      const camion = i === -1
        ? flota.find(c => c.capacidad_kg >= p.kg)!
        : libres.splice(i, 1)[0];
      repartos.push({
        camion, cod_zona: p.cod_zona, zona: p.zona,
        pedidos: [p], kg: dos(p.kg), ocupacion: null, envio_especial: false,
      });
    }
  }

  for (const r of repartos) {
    r.ocupacion = r.camion ? dos((r.kg / r.camion.capacidad_kg) * 100) : null;
    // Un solo cliente ocupando casi todo el camión: es un envío especial, no un reparto.
    // Se marca para que en la pantalla no parezca una hoja a medio llenar.
    r.envio_especial = r.pedidos.length === 1 && (r.ocupacion ?? 0) >= 70;
    r.pedidos.sort((a, b) => b.kg - a.kg);
  }

  const porCamion = new Map<string, { camion: string; viajes: number; kg: number }>();
  for (const r of repartos) {
    if (!r.camion) continue;
    const v = porCamion.get(r.camion.id) ?? { camion: r.camion.nombre, viajes: 0, kg: 0 };
    v.viajes += 1; v.kg = dos(v.kg + r.kg);
    porCamion.set(r.camion.id, v);
  }

  return {
    repartos,
    sin_camion: sinCamion,
    viajes_por_camion: [...porCamion.values()].sort((a, b) => b.viajes - a.viajes),
    total_kg: dos(pedidos.reduce((s, p) => s + p.kg, 0)),
    capacidad_total_kg: dos(flota.reduce((s, c) => s + c.capacidad_kg, 0)),
  };
}
